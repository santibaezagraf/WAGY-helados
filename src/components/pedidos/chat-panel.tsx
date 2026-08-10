"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createClient } from "@/lib/supabase-client"
import { Send, Bot, User, Loader2, AlertCircle, FileText, MapPin, Download, Pencil, ClipboardCheck, Ban, ShieldCheck, ShieldAlert, RotateCcw, CheckCircle2, ArrowLeft, ChevronDown } from "lucide-react"
import { etiquetaFecha, mismoDia } from "@/lib/fecha-chat"
import { formatearHoraAR } from "@/lib/zona-horaria"
import {
  getDatosChat,
  getMensajesAntiguos,
  getPedidoActivoChat,
  getEstadoRateLimit,
  bloquearNumeroAccion,
  desbloquearNumeroAccion,
  resetearRateLimitAccion,
  enviarMensajeManualAccion,
  enviarResumenManualAccion,
  finalizarAtencion,
  firmarMedia,
  marcarAtendido,
  type MensajeChat,
} from "@/lib/actions/mensajes"
import { EditOrderModal } from "@/components/pedidos/edit-order-modal"
import type { Pedido } from "@/types/pedidos"
import { setChatAbierto, setTomaActiva } from "@/lib/chat-abierto-store"

export interface ChatPanelProps {
  /** El chat es por teléfono; el pedido es opcional (puede abrirse sin pedido). */
  telefono: string
  pedidoId?: number
  /** Si es false, el panel no carga historial ni se suscribe (útil cuando está
   *  oculto/desmontado lógicamente). Default true. */
  activo?: boolean
  /** Si se pasa, muestra una flecha de "volver" en el encabezado (para el layout
   *  de dos paneles en mobile). En el modal no se usa (cierra con la X del Dialog). */
  onVolver?: () => void
  /** True cuando el panel se renderiza dentro de `ChatModal`: la X de cerrar del
   *  Dialog es `absolute right-4 top-4` sobre el propio contenido (DialogContent
   *  va con `p-0`), así que sin este margen los botones "Editar"/"Enviar resumen"
   *  del panel del pedido (que se empujan al extremo derecho con `ml-auto`)
   *  quedan tapados/superpuestos por la X. La vista inline de /conversaciones no
   *  tiene esa X, así que no reserva el espacio. Default false. */
  enModal?: boolean
}

const esOutbound = (rol: string) => rol === "bot" || rol === "operador"

// Ventana de mensajería libre de Meta: solo se puede escribirle al cliente
// dentro de las 24h desde su último mensaje entrante.
const VENTANA_24H_MS = 24 * 60 * 60 * 1000

function horaCorta(iso: string): string {
  return formatearHoraAR(new Date(iso))
}

const ETIQUETA_ESTADO: Record<string, string> = {
  borrador: "Borrador",
  pendiente: "En cocina",
  esperando_cancelacion: "Esperando cancelación",
}

// Mismo criterio de completitud que usa el bot para mandar el resumen
// (esBorradorCompleto): '' es el placeholder de "dato no cargado".
const pedidoCompletoParaResumen = (p: Pedido) =>
  Boolean(p.direccion && p.metodo_pago && (p.cantidad_agua > 0 || p.cantidad_crema > 0))

// Render del cuerpo de una burbuja según el tipo de mensaje. Texto se muestra
// como siempre; los media usan la URL firmada (media_url) que arma el server.
function CuerpoMensaje({ m }: { m: MensajeChat }) {
  const caption = m.media_caption ? (
    <span className="block whitespace-pre-wrap break-words mt-1">{m.media_caption}</span>
  ) : null

  // Media sin URL: la descarga falló o todavía no se firmó.
  const noDisponible = (
    <span className="flex items-center gap-1 text-slate-500 italic">
      <FileText className="h-3.5 w-3.5" /> Archivo no disponible
    </span>
  )

  switch (m.tipo) {
    case "image":
    case "sticker":
      return m.media_url ? (
        <>
          <img src={m.media_url} alt={m.media_caption ?? "imagen"} className="rounded-md max-h-60 w-auto" />
          {caption}
        </>
      ) : (
        noDisponible
      )

    case "audio": {
      const transcripcion = m.texto ? (
        <span className="block whitespace-pre-wrap break-words mt-1 italic text-slate-600 dark:text-slate-400">
          🎤 {m.texto}
        </span>
      ) : null
      return m.media_url ? (
        <>
          <audio controls src={m.media_url} className="max-w-full" />
          {transcripcion}
        </>
      ) : (
        <>
          {noDisponible}
          {transcripcion}
        </>
      )
    }

    case "video":
      return m.media_url ? (
        <>
          <video controls src={m.media_url} className="rounded-md max-h-60 w-auto" />
          {caption}
        </>
      ) : (
        noDisponible
      )

    case "document":
      return m.media_url ? (
        <>
          <a
            href={m.media_url}
            target="_blank"
            rel="noopener noreferrer"
            download={m.media_filename ?? undefined}
            className="flex items-center gap-2 underline text-slate-700"
          >
            <Download className="h-4 w-4 shrink-0" />
            <span className="break-all">{m.media_filename ?? "Documento"}</span>
          </a>
          {caption}
        </>
      ) : (
        noDisponible
      )

    case "location": {
      const maps =
        m.media_lat != null && m.media_lng != null
          ? `https://www.google.com/maps?q=${m.media_lat},${m.media_lng}`
          : null
      const contenido = (
        <span className="flex items-center gap-1.5 text-slate-700">
          <MapPin className="h-4 w-4 shrink-0 text-red-500" />
          {m.texto || "Ubicación"}
        </span>
      )
      return maps ? (
        <a href={maps} target="_blank" rel="noopener noreferrer" className="underline">
          {contenido}
        </a>
      ) : (
        contenido
      )
    }

    default:
      return <span>{m.texto}</span>
  }
}

/**
 * Cuerpo del chat manual (historial + Realtime + envío + moderación + panel del
 * pedido vigente). Se renderiza inline (llena el alto del contenedor: flex-col
 * con la lista de mensajes en flex-1). Lo usan el `ChatModal` (dentro de un
 * Dialog) y la vista `/conversaciones` (panel derecho estilo WhatsApp Web).
 */
export function ChatPanel({ telefono, pedidoId, activo = true, onVolver, enModal = false }: ChatPanelProps) {
  const [mensajes, setMensajes] = React.useState<MensajeChat[]>([])
  const [cargando, setCargando] = React.useState(false)
  const [texto, setTexto] = React.useState("")
  const [enviando, setEnviando] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [atencionActiva, setAtencionActiva] = React.useState(false)
  // Moderación manual del número: bloqueo persistente + reset del rate-limit.
  const [bloqueado, setBloqueado] = React.useState(false)
  const [moderando, setModerando] = React.useState(false)
  // Estado EN VIVO del rate-limit anti-DoS (no el flag "no visto" de
  // atencion_humana, que se limpia al abrir el chat — ver comentario en
  // getEstadoRateLimit). Se re-consulta con cada mensaje entrante y con el
  // mismo tick de 1' que re-evalúa la ventana de 24h, así el banner desaparece
  // solo cuando el cliente deja de estar limitado de verdad.
  const [enRateLimit, setEnRateLimit] = React.useState(false)
  const [aviso, setAviso] = React.useState<string | null>(null)
  // Pedido vigente (borrador/cocina/esperando_cancelacion) del teléfono, para
  // el panel de acceso rápido: editarlo o mandarle el resumen de confirmación.
  const [pedidoActivo, setPedidoActivo] = React.useState<Pedido | null>(null)
  const [editandoPedido, setEditandoPedido] = React.useState(false)
  const [enviandoResumen, setEnviandoResumen] = React.useState(false)
  // Tick para que la ventana de 24h se cierre sola en la UI aunque no llegue
  // un mensaje nuevo (re-evalúa `ventanaAbierta` cada minuto mientras está activo).
  const [ahora, setAhora] = React.useState<number>(() => Date.now())
  // Paginación del historial: hay mensajes más viejos por cargar / cargando ahora.
  const [hayMas, setHayMas] = React.useState(false)
  const [cargandoMas, setCargandoMas] = React.useState(false)
  // "Pegado al fondo": mientras sea true, cualquier cambio de altura del
  // contenedor (mensajes nuevos, imágenes que cargan tarde) vuelve a poner la
  // vista al fondo. El operador lo desactiva scrolleando hacia arriba. Alimenta:
  //  - el fix del scroll inicial (asegura llegar al fondo aunque las imágenes
  //    lleguen después),
  //  - el botón flotante "bajar al fondo" (aparece cuando no está pegado).
  const [pegadoAlFondo, setPegadoAlFondo] = React.useState(true)

  const finRef = React.useRef<HTMLDivElement | null>(null)
  const listaRef = React.useRef<HTMLDivElement | null>(null)
  // Ancla para prepend al cargar viejos: restauramos la posición para que la
  // vista no salte cuando el alto crece por arriba.
  const anclaScrollRef = React.useRef<{ prepend: boolean; prevHeight: number }>({
    prepend: false,
    prevHeight: 0,
  })
  // Umbral (px) para considerar "estoy en el fondo": chico para no confundir
  // con un scroll intencional del operador, pero > 0 porque el navegador puede
  // reportar un scrollTop no exactamente en el máximo.
  const UMBRAL_FONDO = 40

  // Timestamp del último mensaje ENTRANTE del cliente (lo que abre la ventana).
  const ultimoClienteMs = React.useMemo(() => {
    let max = 0
    for (const m of mensajes) {
      if (m.rol === "cliente") {
        const t = new Date(m.created_at).getTime()
        if (t > max) max = t
      }
    }
    return max || null
  }, [mensajes])

  const ventanaAbierta = ultimoClienteMs !== null && ahora - ultimoClienteMs < VENTANA_24H_MS

  // Append idempotente: evita duplicar si una fila llega por Realtime más de una vez.
  const agregarMensaje = React.useCallback((m: MensajeChat) => {
    setMensajes((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
  }, [])

  // Re-lee el pedido vigente. Lo usan varios efectos (Realtime de pedidos,
  // fallback por mensajes rol='bot') y handlers (post-edición, post-resumen),
  // por eso vive acá arriba, antes de los useEffect que lo dependen.
  const refrescarPedido = React.useCallback(() => {
    getPedidoActivoChat(telefono)
      .then(setPedidoActivo)
      .catch(() => {})
  }, [telefono])

  // Carga inicial del historial + estado de la toma humana al activarse.
  React.useEffect(() => {
    if (!activo) return
    let cancelado = false

    setCargando(true)
    setError(null)
    setAviso(null)
    // Nuevo chat abierto: partimos pegados al fondo por defecto. El auto-scroll
    // del useLayoutEffect + ResizeObserver hará el resto cuando lleguen datos.
    setPegadoAlFondo(true)
    // Abrir el chat cuenta como "ya lo vi": limpiamos el aviso de requiere_atencion.
    marcarAtendido(telefono).catch(() => {})
    // Una sola llamada trae historial + toma humana + pedido vigente + bloqueo
    // (autentica una vez, lee las 4 cosas en paralelo server-side).
    getDatosChat(telefono)
      .then(({ historial, hayMasHistorial, atencionActiva, pedido, bloqueado, enRateLimit }) => {
        if (cancelado) return
        setMensajes(historial)
        setHayMas(hayMasHistorial)
        setAtencionActiva(atencionActiva)
        setPedidoActivo(pedido)
        setBloqueado(bloqueado)
        setEnRateLimit(enRateLimit)
      })
      .catch((e) => {
        if (!cancelado) setError(e instanceof Error ? e.message : "No se pudo cargar el chat")
      })
      .finally(() => {
        if (!cancelado) setCargando(false)
      })

    return () => {
      cancelado = true
    }
  }, [activo, telefono])

  // Suscripción Realtime a los INSERT de mensajes_chat de este teléfono.
  React.useEffect(() => {
    if (!activo) return

    const supabase = createClient()
    const channel = supabase
      .channel(`chat-${telefono}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensajes_chat", filter: `telefono=eq.${telefono}` },
        async (payload) => {
          // El payload de Realtime trae la fila cruda (con media_path, no una URL
          // accesible). Para filas de media resolvemos la URL firmada server-side.
          const fila = payload.new as {
            id: string
            rol: string
            texto: string | null
            created_at: string
            tipo?: string
            media_path?: string | null
            media_mime?: string | null
            media_caption?: string | null
            media_filename?: string | null
            media_lat?: number | null
            media_lng?: number | null
          }
          const media_url = fila.media_path ? await firmarMedia(fila.media_path) : null
          agregarMensaje({
            id: fila.id,
            rol: fila.rol,
            texto: fila.texto,
            created_at: fila.created_at,
            tipo: fila.tipo ?? "text",
            media_url,
            media_mime: fila.media_mime ?? null,
            media_caption: fila.media_caption ?? null,
            media_filename: fila.media_filename ?? null,
            media_lat: fila.media_lat ?? null,
            media_lng: fila.media_lng ?? null,
          })
          // Si el chat está abierto y llega un mensaje del cliente, el operador
          // ya lo está viendo: limpiamos el flag `requiere_atencion` (que el
          // webhook prende ante cada mensaje entrante con toma humana activa) y
          // de paso mandamos el read-receipt a Meta. Sin esto, el propio chat
          // que estás mirando aparecería resaltado como "no leído" al listado.
          if (fila.rol === "cliente") {
            marcarAtendido(telefono).catch(() => {})
            // Un mensaje nuevo del cliente es el momento en que más importa
            // saber si acaba de cruzar el límite (el webhook lo frena justo en
            // ese instante) — no esperamos al tick de 1'.
            getEstadoRateLimit(telefono).then(setEnRateLimit).catch(() => {})
          }
          // Fallback para refrescar el panel del pedido cuando la migración
          // que suma `pedidos` a la publicación de Realtime todavía no está
          // aplicada: un mensaje del bot suele ser la señal indirecta de que
          // acaba de escribir/modificar el pedido. Es una query barata
          // (maybeSingle con filtros) y redundante con la suscripción directa a
          // `pedidos` de más abajo cuando esa migración sí está aplicada.
          if (fila.rol === "bot") refrescarPedido()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [activo, telefono, agregarMensaje, refrescarPedido])

  // Suscripción Realtime a `pedidos` filtrada por teléfono: cualquier
  // INSERT/UPDATE/DELETE del pedido de este cliente refresca el panel del pedido
  // (info + botones Editar/Enviar resumen en el header verde). Sin esto, el
  // panel quedaba pegado a la foto tomada al abrir el chat: un cliente podía
  // completar el pedido en vivo y hasta recargar la página no se veía. Requiere
  // que la migración 20260723120000 (pedidos → publication supabase_realtime)
  // esté aplicada; mientras tanto, el fallback por mensajes rol='bot' de más
  // arriba cubre el caso más común (bot procesó y escribió el pedido).
  React.useEffect(() => {
    if (!activo) return
    const supabase = createClient()
    const canalPedidos = supabase
      .channel(`chat-pedidos-${telefono}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pedidos", filter: `telefono=eq.${telefono}` },
        () => refrescarPedido(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(canalPedidos)
    }
  }, [activo, telefono, refrescarPedido])

  // Re-evalúa la ventana de 24h y el rate-limit cada minuto mientras el panel
  // está activo. El rate-limit importa acá porque su conteo es una ventana
  // deslizante: aunque el cliente no vuelva a escribir, el banner debe poder
  // apagarse solo cuando esos mensajes viejos salen de la ventana de 1h.
  React.useEffect(() => {
    if (!activo) return
    const t = setInterval(() => {
      setAhora(Date.now())
      getEstadoRateLimit(telefono).then(setEnRateLimit).catch(() => {})
    }, 60_000)
    return () => clearInterval(t)
  }, [activo, telefono])

  // Marca este teléfono como "chat abierto" mientras el panel está activo. Lo lee
  // el componente de notificaciones para NO disparar un toast por un mensaje que
  // ya estás mirando en vivo. La limpieza cubre el cierre y el desmontaje.
  React.useEffect(() => {
    if (!activo) return
    setChatAbierto(telefono)
    return () => {
      setChatAbierto(null)
    }
  }, [activo, telefono])

  // Scroll tras cambiar `mensajes`:
  //  - si venimos de prependear (cargar más viejos) restauramos la posición para
  //    que la vista no salte (el alto creció por arriba);
  //  - si no y estamos pegados al fondo (carga inicial / mensaje nuevo) bajamos
  //    al fondo de forma INSTANTÁNEA (no smooth): con smooth y sobre un
  //    contenedor cuya altura aún puede crecer (imágenes cargando), el scroll
  //    quedaba a mitad de camino y el operador tenía que bajar a mano.
  // useLayoutEffect: corre antes del paint → sin parpadeo.
  React.useLayoutEffect(() => {
    const cont = listaRef.current
    if (!cont) return
    if (anclaScrollRef.current.prepend) {
      cont.scrollTop = cont.scrollHeight - anclaScrollRef.current.prevHeight
      anclaScrollRef.current.prepend = false
    } else if (pegadoAlFondo) {
      cont.scrollTop = cont.scrollHeight
    }
  }, [mensajes, pegadoAlFondo])

  // ResizeObserver: mientras estemos pegados al fondo, cualquier cambio de alto
  // del contenido (imágenes/audios/videos que resuelven después del render)
  // vuelve a pegar la vista al fondo. Sin esto, el efecto de arriba corre solo
  // al cambiar `mensajes` y una imagen que carga tarde quedaba "empujando" el
  // scroll hacia el medio — la causa del bug de abrir el chat sin llegar al final.
  React.useEffect(() => {
    if (!activo) return
    const cont = listaRef.current
    if (!cont) return
    const observer = new ResizeObserver(() => {
      if (pegadoAlFondo) cont.scrollTop = cont.scrollHeight
    })
    observer.observe(cont)
    // Observamos también el hijo interno (cuyo alto crece al cargar imágenes) —
    // sin esto, ResizeObserver del contenedor no se dispara porque el
    // contenedor mide igual (el que crece por dentro es su contenido).
    if (cont.firstElementChild) observer.observe(cont.firstElementChild)
    return () => observer.disconnect()
  }, [activo, pegadoAlFondo])

  // Cargar la tanda anterior de mensajes (cursor = el más viejo que tenemos) y
  // prependearla, preservando la posición de scroll.
  const cargarMas = React.useCallback(async () => {
    if (cargandoMas || !hayMas) return
    const cursor = mensajes[0]?.created_at
    if (!cursor) return
    setCargandoMas(true)
    const cont = listaRef.current
    anclaScrollRef.current = { prepend: true, prevHeight: cont?.scrollHeight ?? 0 }
    try {
      const { mensajes: viejos, hayMas: mas } = await getMensajesAntiguos(telefono, cursor)
      setMensajes((prev) => {
        const ids = new Set(prev.map((m) => m.id))
        return [...viejos.filter((m) => !ids.has(m.id)), ...prev]
      })
      setHayMas(mas)
    } catch {
      anclaScrollRef.current.prepend = false // no restauramos si falló
    } finally {
      setCargandoMas(false)
    }
  }, [cargandoMas, hayMas, mensajes, telefono])

  // onScroll cumple dos funciones:
  //  1) dispara "cargar más" cuando el operador se acerca al tope,
  //  2) actualiza `pegadoAlFondo` según la distancia al final, que a su vez
  //     controla el auto-scroll y la visibilidad del botón flotante.
  const onScroll = React.useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      if (el.scrollTop < 80 && hayMas && !cargandoMas) cargarMas()
      const distanciaAlFondo = el.scrollHeight - el.scrollTop - el.clientHeight
      setPegadoAlFondo(distanciaAlFondo < UMBRAL_FONDO)
    },
    [hayMas, cargandoMas, cargarMas],
  )

  // Botón flotante "bajar al fondo": vuelve a pegar la vista y activa el pegado.
  const irAlFondo = React.useCallback(() => {
    const cont = listaRef.current
    if (!cont) return
    cont.scrollTop = cont.scrollHeight
    setPegadoAlFondo(true)
  }, [])

  const handleEnviar = React.useCallback(async () => {
    const limpio = texto.trim()
    if (!limpio || enviando || !ventanaAbierta) return

    setEnviando(true)
    setError(null)
    try {
      const { ok, mensaje } = await enviarMensajeManualAccion(telefono, limpio)
      if (ok) {
        setTexto("")
        setAtencionActiva(true) // el envío activa la toma humana
        // También lo empujamos al store client-side para que las notificaciones
        // sepan de la toma sin depender del round-trip Realtime de atencion_humana.
        setTomaActiva(telefono, true)
        // Agregamos la burbuja con la fila ya persistida (dedup por id por si
        // Realtime también trae el eco). No dependemos de que Realtime devuelva
        // el insert propio del operador.
        if (mensaje) agregarMensaje(mensaje)
      } else {
        setError(
          "No se pudo enviar. Puede que hayan pasado más de 24 h desde el último mensaje del cliente (límite de WhatsApp).",
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al enviar el mensaje")
    } finally {
      setEnviando(false)
    }
  }, [texto, enviando, ventanaAbierta, telefono, agregarMensaje])

  const handleEnviarResumen = React.useCallback(async () => {
    if (!pedidoActivo || enviandoResumen || !ventanaAbierta) return
    setEnviandoResumen(true)
    setError(null)
    try {
      const { ok, motivo } = await enviarResumenManualAccion(pedidoActivo.id, telefono)
      if (ok) {
        // El resumen salió y el control volvió al bot (la burbuja llega por
        // Realtime; la toma humana se desactivó server-side).
        setAtencionActiva(false)
        setTomaActiva(telefono, false)
      } else {
        setError(motivo ?? "No se pudo enviar el resumen.")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo enviar el resumen.")
    } finally {
      setEnviandoResumen(false)
      refrescarPedido()
    }
  }, [pedidoActivo, enviandoResumen, ventanaAbierta, telefono, refrescarPedido])

  const handleDevolverAlBot = React.useCallback(async () => {
    try {
      await finalizarAtencion(telefono)
      setAtencionActiva(false)
      setTomaActiva(telefono, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo devolver al bot")
    }
  }, [telefono])

  // Bloquear / desbloquear el número (el bot lo ignora por completo mientras
  // esté bloqueado; el operador igual puede escribirle a mano).
  const handleToggleBloqueo = React.useCallback(async () => {
    if (moderando) return
    setModerando(true)
    setError(null)
    setAviso(null)
    try {
      if (bloqueado) {
        await desbloquearNumeroAccion(telefono)
        setBloqueado(false)
        setAviso("Número desbloqueado — el bot vuelve a responderle.")
      } else {
        await bloquearNumeroAccion(telefono)
        setBloqueado(true)
        setAviso("Número bloqueado — el bot lo ignora hasta que lo desbloquees.")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cambiar el bloqueo")
    } finally {
      setModerando(false)
    }
  }, [bloqueado, moderando, telefono])

  // Resetear el rate-limit anti-DoS: un cliente legítimo que quedó frenado por
  // mandar muchos mensajes vuelve a poder escribirle al bot al instante.
  const handleResetLimite = React.useCallback(async () => {
    if (moderando) return
    setModerando(true)
    setError(null)
    setAviso(null)
    try {
      await resetearRateLimitAccion(telefono)
      setEnRateLimit(false)
      setAviso("Límite reseteado — el cliente puede volver a escribirle al bot.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo resetear el límite")
    } finally {
      setModerando(false)
    }
  }, [moderando, telefono])

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-hidden bg-white">
      {/* Encabezado estilo WhatsApp: número a la izquierda; el pedido vigente
          (info + editar + enviar resumen) al extremo derecho. `flex-wrap` hace
          que en anchos chicos (modal) el bloque del pedido baje a una segunda
          línea en vez de desbordar. */}
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 bg-[#075E54] py-2 pl-4 text-white ${
          enModal ? "pr-11" : "pr-4"
        }`}
      >
        {onVolver && (
          <button
            type="button"
            onClick={onVolver}
            className="-ml-1 shrink-0 rounded p-1 hover:bg-white/15 md:hidden"
            aria-label="Volver a la lista"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{telefono}</div>
          {pedidoId != null && <span className="text-xs text-white/80">Pedido #{pedidoId}</span>}
        </div>

        {/* Panel del pedido vigente: acceso rápido a editarlo y a mandar el
            resumen con botones de confirmación (devuelve el control al bot).
            Pensado para cuando la extracción de la IA falló o hay que cargar un
            precio especial (promo) que la lista no contempla. */}
        {pedidoActivo && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="hidden text-right text-[11px] leading-tight text-white/85 sm:block">
              <div className="font-semibold">
                Pedido #{pedidoActivo.id}
                <span className="mx-1 text-white/50">·</span>
                {ETIQUETA_ESTADO[pedidoActivo.estado] ?? pedidoActivo.estado}
              </div>
              <div className="text-white/70">
                {[
                  pedidoActivo.cantidad_agua > 0 ? `${pedidoActivo.cantidad_agua} agua` : null,
                  pedidoActivo.cantidad_crema > 0 ? `${pedidoActivo.cantidad_crema} crema` : null,
                ]
                  .filter(Boolean)
                  .join(" + ") || "sin cantidades"}
                {" · "}
                {pedidoActivo.precio_total != null ? `$${pedidoActivo.precio_total}` : "total a confirmar"}
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => setEditandoPedido(true)}
              className="h-7 gap-1 border border-white/25 bg-white/10 px-2 text-xs text-white hover:bg-white/20"
            >
              <Pencil className="h-3 w-3" /> Editar
            </Button>
            <Button
              size="sm"
              onClick={handleEnviarResumen}
              disabled={enviandoResumen || !ventanaAbierta || !pedidoCompletoParaResumen(pedidoActivo)}
              className="h-7 gap-1 border border-white/25 bg-white/10 px-2 text-xs text-white hover:bg-white/20 disabled:opacity-50"
              title={
                !pedidoCompletoParaResumen(pedidoActivo)
                  ? "Al pedido le faltan datos (cantidades, dirección o pago)"
                  : !ventanaAbierta
                    ? "Fuera de la ventana de 24 h de WhatsApp"
                    : "Manda el resumen con botones de confirmación y devuelve el control al bot"
              }
            >
              {enviandoResumen ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardCheck className="h-3 w-3" />}
              <span className="hidden sm:inline">Enviar resumen</span>
              <span className="sm:hidden">Resumen</span>
            </Button>
          </div>
        )}
      </div>

      {/* Barra de moderación: bloquear/desbloquear el número y resetear el
          rate-limit anti-DoS. El bloqueo afecta SOLO al bot (el operador puede
          seguir escribiendo a mano). Mientras el cliente esté REALMENTE
          frenado por el anti-DoS (`enRateLimit`, recalculado en vivo — no el
          aviso "no visto" de atencion_humana, que se apaga con solo abrir el
          chat) la barra se pone naranja con el aviso, así queda visible de
          forma constante incluso si el chat ya estaba abierto cuando el
          cliente se pasó del límite. Los mismos 2 botones siguen ahí siempre. */}
      <div
        className={`flex items-center justify-between gap-2 border-b px-4 py-1.5 ${
          enRateLimit ? "bg-orange-50 border-orange-200" : "bg-slate-50"
        }`}
      >
        <span
          className={`flex items-center gap-1.5 text-[11px] ${
            enRateLimit ? "font-medium text-orange-800" : "text-slate-400"
          }`}
        >
          {enRateLimit ? (
            <>
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              Superó el límite de mensajes por hora — el bot está pausado para este cliente
            </>
          ) : bloqueado ? (
            "🚫 Bloqueado — el bot no le responde"
          ) : (
            "Moderación"
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={`h-6 gap-1 px-2 text-[11px] ${
              enRateLimit ? "text-orange-800 hover:text-orange-900" : "text-slate-500 hover:text-slate-700"
            }`}
            onClick={handleResetLimite}
            disabled={moderando}
            title="Resetear el límite anti-spam: el cliente vuelve a poder escribirle al bot de inmediato (sin esperar 1 h)"
          >
            <RotateCcw className="h-3 w-3" /> Resetear límite
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`h-6 gap-1 px-2 text-[11px] ${
              bloqueado
                ? "text-emerald-700 hover:text-emerald-800"
                : "text-red-600 hover:text-red-700"
            }`}
            onClick={handleToggleBloqueo}
            disabled={moderando}
            title={
              bloqueado
                ? "Quitar el bloqueo: el bot vuelve a responderle"
                : "Bloquear: el bot ignora por completo a este número (0 tokens, sin respuesta)"
            }
          >
            {moderando ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : bloqueado ? (
              <ShieldCheck className="h-3 w-3" />
            ) : (
              <Ban className="h-3 w-3" />
            )}{" "}
            {bloqueado ? "Desbloquear" : "Bloquear"}
          </Button>
        </div>
      </div>

      {/* Banner de toma humana */}
      {atencionActiva && (
        <div className="flex items-center justify-between gap-2 bg-amber-50 border-b border-amber-200 px-4 py-2">
          <span className="text-xs text-amber-800 flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
            Atención humana activa — cerrar el chat NO devuelve al bot
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-100"
            onClick={handleDevolverAlBot}
          >
            Devolver al bot
          </Button>
        </div>
      )}

      {/* Cuerpo del chat (flex-1: llena el espacio disponible). onScroll dispara
          la carga de mensajes más viejos al llegar cerca del tope y actualiza
          `pegadoAlFondo`. El wrapper `relative` posiciona el botón flotante. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listaRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-3 py-3 bg-[#ECE5DD] space-y-2"
        >
          {cargando ? (
            <div className="flex h-full items-center justify-center text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Cargando conversación…
            </div>
          ) : mensajes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-slate-500 text-sm">
              No hay mensajes con este cliente.
            </div>
          ) : (
            <>
              {/* Indicador de carga de mensajes más viejos (al scrollear al tope). */}
              {cargandoMas && (
                <div className="flex items-center justify-center gap-1.5 py-1 text-[11px] text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando mensajes anteriores…
                </div>
              )}
              {mensajes.map((m, i) => {
                const out = esOutbound(m.rol)
                const anterior = i > 0 ? mensajes[i - 1] : null
                // Separador de día (estilo WhatsApp): antes del primer mensaje
                // y cada vez que cambia el día respecto del mensaje previo.
                const mostrarSeparador = !anterior || !mismoDia(anterior.created_at, m.created_at)
                return (
                  <React.Fragment key={m.id}>
                    {mostrarSeparador && (
                      <div className="flex justify-center py-1.5">
                        <span className="rounded-md bg-white/85 px-2.5 py-0.5 text-[11px] font-medium text-slate-600 shadow-sm">
                          {etiquetaFecha(m.created_at)}
                        </span>
                      </div>
                    )}
                    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[78%] rounded-lg px-3 py-1.5 shadow-sm text-sm whitespace-pre-wrap break-words ${
                          out ? "bg-[#DCF8C6] text-slate-800" : "bg-white text-slate-800"
                        }`}
                      >
                        {out && (
                          <span className="flex items-center gap-1 text-[10px] font-medium text-slate-500 mb-0.5">
                            {m.rol === "operador" ? (
                              <>
                                <User className="h-3 w-3" /> Operador
                              </>
                            ) : (
                              <>
                                <Bot className="h-3 w-3" /> Bot
                              </>
                            )}
                          </span>
                        )}
                        <CuerpoMensaje m={m} />
                        <span className="block text-right text-[10px] text-slate-400 mt-0.5">
                          {horaCorta(m.created_at)}
                        </span>
                      </div>
                    </div>
                  </React.Fragment>
                )
              })}
            </>
          )}
          <div ref={finRef} />
        </div>

        {/* Botón flotante "bajar al fondo": aparece cuando el operador scrolleó
            hacia arriba. Al clickear, vuelve a pegar la vista al fondo. */}
        {!pegadoAlFondo && !cargando && (
          <button
            type="button"
            onClick={irAlFondo}
            aria-label="Bajar al final de la conversación"
            className="absolute bottom-3 left-3 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-md transition hover:bg-slate-50 hover:text-slate-800"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 bg-red-50 border-t border-red-200 px-4 py-2 text-xs text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Aviso de acción de moderación exitosa */}
      {aviso && (
        <div className="flex items-start gap-2 bg-emerald-50 border-t border-emerald-200 px-4 py-2 text-xs text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{aviso}</span>
        </div>
      )}

      {/* Aviso de ventana de 24h cerrada */}
      {!cargando && !ventanaAbierta && (
        <div className="flex items-start gap-2 bg-slate-100 border-t px-4 py-2 text-xs text-slate-600">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Pasaron más de 24 h desde el último mensaje del cliente. No podés escribirle
            hasta que él vuelva a escribir (límite de WhatsApp).
          </span>
        </div>
      )}

      {/* Composer */}
      <div className="flex items-center gap-2 border-t bg-white px-3 py-2">
        <Input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              handleEnviar()
            }
          }}
          placeholder={ventanaAbierta ? "Escribí un mensaje…" : "Fuera de la ventana de 24 h"}
          className="h-11 text-base"
          disabled={enviando || !ventanaAbierta}
        />
        <Button
          type="button"
          onClick={handleEnviar}
          disabled={enviando || !texto.trim() || !ventanaAbierta}
          className="h-11 w-11 shrink-0 rounded-full bg-[#075E54] hover:bg-[#064a42] p-0"
        >
          {enviando ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
        </Button>
      </div>

      {/* Edición del pedido vigente (mismo modal que usa la tabla). */}
      {pedidoActivo && (
        <EditOrderModal
          open={editandoPedido}
          onOpenChange={setEditandoPedido}
          pedido={pedidoActivo}
          onSaved={refrescarPedido}
        />
      )}
    </div>
  )
}

"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createClient } from "@/lib/supabase-client"
import { Send, Bot, User, Loader2, AlertCircle, FileText, MapPin, Download, Pencil, ClipboardCheck, Ban, ShieldCheck, RotateCcw, CheckCircle2 } from "lucide-react"
import {
  getHistorialChat,
  getEstadoAtencion,
  getPedidoActivoChat,
  getEstadoModeracion,
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

interface ChatModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** El chat es por teléfono; el pedido es opcional (puede abrirse sin pedido,
   *  p.ej. desde la campana de avisos para un cliente que aún no tiene orden). */
  telefono: string
  pedidoId?: number
}

const esOutbound = (rol: string) => rol === "bot" || rol === "operador"

// Ventana de mensajería libre de Meta: solo se puede escribirle al cliente
// dentro de las 24h desde su último mensaje entrante.
const VENTANA_24H_MS = 24 * 60 * 60 * 1000

function horaCorta(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
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
          <a href={m.media_url} target="_blank" rel="noopener noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={m.media_url}
              alt={m.media_caption ?? "imagen"}
              className="rounded-md max-h-60 w-auto object-contain"
            />
          </a>
          {caption}
        </>
      ) : (
        noDisponible
      )

    case "audio":
      return m.media_url ? (
        <audio controls src={m.media_url} className="max-w-[230px]" />
      ) : (
        noDisponible
      )

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

export function ChatModal({ open, onOpenChange, telefono, pedidoId }: ChatModalProps) {

  const [mensajes, setMensajes] = React.useState<MensajeChat[]>([])
  const [cargando, setCargando] = React.useState(false)
  const [texto, setTexto] = React.useState("")
  const [enviando, setEnviando] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [atencionActiva, setAtencionActiva] = React.useState(false)
  // Moderación manual del número: bloqueo persistente + reset del rate-limit.
  const [bloqueado, setBloqueado] = React.useState(false)
  const [moderando, setModerando] = React.useState(false)
  const [aviso, setAviso] = React.useState<string | null>(null)
  // Pedido vigente (borrador/cocina/esperando_cancelacion) del teléfono, para
  // el panel de acceso rápido: editarlo o mandarle el resumen de confirmación.
  const [pedidoActivo, setPedidoActivo] = React.useState<Pedido | null>(null)
  const [editandoPedido, setEditandoPedido] = React.useState(false)
  const [enviandoResumen, setEnviandoResumen] = React.useState(false)
  // Tick para que la ventana de 24h se cierre sola en la UI aunque no llegue
  // un mensaje nuevo (re-evalúa `ventanaAbierta` cada minuto mientras está abierto).
  const [ahora, setAhora] = React.useState<number>(() => Date.now())

  const finRef = React.useRef<HTMLDivElement | null>(null)

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

  // Carga inicial del historial + estado de la toma humana al abrir.
  React.useEffect(() => {
    if (!open) return
    let cancelado = false

    setCargando(true)
    setError(null)
    setAviso(null)
    // Abrir el chat cuenta como "ya lo vi": limpiamos el aviso de requiere_atencion.
    marcarAtendido(telefono).catch(() => {})
    Promise.all([getHistorialChat(telefono), getEstadoAtencion(telefono), getPedidoActivoChat(telefono), getEstadoModeracion(telefono)])
      .then(([historial, estado, pedido, moderacion]) => {
        if (cancelado) return
        setMensajes(historial)
        setAtencionActiva(estado.activa)
        setPedidoActivo(pedido)
        setBloqueado(moderacion.bloqueado)
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
  }, [open, telefono])

  // Suscripción Realtime a los INSERT de mensajes_chat de este teléfono.
  React.useEffect(() => {
    if (!open) return

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
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [open, telefono, agregarMensaje])

  // Re-evalúa la ventana de 24h cada minuto mientras el modal está abierto.
  React.useEffect(() => {
    if (!open) return
    const t = setInterval(() => setAhora(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [open])

  // Marca este teléfono como "chat abierto" mientras el modal está montado y
  // abierto. Lo lee el componente de notificaciones para NO disparar un toast
  // por un mensaje que ya estás mirando en vivo. La limpieza en el cleanup
  // cubre tanto el cierre como el desmontaje del componente.
  React.useEffect(() => {
    if (!open) return
    setChatAbierto(telefono)
    return () => {
      setChatAbierto(null)
    }
  }, [open, telefono])

  // Autoscroll al último mensaje.
  React.useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [mensajes])

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

  // Re-lee el pedido vigente (tras editar o mandar el resumen, el estado y los
  // montos pueden haber cambiado).
  const refrescarPedido = React.useCallback(() => {
    getPedidoActivoChat(telefono)
      .then(setPedidoActivo)
      .catch(() => {})
  }, [telefono])

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
      setAviso("Límite reseteado — el cliente puede volver a escribirle al bot.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo resetear el límite")
    } finally {
      setModerando(false)
    }
  }, [moderando, telefono])

  // Cerrar el modal NO devuelve la conversación al bot: un operador puede estar
  // en el medio de una consulta que el bot no sabe manejar (ej: "mitad efectivo
  // mitad transferencia", "en billetes de cuánto vas a pagar?") y una respuesta
  // demorada del cliente cerraría el chat prematuramente. La toma humana termina
  // solo con el botón explícito "Devolver al bot", con el envío del resumen
  // manual, o por auto-expiración (VENTANA_TOMA_MS = 8h de inactividad).
  // Mientras tanto, las notificaciones del header avisan si el cliente escribe.
  const handleOpenChange = React.useCallback(
    (isOpen: boolean) => {
      onOpenChange(isOpen)
    },
    [onOpenChange],
  )

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[95vw] max-w-[480px] p-0 overflow-hidden gap-0">
        {/* Encabezado estilo WhatsApp */}
        <DialogHeader className="bg-[#075E54] text-white px-4 py-3 text-left space-y-0">
          <DialogTitle className="text-white text-base font-semibold">
            {pedidoId != null ? `Pedido #${pedidoId}` : "Chat"}
          </DialogTitle>
          <span className="text-xs text-white/80">{telefono}</span>
        </DialogHeader>

        {/* Barra de moderación: bloquear/desbloquear el número y resetear el
            rate-limit anti-DoS. El bloqueo afecta SOLO al bot (el operador puede
            seguir escribiendo a mano). */}
        <div className="flex items-center justify-between gap-2 border-b bg-slate-50 px-4 py-1.5">
          <span className="text-[11px] text-slate-400">
            {bloqueado ? "🚫 Bloqueado — el bot no le responde" : "Moderación"}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px] text-slate-500 hover:text-slate-700"
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

        {/* Panel del pedido vigente: acceso rápido a editarlo y a mandar el
            resumen con botones de confirmación (devuelve el control al bot).
            Pensado para cuando la extracción de la IA falló o hay que cargar
            un precio especial (promo) que la lista no contempla. */}
        {pedidoActivo && (
          <div className="flex items-center justify-between gap-2 bg-cyan-50 border-b border-cyan-200 px-4 py-2">
            <div className="min-w-0 text-xs text-slate-700">
              <div>
                <span className="font-semibold">Pedido #{pedidoActivo.id}</span>
                <span className="mx-1.5 text-slate-400">·</span>
                <span>{ETIQUETA_ESTADO[pedidoActivo.estado] ?? pedidoActivo.estado}</span>
              </div>
              <div className="truncate text-slate-500">
                {[
                  pedidoActivo.cantidad_agua > 0 ? `${pedidoActivo.cantidad_agua} agua` : null,
                  pedidoActivo.cantidad_crema > 0 ? `${pedidoActivo.cantidad_crema} crema` : null,
                ]
                  .filter(Boolean)
                  .join(" + ") || "sin cantidades"}
                {" · "}
                {pedidoActivo.precio_total != null
                  ? `$${pedidoActivo.precio_total}`
                  : "total a confirmar"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-cyan-300 text-cyan-800 hover:bg-cyan-100"
                onClick={() => setEditandoPedido(true)}
              >
                <Pencil className="h-3 w-3" /> Editar
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-cyan-300 text-cyan-800 hover:bg-cyan-100"
                onClick={handleEnviarResumen}
                disabled={enviandoResumen || !ventanaAbierta || !pedidoCompletoParaResumen(pedidoActivo)}
                title={
                  !pedidoCompletoParaResumen(pedidoActivo)
                    ? "Al pedido le faltan datos (cantidades, dirección o pago)"
                    : !ventanaAbierta
                      ? "Fuera de la ventana de 24 h de WhatsApp"
                      : "Manda el resumen con botones de confirmación y devuelve el control al bot"
                }
              >
                {enviandoResumen ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ClipboardCheck className="h-3 w-3" />
                )}{" "}
                Enviar resumen
              </Button>
            </div>
          </div>
        )}

        {/* Cuerpo del chat */}
        <div className="h-[55vh] overflow-y-auto px-3 py-3 bg-[#ECE5DD] space-y-2">
          {cargando ? (
            <div className="flex h-full items-center justify-center text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Cargando conversación…
            </div>
          ) : mensajes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-slate-500 text-sm">
              No hay mensajes recientes con este cliente (últimas 24 h).
            </div>
          ) : (
            mensajes.map((m) => {
              const out = esOutbound(m.rol)
              return (
                <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
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
              )
            })
          )}
          <div ref={finRef} />
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

        {/* Aviso de ventana de 24h cerrada (no se puede escribir hasta que el cliente vuelva a escribir) */}
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
      </DialogContent>
    </Dialog>

    {/* Edición del pedido vigente (mismo modal que usa la tabla). Al guardar
        refrescamos el panel; el resumen se manda aparte con su botón. */}
    {pedidoActivo && (
      <EditOrderModal
        open={editandoPedido}
        onOpenChange={setEditandoPedido}
        pedido={pedidoActivo}
        onSaved={refrescarPedido}
      />
    )}
    </>
  )
}

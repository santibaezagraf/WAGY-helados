"use client"

import * as React from "react"
import { MessageCircle, X, ImageIcon, Mic, Video, FileText, MapPin, Sticker } from "lucide-react"
import { createClient } from "@/lib/supabase-client"
import {
  getChatAbierto,
  hidratarTomaActiva,
  onChangeChatAbierto,
  setTomaActiva,
  tieneTomaActiva,
} from "@/lib/chat-abierto-store"
import { getTelefonosConTomaActiva, getTelefonosRequierenAtencion } from "@/lib/actions/mensajes"

// Cuánto queda visible cada toast en pantalla (ms). Un poco más largo que antes
// para que el operador alcance a leer el preview del mensaje.
const DURACION_TOAST_MS = 8_000

type Aviso = {
  id: string
  telefono: string
  preview: string
  // Icono opcional a la izquierda del preview (para media/ubicación estilo WhatsApp).
  tipoMedia?: string
}

// Preview del mensaje al estilo WhatsApp: para texto muestra el contenido
// (truncado por CSS); para media, un ícono + etiqueta.
function armarPreview(fila: {
  tipo?: string
  texto?: string | null
  media_caption?: string | null
}): { preview: string; tipoMedia?: string } {
  const tipo = fila.tipo
  if (!tipo || tipo === "text") {
    return { preview: (fila.texto ?? "").trim() || "(mensaje vacío)" }
  }
  const etiquetas: Record<string, string> = {
    image: "Foto",
    audio: "Mensaje de voz",
    video: "Video",
    document: "Documento",
    sticker: "Sticker",
    location: "Ubicación",
  }
  const base = etiquetas[tipo] ?? "Adjunto"
  const caption = fila.media_caption?.trim()
  return { preview: caption ? `${base}: ${caption}` : base, tipoMedia: tipo }
}

function IconoMedia({ tipo }: { tipo: string }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-slate-500"
  switch (tipo) {
    case "image":
      return <ImageIcon className={cls} />
    case "audio":
      return <Mic className={cls} />
    case "video":
      return <Video className={cls} />
    case "document":
      return <FileText className={cls} />
    case "location":
      return <MapPin className={cls} />
    case "sticker":
      return <Sticker className={cls} />
    default:
      return null
  }
}

/**
 * Ping con WebAudio (evita necesitar un asset). Los navegadores bloquean
 * autoplay hasta la primera interacción del usuario; en el dashboard el
 * operador ya interactuó al loguearse, así que suena. Si el AudioContext falla,
 * seguimos mostrando el toast sin ruido.
 *
 * Diseño del sonido: dos "dings" con envolvente ADSR (attack rápido, decay
 * lento) para que se escuche claro incluso con música/audio abierto. Volumen
 * subido (~0.9) respecto al beep original — pensamos en el operador atendiendo
 * mientras hace otra cosa.
 */
function reproducirPing(): void {
  try {
    const Ctx: typeof AudioContext | undefined =
      typeof window !== "undefined"
        ? window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined
    if (!Ctx) return
    const ctx = new Ctx()

    const emitirTono = (freq: number, inicio: number, duracion: number, volumen: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "triangle" // más "cuerpo" que sine, se escucha más presente
      osc.frequency.setValueAtTime(freq, ctx.currentTime + inicio)
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + inicio)
      gain.gain.exponentialRampToValueAtTime(volumen, ctx.currentTime + inicio + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + duracion)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(ctx.currentTime + inicio)
      osc.stop(ctx.currentTime + inicio + duracion + 0.02)
      return osc
    }

    // Dos "dings" separados, estilo notificación de mensajería.
    emitirTono(988, 0, 0.35, 0.9) // B5
    const ultimo = emitirTono(1319, 0.18, 0.45, 0.9) // E6

    ultimo.onended = () => {
      ctx.close().catch(() => {})
    }
  } catch {
    // Silencioso: el toast visual ya cumple.
  }
}

/**
 * Toast push (arriba a la derecha, con sonido) para dos casos que requieren
 * acción del operador y no serían visibles si el chat no está abierto:
 *
 *  1) Mensaje entrante de un CLIENTE cuando la conversación está bajo toma
 *     humana activa y el chat de ese teléfono no está abierto — "estoy
 *     atendiendo a mano y el cliente me respondió mientras miraba otra cosa".
 *  2) El bot delegó a un humano (`atencion_humana.requiere_atencion` pasa a
 *     true): consulta_negocio, pregunta_negocio embebida, media sin resolver
 *     (imagen/video/doc/etc.), o audio con transcripción fallida. Es el
 *     momento en que la conversación pasa a necesitar acción humana.
 *
 * En ambos casos: si el chat de ese teléfono ya está abierto, no molestamos
 * (el operador ya lo está viendo por el Realtime del propio modal).
 *
 * Estilo: contorno verde WhatsApp, preview en dos líneas, ping fuerte.
 * Pensado para llamar la atención del operador aunque esté en otra pestaña o
 * mirando otra parte de la app. Al clickear el cuerpo del toast se abre el
 * chat de ese teléfono (`onAbrirChat`).
 */
export function NotificacionesEntrantes({
  onAbrirChat,
}: {
  onAbrirChat: (telefono: string) => void
}) {
  const [avisos, setAvisos] = React.useState<Aviso[]>([])
  const chatAbiertoRef = React.useRef<string | null>(null)
  // Teléfonos con `requiere_atencion=true` ya conocidos. Se usa para no
  // re-tostar: un update de atencion_humana que solo refresca updated_at
  // (p.ej. tocarAtencionHumana) llega igual por Realtime; sin este set el
  // toast se dispararía en cada refresh porque `payload.old` en Supabase no
  // trae las columnas sin REPLICA IDENTITY FULL.
  const pendientesRef = React.useRef<Set<string>>(new Set())

  // Estado inicial del set de tomas activas + del set de pendientes +
  // suscripción al store del chat abierto.
  React.useEffect(() => {
    let cancelado = false
    getTelefonosConTomaActiva()
      .then((activas) => {
        if (cancelado) return
        hidratarTomaActiva(activas)
      })
      .catch(() => {
        /* si falla, el set inicial queda vacío y se llena por Realtime */
      })
    getTelefonosRequierenAtencion()
      .then((pendientes) => {
        if (cancelado) return
        pendientesRef.current = new Set(pendientes)
      })
      .catch(() => {
        /* si falla, el set arranca vacío: el primer update por tel disparará
           un toast de más (aceptable — mejor un toast extra que ninguno). */
      })
    chatAbiertoRef.current = getChatAbierto()
    const off = onChangeChatAbierto(() => {
      chatAbiertoRef.current = getChatAbierto()
    })
    return () => {
      cancelado = true
      off()
    }
  }, [])

  const empujarAviso = React.useCallback((aviso: Aviso) => {
    setAvisos((prev) => [...prev, aviso])
    reproducirPing()
    window.setTimeout(() => {
      setAvisos((prev) => prev.filter((a) => a.id !== aviso.id))
    }, DURACION_TOAST_MS)
  }, [])

  React.useEffect(() => {
    const supabase = createClient()

    const canalMensajes = supabase
      .channel("notif-mensajes-entrantes")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensajes_chat" },
        (payload) => {
          const fila = payload.new as {
            rol?: string
            telefono?: string | null
            tipo?: string
            texto?: string | null
            media_caption?: string | null
          }
          if (!fila.telefono || fila.rol !== "cliente") return
          const tel = fila.telefono
          if (chatAbiertoRef.current === tel) return
          if (!tieneTomaActiva(tel)) return
          const { preview, tipoMedia } = armarPreview(fila)
          empujarAviso({
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            telefono: tel,
            preview,
            tipoMedia,
          })
        },
      )
      .subscribe()

    // Mantiene el set de tomas activas al día Y dispara toast cuando el bot
    // delega a un humano (requiere_atencion transiciona a true). No queremos
    // re-tostar cuando el flag ya estaba en true y solo cambió otra columna
    // (p.ej. `tocarAtencionHumana` refresca updated_at) — comparamos contra
    // `pendientesRef` en vez de contra `payload.old`, que llega sin las
    // columnas no-PK a menos que la tabla tenga REPLICA IDENTITY FULL.
    const canalAtencion = supabase
      .channel("notif-atencion-humana")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "atencion_humana" },
        (payload) => {
          const nueva = payload.new as
            | { telefono?: string; activa?: boolean; requiere_atencion?: boolean }
            | undefined
          if (!nueva?.telefono) return
          const tel = nueva.telefono
          setTomaActiva(tel, nueva.activa === true)

          // Transición a "pendiente" (delegación del bot, o media sin
          // resolver): dispara toast, salvo:
          //  - que el chat ya esté abierto (el operador ya lo ve), o
          //  - que la toma humana ya esté activa para ese tel: ahí
          //    `requiere_atencion=true` significa "no leído" (flag
          //    dual-purpose), no "el bot pidió ayuda", y el mensaje
          //    entrante del cliente ya disparó el toast correcto por el
          //    canal de mensajes_chat — este sería un segundo toast redundante.
          const yaEraPendiente = pendientesRef.current.has(tel)
          if (nueva.requiere_atencion === true) {
            if (!yaEraPendiente) {
              pendientesRef.current.add(tel)
              if (chatAbiertoRef.current !== tel && !tieneTomaActiva(tel)) {
                empujarAviso({
                  id: `deleg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  telefono: tel,
                  preview: "El bot pidió ayuda con esta conversación.",
                })
              }
            }
          } else {
            // El operador abrió el chat / respondió → flag limpiado.
            pendientesRef.current.delete(tel)
          }
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(canalMensajes)
      supabase.removeChannel(canalAtencion)
    }
  }, [empujarAviso])

  const descartar = (id: string) => {
    setAvisos((prev) => prev.filter((a) => a.id !== id))
  }

  const abrir = (a: Aviso) => {
    onAbrirChat(a.telefono)
    descartar(a.id)
  }

  if (avisos.length === 0) return null

  return (
    <div className="pointer-events-none fixed top-3 right-3 z-[100] flex flex-col gap-2.5">
      {avisos.map((a) => (
        <div
          key={a.id}
          className="pointer-events-auto w-[22rem] max-w-[95vw] overflow-hidden rounded-lg border-2 border-[#25D366] bg-white shadow-xl animate-in slide-in-from-top-6 fade-in duration-300"
        >
          {/* Barra superior tipo header de WhatsApp */}
          <div className="flex items-center justify-between bg-[#075E54] px-3 py-1.5 text-[11px] font-semibold text-white">
            <span className="flex items-center gap-1.5">
              <MessageCircle className="h-3.5 w-3.5" />
              WhatsApp — nuevo mensaje
            </span>
            <button
              type="button"
              onClick={() => descartar(a.id)}
              className="shrink-0 rounded p-0.5 text-white/80 hover:bg-white/15 hover:text-white"
              aria-label="Cerrar notificación"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Cuerpo con el remitente y el preview. Clickeable: abre el chat. */}
          <button
            type="button"
            onClick={() => abrir(a)}
            className="block w-full px-3 py-2 text-left hover:bg-slate-50"
          >
            <div className="text-sm font-semibold text-slate-800">{a.telefono}</div>
            <div className="mt-0.5 flex items-start gap-1.5">
              {a.tipoMedia && <IconoMedia tipo={a.tipoMedia} />}
              <p className="line-clamp-2 text-sm text-slate-700 break-words">{a.preview}</p>
            </div>
          </button>
        </div>
      ))}
    </div>
  )
}

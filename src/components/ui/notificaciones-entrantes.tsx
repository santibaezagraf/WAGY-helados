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
import { getTelefonosConTomaActiva } from "@/lib/actions/mensajes"

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
 * Toast push (arriba a la derecha, con sonido) SOLO para mensajes entrantes de
 * un CLIENTE cuando la conversación está en manos de un operador y el chat de
 * ese teléfono NO está abierto (si está abierto, el operador ya lo ve por el
 * Realtime del propio modal). Es el caso "estoy atendiendo a mano y el cliente
 * me respondió mientras miraba otra cosa".
 *
 * La delegación del bot a un humano (consulta_negocio / pregunta_negocio →
 * `requiere_atencion=true`) NO dispara toast: se refleja como badge en el ícono
 * de chat del header (ver header.tsx). Igual escuchamos `atencion_humana` acá
 * para mantener el set de tomas activas al día.
 *
 * Estilo: contorno verde WhatsApp, preview del mensaje en dos líneas, ping
 * fuerte. Pensado para llamar la atención del operador aunque esté en otra
 * pestaña o mirando otra parte de la app. Al clickear el cuerpo del toast se
 * abre el chat de ese teléfono (`onAbrirChat`).
 */
export function NotificacionesEntrantes({
  onAbrirChat,
}: {
  onAbrirChat: (telefono: string) => void
}) {
  const [avisos, setAvisos] = React.useState<Aviso[]>([])
  const chatAbiertoRef = React.useRef<string | null>(null)

  // Estado inicial del set de tomas activas + suscripción al store del chat abierto.
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

    // Solo para mantener el set de tomas activas al día (no dispara toast).
    const canalAtencion = supabase
      .channel("notif-atencion-humana")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "atencion_humana" },
        (payload) => {
          const nueva = payload.new as
            | { telefono?: string; activa?: boolean }
            | undefined
          if (!nueva?.telefono) return
          setTomaActiva(nueva.telefono, nueva.activa === true)
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

"use client"

import * as React from "react"
import { Search, MessageCircle, Loader2, ChevronLeft, ChevronRight, Ban, ShieldCheck, UserCog, ArrowLeft } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { createClient } from "@/lib/supabase-client"
import { ChatPanel } from "@/components/pedidos/chat-panel"
import {
  getInboxConversaciones,
  type FilaInbox,
  type FiltroInbox,
  type PaginaInbox,
} from "@/lib/actions/conversaciones"
import { desbloquearNumeroAccion } from "@/lib/actions/mensajes"
import { marcaPendiente } from "@/lib/conversaciones-utils"
import { claveDiaAR, formatearHoraAR, formatearFechaAR } from "@/lib/zona-horaria"

const TABS: { id: FiltroInbox; label: string }[] = [
  { id: "todas", label: "Todas" },
  { id: "pendientes", label: "Pendientes" },
  { id: "bloqueadas", label: "Bloqueadas" },
]

// Fecha compacta para el inbox: hora si es hoy (AR), si no día/mes.
function fechaCorta(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  const esHoy = claveDiaAR(d) === claveDiaAR(new Date())
  return esHoy
    ? formatearHoraAR(d)
    : formatearFechaAR(d, { day: "2-digit", month: "2-digit" })
}

export function ConversacionesInbox({ inicial }: { inicial: PaginaInbox }) {
  const [filtro, setFiltro] = React.useState<FiltroInbox>("todas")
  const [busqueda, setBusqueda] = React.useState("")
  const [pagina, setPagina] = React.useState<PaginaInbox>(inicial)
  const [cargando, setCargando] = React.useState(false)
  // Teléfono seleccionado → se muestra en el panel derecho (estilo WhatsApp Web).
  const [seleccionado, setSeleccionado] = React.useState<string | null>(null)
  const [desbloqueando, setDesbloqueando] = React.useState<string | null>(null)

  // Refs con el estado vigente para que la suscripción de Realtime (montada una
  // sola vez) recargue la vista actual sin cerrar sobre valores viejos.
  const estadoRef = React.useRef({ filtro, busqueda, page: 1 })

  const cargar = React.useCallback(
    async (f: FiltroInbox, q: string, page: number, silencioso = false) => {
      estadoRef.current = { filtro: f, busqueda: q, page }
      // `silencioso`: refetch de fondo (Realtime / marcar-atendido) → NO tocamos
      // `cargando` (la lista queda visible, sin parpadeo) y NO recontamos
      // (conCount=false: el count exact es caro sobre la vista distinct-on y el
      // total casi nunca cambia entre mensajes). La carga por navegación
      // (tab/búsqueda/página) sí muestra el spinner y recalcula el total.
      if (!silencioso) setCargando(true)
      try {
        const data = await getInboxConversaciones(f, q, page, !silencioso)
        // Descartamos respuestas viejas: solo aplicamos si el estado no cambió
        // mientras esperábamos.
        const vig = estadoRef.current
        if (vig.filtro === f && vig.busqueda === q && vig.page === page) {
          // total=null (refetch de fondo) → conservamos el total que ya teníamos.
          setPagina((prev) => ({ ...data, total: data.total ?? prev.total }))
        }
      } finally {
        if (!silencioso) setCargando(false)
      }
    },
    [],
  )

  // Cambio de tab: recarga desde la página 1.
  const cambiarFiltro = (f: FiltroInbox) => {
    if (f === filtro) return
    setFiltro(f)
    cargar(f, busqueda, 1)
  }

  // Búsqueda con debounce (350ms), siempre vuelve a página 1.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (busqueda === "" && filtro === "todas" && pagina === inicial) return
      cargar(filtro, busqueda, 1)
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda])

  const irPagina = (page: number) => cargar(filtro, busqueda, page)

  // Realtime: reconciliamos in-place los flags de las filas visibles (para que
  // el amber del inbox aparezca/desaparezca en el MISMO instante que el del
  // dropdown del header — mismos eventos, mismo helper `marcaPendiente`) y en
  // paralelo hacemos un refetch debounced para actualizar orden, preview,
  // paginación y agregar/quitar filas. El servidor sigue siendo la fuente de
  // verdad; la reconciliación local es solo para el "primer pixel".
  React.useEffect(() => {
    const supabase = createClient()
    let t: ReturnType<typeof setTimeout> | null = null
    const recargarDebounced = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        const { filtro, busqueda, page } = estadoRef.current
        cargar(filtro, busqueda, page, true) // silencioso: no parpadea la lista
      }, 800)
    }
    const canal = supabase
      .channel("inbox-conversaciones")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensajes_chat" },
        (payload) => {
          const fila = payload.new as {
            telefono?: string | null
            rol?: string | null
            tipo?: string | null
            procesado?: boolean | null
          }
          if (fila.telefono && marcaPendiente(fila)) {
            // Prende el amber sobre la fila del inbox al instante (si la fila
            // no está en la página actual, el refetch la trae).
            setPagina((prev) => ({
              ...prev,
              items: prev.items.map((c) =>
                c.telefono === fila.telefono ? { ...c, requiereAtencion: true } : c,
              ),
            }))
          }
          recargarDebounced()
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "atencion_humana" },
        (payload) => {
          const fila = payload.new as {
            telefono?: string
            requiere_atencion?: boolean
          } | null
          if (fila?.telefono) {
            const requiere = fila.requiere_atencion === true
            // Refleja el flag EXACTO que vino del servidor sobre la fila local:
            // cubre tanto el "prende" (webhook marcó pendiente) como el "apaga"
            // (el operador abrió el chat → marcarAtendido lo limpia).
            setPagina((prev) => ({
              ...prev,
              items: prev.items.map((c) =>
                c.telefono === fila.telefono ? { ...c, requiereAtencion: requiere } : c,
              ),
            }))
          }
          recargarDebounced()
        },
      )
      .subscribe()
    return () => {
      if (t) clearTimeout(t)
      supabase.removeChannel(canal)
    }
  }, [cargar])

  // Seleccionar una conversación: la muestra en el panel derecho y limpia
  // (optimista) su resaltado de pendiente — al abrirla, ChatPanel marca atendido
  // en la DB y el refetch de Realtime reconcilia.
  const seleccionar = (telefono: string) => {
    setSeleccionado(telefono)
    setPagina((prev) => ({
      ...prev,
      items: prev.items.map((c) => (c.telefono === telefono ? { ...c, requiereAtencion: false } : c)),
    }))
  }

  const desbloquear = async (telefono: string) => {
    setDesbloqueando(telefono)
    try {
      await desbloquearNumeroAccion(telefono)
      await cargar(estadoRef.current.filtro, estadoRef.current.busqueda, estadoRef.current.page, true)
    } finally {
      setDesbloqueando(null)
    }
  }

  // `total` puede ser null momentáneamente si el primer fetch fuera de fondo;
  // en la práctica el estado siempre conserva un número (se hidrata con count).
  const total = pagina.total ?? 0
  const totalPaginas = Math.max(1, Math.ceil(total / pagina.pageSize))

  return (
    <div className="flex h-full min-h-0">
      {/* Panel izquierdo: lista de conversaciones. En mobile se oculta cuando hay
          una conversación abierta (se ve solo el chat). */}
      <div
        className={`flex h-full min-h-0 w-full flex-col border-slate-200 bg-white md:w-[360px] md:border-r ${
          seleccionado ? "hidden md:flex" : "flex"
        }`}
      >
        <div className="shrink-0 border-b border-slate-100 px-3 py-3">
          <div className="mb-3 flex items-center gap-2">
            <Link
              href="/"
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors"
              title="Volver a pedidos"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <MessageCircle className="h-5 w-5 text-cyan-600" />
            <h1 className="text-lg font-bold text-slate-800">Conversaciones</h1>
          </div>

          {/* Tabs de filtro */}
          <div className="mb-3 flex gap-1 rounded-lg bg-slate-100 p-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => cambiarFiltro(tab.id)}
                className={`flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
                  filtro === tab.id
                    ? "bg-white text-cyan-700 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Buscador por teléfono */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por teléfono…"
              className="pl-9"
              inputMode="tel"
            />
          </div>
        </div>

        {/* Lista scrolleable. Mantenemos los items visibles durante un refetch de
            fondo (Realtime / marcar-atendido): el spinner centrado solo aparece
            en la carga inicial (sin items todavía), para no "parpadear" la lista
            cada vez que se abre una conversación. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {cargando ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
            </div>
          ) : pagina.items.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              {filtro === "bloqueadas"
                ? "No hay números bloqueados."
                : busqueda
                  ? "Sin resultados para esa búsqueda."
                  : "Sin conversaciones en los últimos 30 días."}
            </div>
          ) : (
            pagina.items.map((c) => (
              <FilaConversacion
                key={c.telefono}
                c={c}
                seleccionado={c.telefono === seleccionado}
                onAbrir={() => seleccionar(c.telefono)}
                onDesbloquear={() => desbloquear(c.telefono)}
                desbloqueando={desbloqueando === c.telefono}
                esTabBloqueadas={filtro === "bloqueadas"}
              />
            ))
          )}
        </div>

        {/* Paginación */}
        {total > pagina.pageSize && (
          <div className="flex shrink-0 items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
            <span>
              pág. {pagina.page}/{totalPaginas} · {total}
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={pagina.page <= 1 || cargando} onClick={() => irPagina(pagina.page - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="outline" disabled={pagina.page >= totalPaginas || cargando} onClick={() => irPagina(pagina.page + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Panel derecho: el chat seleccionado. En desktop siempre visible (con
          empty state si no hay selección); en mobile solo cuando hay uno abierto. */}
      <div className={`h-full min-h-0 flex-1 ${seleccionado ? "flex" : "hidden md:flex"}`}>
        {seleccionado ? (
          // key por teléfono → remonta al cambiar de conversación (estado e
          // historial frescos).
          <ChatPanel
            key={seleccionado}
            telefono={seleccionado}
            activo
            onVolver={() => setSeleccionado(null)}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-slate-100 text-slate-400">
            <MessageCircle className="h-10 w-10" />
            <p className="text-sm">Elegí una conversación para verla acá</p>
          </div>
        )}
      </div>
    </div>
  )
}

function FilaConversacion({
  c,
  seleccionado,
  onAbrir,
  onDesbloquear,
  desbloqueando,
  esTabBloqueadas,
}: {
  c: FilaInbox
  seleccionado: boolean
  onAbrir: () => void
  onDesbloquear: () => void
  desbloqueando: boolean
  esTabBloqueadas: boolean
}) {
  return (
    <div
      className={`flex items-center gap-2 border-b border-slate-100 px-3 py-2.5 ${
        seleccionado ? "bg-cyan-50" : "hover:bg-slate-50"
      }`}
    >
      <button type="button" onClick={onAbrir} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${c.requiereAtencion ? "bg-amber-500" : "bg-transparent"}`}
          title={c.requiereAtencion ? "Espera intervención humana" : undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-slate-800">{c.telefono}</span>
            {c.tomaActiva && (
              <span title="Toma humana activa" className="inline-flex shrink-0 items-center gap-0.5 rounded bg-blue-100 px-1 text-[10px] font-medium text-blue-700">
                <UserCog className="h-3 w-3" /> manual
              </span>
            )}
            {c.bloqueado && (
              <span title="Número bloqueado" className="inline-flex shrink-0 items-center gap-0.5 rounded bg-red-100 px-1 text-[10px] font-medium text-red-700">
                <Ban className="h-3 w-3" /> bloqueado
              </span>
            )}
          </div>
          {c.preview && <p className="truncate text-sm text-slate-500">{c.preview}</p>}
        </div>
      </button>
      <span className="shrink-0 text-xs text-slate-400">{fechaCorta(c.ultimoAt)}</span>
      {esTabBloqueadas && (
        <Button size="sm" variant="outline" onClick={onDesbloquear} disabled={desbloqueando} className="shrink-0 gap-1">
          {desbloqueando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          <span className="hidden lg:inline">Desbloquear</span>
        </Button>
      )}
    </div>
  )
}

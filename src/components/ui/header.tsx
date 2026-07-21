"use client"

import { Logo } from "@/components/ui/logo"
import { Button } from "@/components/ui/button"
import { PriceListModal } from "@/components/pedidos/price-list-modal"
import { AddGastoModal } from "@/components/gastos/add-gasto-modal"
import * as React from "react"
import { Tags, BarChart3, Receipt, MessageCircle } from "lucide-react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase-client"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChatModal } from "@/components/pedidos/chat-modal"
import { NotificacionesEntrantes } from "@/components/ui/notificaciones-entrantes"
import type { Conversacion } from "@/lib/conversaciones-utils"

// Tipos de mensaje que el bot no resuelve y que disparan el aviso "requiere
// intervención humana". Debe coincidir con la lógica del webhook.
const TIPOS_REQUIEREN_HUMANO = new Set(["image", "audio", "video", "document", "sticker", "location"])

// Un mensaje entrante marca la conversación como pendiente cuando:
//  - es un media/ubicación (el bot no lo entiende), o
//  - es texto pero llegó con `procesado=true`: el webhook lo silenció porque hay
//    una toma humana activa o un gate por mensajes de operador reciente. Estos
//    son los que hoy pasaban desapercibidos hasta que se abría el chat.
function marcaPendiente(fila: { rol?: string; tipo?: string; procesado?: boolean }): boolean {
  if (fila.rol !== "cliente") return false
  if (fila.tipo && TIPOS_REQUIEREN_HUMANO.has(fila.tipo)) return true
  return fila.procesado === true
}

interface HeaderProps {
  /** Conversaciones recientes (cualquier teléfono con actividad), con flag de
   *  requiere_atencion para resaltar las que esperan a una persona. */
  conversacionesIniciales?: Conversacion[]
}

export function Header({ conversacionesIniciales = [] }: HeaderProps) {
  const [priceListModalOpen, setPriceListModalOpen] = React.useState(false)
  const [addGastoModalOpen, setAddGastoModalOpen] = React.useState(false)
  // Directorio de conversaciones recientes. El servidor es la fuente de verdad;
  // Realtime mueve al frente la que recibe actividad. Abrir un chat NO lo saca:
  // solo limpia su resaltado de "requiere atención".
  const [conversaciones, setConversaciones] = React.useState<Conversacion[]>(conversacionesIniciales)
  // Teléfono del chat abierto desde el menú (sin pedido asociado).
  const [chatTelefono, setChatTelefono] = React.useState<string | null>(null)
  const router = useRouter()

  // Re-sincronizamos con el servidor cuando cambia (navegación/revalidación).
  React.useEffect(() => {
    setConversaciones(conversacionesIniciales)
  }, [conversacionesIniciales])

  // En vivo: cualquier mensaje nuevo mueve su conversación al frente; si es un
  // media/ubicación de un cliente, además la marca como pendiente.
  React.useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel("conversaciones-header")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensajes_chat" },
        (payload) => {
          const fila = payload.new as {
            rol?: string
            tipo?: string
            telefono?: string | null
            procesado?: boolean
          }
          if (!fila.telefono) return
          const tel = fila.telefono
          const esPendiente = marcaPendiente(fila)
          setConversaciones((prev) => {
            const previa = prev.find((c) => c.telefono === tel)
            const resto = prev.filter((c) => c.telefono !== tel)
            return [
              { telefono: tel, requiereAtencion: esPendiente || previa?.requiereAtencion || false },
              ...resto,
            ]
          })
        },
      )
      // En vivo también: cuando el bot delega a un humano (consulta_negocio o
      // pregunta_negocio embebida en un mensaje con más intenciones), marca
      // `requiere_atencion=true` en atencion_humana. Sin escuchar esta tabla el
      // badge del header solo lo tomaba en el reload inicial. El flag se limpia
      // (requiere_atencion=false) al abrir el chat o cuando el operador escribe,
      // así que reflejamos ambas transiciones para mantener el badge en sync.
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "atencion_humana" },
        (payload) => {
          const fila = payload.new as {
            telefono?: string
            requiere_atencion?: boolean
          } | null
          if (!fila?.telefono) return
          const tel = fila.telefono
          const requiere = fila.requiere_atencion === true
          setConversaciones((prev) => {
            const previa = prev.find((c) => c.telefono === tel)
            // Si el teléfono no está en la lista y hay que marcarlo, lo sumamos
            // al frente; si ya está, solo actualizamos su flag in-place (no lo
            // movemos: no llegó un mensaje nuevo, solo cambió el estado).
            if (!previa) {
              return requiere ? [{ telefono: tel, requiereAtencion: true }, ...prev] : prev
            }
            return prev.map((c) =>
              c.telefono === tel ? { ...c, requiereAtencion: requiere } : c,
            )
          })
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const pendientes = conversaciones.filter((c) => c.requiereAtencion).length

  // Abrir un chat: limpia su resaltado de pendiente (al abrir, el modal ya marca
  // atendido en la DB), pero la conversación queda en la lista para volver.
  const abrirChat = React.useCallback((tel: string) => {
    setConversaciones((prev) =>
      prev.map((c) => (c.telefono === tel ? { ...c, requiereAtencion: false } : c)),
    )
    setChatTelefono(tel)
  }, [])

  return (
    <>
      <header className="shrink-0 bg-cyan-600 border-b-2 border-cyan-300 shadow-sm">
        <div className="px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-3 py-2">
            <div className="flex items-center gap-2">
              <Logo size="sm" />
              <h1 className="text-lg sm:text-xl font-bold text-slate-800">
                WAGY Helados
              </h1>
            </div>

            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="relative flex items-center p-1 rounded hover:bg-cyan-500/40"
                    title={
                      pendientes > 0
                        ? `${pendientes} conversación(es) esperan intervención humana`
                        : "Conversaciones recientes"
                    }
                  >
                    <MessageCircle className="h-5 w-5 text-white" />
                    {pendientes > 0 && (
                      <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                        {pendientes > 9 ? "9+" : pendientes}
                      </span>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64 max-h-[70vh] overflow-y-auto">
                  <DropdownMenuLabel>Conversaciones recientes</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {conversaciones.length === 0 ? (
                    <div className="px-2 py-3 text-xs text-slate-500 text-center">
                      Sin conversaciones recientes
                    </div>
                  ) : (
                    conversaciones.map((c) => (
                      <DropdownMenuItem
                        key={c.telefono}
                        onClick={() => abrirChat(c.telefono)}
                        className="gap-2"
                      >
                        <span
                          className={`h-2 w-2 rounded-full shrink-0 ${
                            c.requiereAtencion ? "bg-amber-500" : "bg-transparent"
                          }`}
                        />
                        <span className={c.requiereAtencion ? "font-medium" : ""}>{c.telefono}</span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="sm"
                onClick={() => setAddGastoModalOpen(true)}
                className="gap-2 bg-white text-rose-600 hover:bg-slate-100 font-medium"
              >
                <Receipt className="h-4 w-4" />
                <span className="hidden sm:inline">+ Gasto</span>
              </Button>
              <Button
                size="sm"
                onClick={() => router.push('/balances')}
                className="gap-2 bg-white text-emerald-600 hover:bg-slate-100 font-medium"
              >
                <BarChart3 className="h-4 w-4" />
                <span className="hidden sm:inline">Balances</span>
              </Button>
              <Button
                size="sm"
                onClick={() => setPriceListModalOpen(true)}
                className="gap-2 bg-white text-cyan-600 hover:bg-slate-100 font-medium"
              >
                <Tags className="h-4 w-4" />
                <span className="hidden sm:inline">Listas de Precios</span>
                <span className="sm:hidden">Precios</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <PriceListModal
        open={priceListModalOpen}
        onOpenChange={setPriceListModalOpen}
      />

      <AddGastoModal
        open={addGastoModalOpen}
        onOpenChange={setAddGastoModalOpen}
      />

      {/* Chat abierto desde la campana (por teléfono, sin pedido asociado). */}
      {chatTelefono !== null && (
        <ChatModal
          open={true}
          onOpenChange={(isOpen) => {
            if (!isOpen) setChatTelefono(null)
          }}
          telefono={chatTelefono}
        />
      )}

      {/* Toasts globales de notificaciones entrantes (mensajes de cliente con
          toma humana activa y chat cerrado). Al clickearlos, abren el chat de
          ese teléfono. */}
      <NotificacionesEntrantes onAbrirChat={abrirChat} />
    </>
  )
}

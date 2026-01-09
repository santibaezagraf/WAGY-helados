import { Button } from "../ui/button"
import { MessageSquare, Copy, CheckCheck } from "lucide-react"
import * as React from "react"
import { createClient } from "@/lib/supabase-client"

interface MessageEditorProps {
  mensajes: { id: number; mensaje: string; enviado: boolean }[]
  onClose: () => void
  onRefresh?: () => Promise<void>
}

export function MessageEditor({ 
  mensajes, 
  onClose, 
  onRefresh 
}: MessageEditorProps) {
  const editorWppRef = React.useRef<HTMLDivElement>(null)
  
  // Estado local: mensajes editables (copia local de las props)
  const [mensajesWpp, setMensajesWpp] = React.useState(mensajes)
  
  // Estado local: feedback visual de copiado
  const [copiados, setCopiados] = React.useState<Set<number>>(new Set())

  // Sincronizar con props cuando cambian (por si se regeneran mensajes)
  React.useEffect(() => {
    setMensajesWpp(mensajes)
  }, [mensajes])

  // Scroll automático cuando se muestran mensajes
  React.useEffect(() => {
    if (mensajes.length > 0) {
      setTimeout(() => {
        editorWppRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    }
  }, [mensajes.length])

  // Función local: copiar mensaje individual
  const copiarMensaje = React.useCallback(async (id: number, mensaje: string, enviado: boolean) => {
    navigator.clipboard.writeText(mensaje)
    setCopiados(prev => new Set(prev).add(id))
    
    // Si no estaba enviado, marcarlo como enviado en DB
    if (!enviado) {
      const supabase = createClient()
      const { error } = await supabase
        .from("pedidos")
        .update({ enviado: true })
        .eq("id", id)
      
      if (error) {
        console.error("Error al actualizar enviado:", error)
      } else {
        onRefresh?.()
      }
    }
    
    // Quitar feedback visual después de 2 segundos
    setTimeout(() => {
      setCopiados(prev => {
        const newSet = new Set(prev)
        newSet.delete(id)
        return newSet
      })
    }, 2000)
  }, [onRefresh])

  // Función local: copiar todos los mensajes
  const copiarTodos = React.useCallback(async () => {
    if (mensajesWpp.length === 0) return

    const idsNoEnviados = mensajesWpp.filter(m => !m.enviado).map(m => m.id)

    // Marcar todos como enviados en DB
    if (idsNoEnviados.length > 0) {
      const supabase = createClient()
      const { error } = await supabase
        .from("pedidos")
        .update({ enviado: true })
        .in("id", idsNoEnviados)

      if (error) {
        console.error("Error al actualizar enviado:", error)
      } else {
        onRefresh?.()
      }
    }

    // Copiar todos los mensajes concatenados
    const todosMensajes = mensajesWpp.map(m => m.mensaje).join('\n\n')
    navigator.clipboard.writeText(todosMensajes)
  }, [mensajesWpp, onRefresh])

  // Función local: actualizar mensaje editado
  const actualizarMensaje = (id: number, nuevoMensaje: string) => {
    setMensajesWpp(prev => 
      prev.map(m => m.id === id ? { ...m, mensaje: nuevoMensaje } : m)
    )
  }

  return (
        <div ref={editorWppRef} className="bg-cyan-50 border border-cyan-300 rounded-lg p-4 space-y-3 shadow-md">
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-cyan-600" />
                Mensajes de WhatsApp ({mensajesWpp.length})
                </h3>
                <div className="flex gap-2">
                <Button
                    size="sm"
                    onClick={copiarTodos}
                    className="gap-1 bg-cyan-600 hover:bg-cyan-700 text-white"
                >
                    <Copy className="h-4 w-4" />
                    Copiar todos
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={onClose}
                    className="border-slate-300 hover:bg-slate-100"
                >
                    Cerrar
                </Button>
                </div>
            </div>
            
            <div className="space-y-2 max-h-96 overflow-y-auto">
                {mensajesWpp.map((item) => (
                <div key={item.id} className="bg-white border border-cyan-200 rounded p-3 space-y-2 shadow-sm">
                    <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-600">Pedido #{item.id}</span>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copiarMensaje(item.id, item.mensaje, item.enviado)}
                        className={`gap-1 h-7 ${
                        copiados.has(item.id) 
                            ? 'text-cyan-600 hover:text-cyan-700 bg-cyan-50' 
                            : 'text-slate-600 hover:text-slate-700'
                        }`}
                    >
                        {copiados.has(item.id) ? (
                        <>
                            <CheckCheck className="h-3 w-3" />
                            Copiado
                        </>
                        ) : (
                        <>
                            <Copy className="h-3 w-3" />
                            Copiar
                        </>
                        )}
                    </Button>
                    </div>
                    <textarea
                    value={item.mensaje}
                    onChange={(e) => actualizarMensaje(item.id, e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded resize-none focus:outline-none focus:ring-2 focus:ring-cyan-500 font-mono text-sm"
                    rows={2}
                    />
                </div>
                ))}
            </div>
        </div>
    )
}
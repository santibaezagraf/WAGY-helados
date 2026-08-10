"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ChatPanel } from "@/components/pedidos/chat-panel"

interface ChatModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** El chat es por teléfono; el pedido es opcional (puede abrirse sin pedido,
   *  p.ej. desde la campana de avisos para un cliente que aún no tiene orden). */
  telefono: string
  pedidoId?: number
}

/**
 * Chat manual en un Dialog. Es solo el envoltorio modal: todo el contenido
 * (historial, Realtime, envío, moderación, panel del pedido) vive en `ChatPanel`,
 * que también usa la vista `/conversaciones` inline (estilo WhatsApp Web).
 *
 * Cerrar el modal NO devuelve la conversación al bot: un operador puede estar en
 * el medio de una consulta que el bot no sabe manejar y una respuesta demorada
 * del cliente cerraría el chat prematuramente. La toma humana termina solo con
 * "Devolver al bot", con el envío del resumen manual, o por auto-expiración (8h).
 */
export function ChatModal({ open, onOpenChange, telefono, pedidoId }: ChatModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-[480px] h-[85vh] p-0 overflow-hidden gap-0">
        {/* El encabezado visible lo pinta ChatPanel; el DialogTitle oculto cubre
            la accesibilidad que Radix exige. */}
        <DialogTitle className="sr-only">
          {pedidoId != null ? `Pedido #${pedidoId}` : `Chat ${telefono}`}
        </DialogTitle>
        <ChatPanel telefono={telefono} pedidoId={pedidoId} activo={open} enModal />
      </DialogContent>
    </Dialog>
  )
}

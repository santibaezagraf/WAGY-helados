// Helpers para enviar mensajes a la Cloud API de WhatsApp.

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';

export async function enviarMensajeWhatsApp(numeroDestino: string, texto: string) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  try {
    const response = await fetch(`${WHATSAPP_API_URL}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: numeroDestino,
        type: "text",
        text: { body: texto }
      })
    });

    if (!response.ok) {
      console.error("Error al enviar WhatsApp:", await response.text());
    }
  } catch (error) {
    console.error("Fallo la conexión con Meta:", error);
  }
}

export type BotonReply = {
  id: string;   // identificador interno (lo recibimos de vuelta en el webhook). Max 256 chars.
  title: string; // texto visible. Max 20 chars (límite de Meta).
};

/**
 * Manda un mensaje interactivo con hasta 3 botones de respuesta rápida.
 * Cuando el cliente toca un botón, Meta nos manda al webhook un mensaje de
 * tipo "interactive" con interactive.button_reply.id = el id del botón.
 */
export async function enviarMensajeConBotones(
  numeroDestino: string,
  texto: string,
  botones: BotonReply[],
) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  if (botones.length === 0 || botones.length > 3) {
    console.error(`❌ Cantidad inválida de botones (${botones.length}). Meta acepta 1-3.`);
    return;
  }

  try {
    const response = await fetch(`${WHATSAPP_API_URL}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: numeroDestino,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: texto },
          action: {
            buttons: botones.map(b => ({
              type: "reply",
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      })
    });

    if (!response.ok) {
      console.error("Error al enviar WhatsApp con botones:", await response.text());
    }
  } catch (error) {
    console.error("Fallo la conexión con Meta:", error);
  }
}

type PedidoResumen = {
  id: number;
  cantidad_crema: number;
  cantidad_agua: number;
  observaciones: string | null;
  direccion: string;
  aclaracion: string | null;
  metodo_pago: string;
  precio_total: number | null;
};

export async function enviarResumenYPedirConfirmacion(
  numeroCliente: string,
  pedidoDB: PedidoResumen,
  esModificacion: boolean,
) {
  const detalleHelado = [
    pedidoDB.cantidad_crema > 0 ? `• Crema: ${pedidoDB.cantidad_crema}` : '',
    pedidoDB.cantidad_agua > 0 ? `• Agua: ${pedidoDB.cantidad_agua}` : '',
    pedidoDB.observaciones ? `  _Sabores: ${pedidoDB.observaciones}_` : ''
  ].filter(Boolean).join('\n');

  const detalleEnvio = pedidoDB.direccion === 'retira'
    ? '• Retira en sucursal'
    : `• Envío a: ${pedidoDB.direccion}${pedidoDB.aclaracion ? ` (${pedidoDB.aclaracion})` : ''}`;

  const mensaje = [
    esModificacion ? "*¡Pedido modificado!* Revisá que esté todo bien:" : "*¡Excelente!* Analicé tu pedido y este es el resumen:",
    "\n" + detalleHelado,
    detalleEnvio,
    `• Pago: ${pedidoDB.metodo_pago}`,
    `• *Total a pagar: $${pedidoDB.precio_total}*`,
    "\n¿La información es correcta?"
  ].join('\n');

  await enviarMensajeConBotones(numeroCliente, mensaje, [
    { id: `confirmar_borrador_${pedidoDB.id}`, title: 'Sí, confirmar' },
    { id: `modificar_borrador_${pedidoDB.id}`, title: 'No, modificar' },
  ]);

  console.log("📩 Resumen enviado al cliente con botones. Esperando respuesta...");
}

/**
 * Mensaje "¿estás seguro de cancelar?" con botones. Lo usamos tanto cuando
 * el pedido recién pasa a esperando_cancelacion como cuando el cliente nos
 * contesta ambiguo en ese estado.
 */
export async function enviarConfirmacionCancelacion(
  numeroCliente: string,
  pedidoId: number,
  texto: string = "⚠️ ¿Estás seguro de que querés cancelar tu pedido?",
) {
  await enviarMensajeConBotones(numeroCliente, texto, [
    { id: `confirmar_cancelacion_${pedidoId}`, title: 'Sí, cancelar' },
    { id: `rechazar_cancelacion_${pedidoId}`, title: 'No, mantenerlo' },
  ]);
}

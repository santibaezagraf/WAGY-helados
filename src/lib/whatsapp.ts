// Helpers para enviar mensajes a la Cloud API de WhatsApp.

export async function enviarMensajeWhatsApp(numeroDestino: string, texto: string) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
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

type PedidoResumen = {
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
    "\n¿La información es correcta? Respondé *SÍ* para confirmar el pedido o *NO* para corregir algo."
  ].join('\n');

  await enviarMensajeWhatsApp(numeroCliente, mensaje);

  console.log("📩 Resumen enviado al cliente para confirmación. Esperando respuesta...");
}

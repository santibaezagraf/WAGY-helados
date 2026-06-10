import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  // 1. Extraemos el token de la URL para seguridad
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  // Asegurate de que este string coincida exactamente con el que pusiste en el panel de Supabase
  if (token !== 'mi_secreto_supabase_123') {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  try {
    const payload = await request.json();

    // 2. Extraer los datos del Webhook de Supabase
    // Supabase envía 'type' (UPDATE, INSERT, DELETE), 'table', 'record' (datos nuevos) y 'old_record' (datos viejos)
    const { type, table, record, old_record } = payload;

    // 3. Evaluar la condición estricta
    // Solo enviamos el mensaje si pasó de borrador a pendiente Y fue accionado por el Cron (auto_confirmado = true)
    if (
      type === 'UPDATE' &&
      table === 'pedidos' &&
      old_record?.estado === 'borrador' &&
      record?.estado === 'pendiente' &&
      record?.auto_confirmado === true 
    ) {
      
      const numeroCliente = record.telefono; // Ajustalo a 'telefono_cliente' si tu columna se llama así
      
      const mensaje = "⏳ ¡Hola! Como pasaron unos minutos y no recibimos modificaciones, confirmamos tu pedido automáticamente para que no se demore. Ya lo estamos preparando en la cocina. 🍦🛵";

      await enviarMensajeWhatsApp(numeroCliente, mensaje);
      console.log(`✅ Auto-confirmación notificada a ${numeroCliente} por el pedido #${record.id}`);
    }

    // Siempre devolvemos 200 rápido para que Supabase sepa que recibimos el webhook
    return NextResponse.json({ status: 'ok' }, { status: 200 });

  } catch (error) {
    console.error('❌ Error procesando el webhook de Supabase:', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}

// Función auxiliar para enviar el mensaje (idéntica a la que tenés en el otro webhook)
async function enviarMensajeWhatsApp(numeroDestino: string, texto: string) {
  try {
    await fetch(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: numeroDestino,
        type: "text",
        text: { body: texto }
      })
    });
  } catch (e) {
    console.error("Error enviando WhatsApp desde notificación:", e);
  }
}
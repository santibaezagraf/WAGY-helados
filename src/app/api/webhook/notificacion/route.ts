import { NextResponse } from 'next/server';

// Un token simple para asegurarte de que solo Supabase pueda pegarle a esta API
const SUPABASE_WEBHOOK_SECRET = process.env.SUPABASE_WEBHOOK_SECRET || "mi_secreto_supabase_123";

export async function POST(request: Request) {
  try {
    // 1. Verificación de seguridad básica mediante un Query Parameter o Header
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');
    
    if (token !== SUPABASE_WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await request.json();
    console.log("🔔 Webhook de Supabase recibido:", body);

    // Estructura nativa de Supabase Webhooks:
    // body.type puede ser 'INSERT', 'UPDATE', 'DELETE'
    const { type, table, record, old_record } = body;

    if (table === 'pedidos' && type === 'UPDATE') {
      // 2. Detectamos si pasó estrictamente de 'borrador' a 'pendiente'
      const fueAutoConfirmado = old_record?.estado === 'borrador' && record?.estado === 'pendiente';

      if (fueAutoConfirmado) {
        const numeroCliente = record.telefono;
        const pedidoId = record.id;

        console.log(`🤖 Auto-confirmación detectada para el pedido #${pedidoId}. Notificando a ${numeroCliente}...`);

        // 3. Armamos el mensaje avisando que expiró el tiempo pero se procesó igual
        const mensajeAutoConfirmacion = 
          `¡Hola! Como no recibimos confirmación en los últimos 10 minutos, *procesamos tu pedido automáticamente* para que no se demore ni un segundo más. ⏰\n\n` +
          `Tu pedido *#${pedidoId}* ya ingresó a la cocina y lo estamos preparando. ¡Muchas gracias! 🍦`;

        await enviarMensajeWhatsApp(numeroCliente, mensajeAutoConfirmacion);
      }
    }

    // Supabase necesita recibir un 200 para saber que el webhook se procesó bien
    return NextResponse.json({ status: 'notificado' }, { status: 200 });

  } catch (error) {
    console.error("❌ Error en webhook de notificación:", error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}

// Función auxiliar para enviar el WhatsApp (la misma de tu otra ruta)
async function enviarMensajeWhatsApp(numeroDestino: string, texto: string) {
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
    if (!response.ok) console.error("Error enviando WhatsApp desde notificación:", await response.text());
  } catch (e) {
    console.error("Fallo la conexión con Meta en notificación:", e);
  }
}
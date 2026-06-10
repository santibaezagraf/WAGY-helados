import { NextResponse } from 'next/server';
import { enviarMensajeWhatsApp } from '@/lib/whatsapp';

/**
 * Receptor del Database Webhook de Supabase.
 *
 * Se dispara cuando un pedido pasa de 'borrador' a 'pendiente' con
 * auto_confirmado=true (lo hace la función auto_confirmar_borradores_silenciosos
 * agendada por pg_cron). Avisamos al cliente que su pedido se confirmó solo.
 *
 * Auth: el secret viene como ?token=... en la URL y se compara contra
 * VERIFY_TOKEN (la misma env var que ya usamos para el handshake de Meta).
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!process.env.VERIFY_TOKEN || token !== process.env.VERIFY_TOKEN) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  try {
    const payload = await request.json();
    const { type, table, record, old_record } = payload;

    if (
      type === 'UPDATE' &&
      table === 'pedidos' &&
      old_record?.estado === 'borrador' &&
      record?.estado === 'pendiente' &&
      record?.auto_confirmado === true
    ) {
      const numeroCliente = record.telefono;
      const mensaje = "⏳ ¡Hola! Como pasaron unos minutos y no recibimos modificaciones, confirmamos tu pedido automáticamente para que no se demore. Ya lo estamos preparando en la cocina. 🍦🛵";

      await enviarMensajeWhatsApp(numeroCliente, mensaje);
      console.log(`✅ Auto-confirmación notificada a ${numeroCliente} por el pedido #${record.id}`);
    }

    return NextResponse.json({ status: 'ok' }, { status: 200 });
  } catch (error) {
    console.error('❌ Error procesando el webhook de Supabase:', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}

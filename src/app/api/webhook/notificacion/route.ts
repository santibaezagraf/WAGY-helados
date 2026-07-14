import { NextResponse } from 'next/server';
import { enviarMensajeWhatsApp } from '@/lib/whatsapp';
import { cronAutorizado } from '@/lib/auth-cron';

/**
 * Receptor del Database Webhook de Supabase.
 *
 * Se dispara cuando un pedido pasa de 'borrador' a 'pendiente' con
 * auto_confirmado=true (lo hacía la vieja auto-confirmación). Esa función se
 * eliminó y nada setea ya `auto_confirmado`, así que este endpoint es
 * vestigial (queda por filas viejas); se puede desactivar el DB webhook y
 * borrarlo. Mientras exista, va protegido igual.
 *
 * Auth: header `Authorization: Bearer <CRON_SECRET>` (ver auth-cron.ts). El DB
 * webhook de Supabase permite configurar headers HTTP custom.
 */
export async function POST(request: Request) {
  if (!cronAutorizado(request)) {
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

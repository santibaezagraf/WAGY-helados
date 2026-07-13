import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { enviarMensajeWhatsApp, enviarMensajeConBotones } from '@/lib/whatsapp';
import { marcarHistorialDescartado } from '@/lib/bot/procesar';
import {
  decidirAccionBorrador,
  esBorradorCompleto,
  AUTO_RECHAZO_HORAS,
  RECORDATORIO_SILENCIO_MIN,
} from '@/lib/bot/borradores';

/**
 * Gestión de borradores silenciosos. Reemplaza a la vieja auto-confirmación
 * (pg_cron `auto_confirmar_borradores_silenciosos`, eliminada por migración):
 * un pedido NUNCA se confirma solo — la política nueva es insistir y, si el
 * cliente sigue sin responder, cancelarlo.
 *
 *  1. RECORDATORIO: borradores con >= RECORDATORIO_SILENCIO_MIN de silencio del
 *     cliente y sin recordatorio previo → "¿Seguís ahí?" con los mismos botones
 *     del resumen (confirmar_borrador_{id} / modificar_borrador_{id}, los
 *     resuelve el webhook sin LLM). `recordatorio_enviado` se marca solo si el
 *     envío salió bien (si Meta está caído, el próximo tick reintenta) y se
 *     re-arma en false cada vez que se manda un resumen nuevo.
 *
 *  2. AUTO-RECHAZO: borradores con más de AUTO_RECHAZO_HORAS sin confirmar →
 *     estado='cancelado' con auto_rechazado=true, aviso al cliente y descarte
 *     del historial (misma limpieza que una cancelación explícita).
 *
 * Ambos pasos saltean teléfonos con mensajes sin procesar (hay un wake-up de
 * QStash en vuelo: ese flow decide, no le pisamos el resultado).
 *
 * Auth: ?token=... comparado contra VERIFY_TOKEN, igual que /api/reenviar-resumenes.
 *
 * Programación (pg_cron + pg_net en Supabase, manual como el reenvío de resúmenes).
 * OJO: la expresión cron es cada 5 minutos, SIN el espacio entre * y / — acá va
 * separado solo porque el literal cerraría este comentario de JS:
 *   select cron.schedule(
 *     'gestionar-borradores', '* /5 * * * *',
 *     $$ select net.http_post(
 *          url := 'https://TU-APP/api/gestionar-borradores?token=EL_VERIFY_TOKEN',
 *          headers := '{"Content-Type":"application/json"}'::jsonb,
 *          body := '{}'::jsonb) $$
 *   );
 */

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Los umbrales (RECORDATORIO_SILENCIO_MIN, AUTO_RECHAZO_HORAS,
// AVISO_CANCELACION_HORAS) y la decisión por borrador viven en
// src/lib/bot/borradores.ts, que es puro y está testeado.

const MENSAJE_RECORDATORIO =
  '⏰ ¿Seguís ahí? Tu pedido quedó esperando confirmación. Si no me respondés, en unas horas se cancela solo 🙏';
const MENSAJE_AUTO_RECHAZO =
  'Como no confirmaste tu pedido, lo cancelamos para no mandarte nada por error. Si lo seguís queriendo, escribime y lo armamos de nuevo 🍦';

/** true si el cliente escribió hace menos de RECORDATORIO_SILENCIO_MIN. */
async function clienteActivoReciente(telefono: string): Promise<boolean> {
  const desde = new Date(Date.now() - RECORDATORIO_SILENCIO_MIN * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from('mensajes_chat')
    .select('id')
    .eq('telefono', telefono)
    .eq('rol', 'cliente')
    .gte('created_at', desde)
    .limit(1);
  return Boolean(data && data.length > 0);
}

/** true si hay mensajes sin procesar (wake-up de QStash en vuelo). */
async function hayMensajesEnVuelo(telefono: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('mensajes_chat')
    .select('id')
    .eq('telefono', telefono)
    .eq('rol', 'cliente')
    .eq('procesado', false)
    .limit(1);
  return Boolean(data && data.length > 0);
}

async function gestionarBorradores() {
  const ahora = Date.now();

  const { data: borradores, error } = await supabaseAdmin
    .from('pedidos')
    .select('id, telefono, created_at, recordatorio_enviado, direccion, metodo_pago, cantidad_agua, cantidad_crema')
    .eq('estado', 'borrador');

  if (error) {
    console.error('❌ Error consultando borradores:', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }

  let recordados = 0;
  let cancelados = 0;

  for (const p of borradores ?? []) {
    const decision = decidirAccionBorrador({
      msDesdeCreacion: ahora - new Date(p.created_at).getTime(),
      esCompleto: esBorradorCompleto(p),
      recordatorioEnviado: p.recordatorio_enviado,
      clienteActivoReciente: await clienteActivoReciente(p.telefono),
      hayMensajesEnVuelo: await hayMensajesEnVuelo(p.telefono),
    });

    if (decision.accion === 'recordar') {
      const ok = await enviarMensajeConBotones(p.telefono, MENSAJE_RECORDATORIO, [
        { id: `confirmar_borrador_${p.id}`, title: 'Sí, confirmar' },
        { id: `modificar_borrador_${p.id}`, title: 'No, modificar' },
      ]);
      if (ok) {
        await supabaseAdmin
          .from('pedidos')
          .update({ recordatorio_enviado: true })
          .eq('id', p.id);
        recordados++;
      }
    } else if (decision.accion === 'rechazar') {
      // Guard sobre el estado: si el cliente confirmó/canceló entre el read y
      // acá, el UPDATE afecta 0 filas y no hacemos nada.
      const { data: cancelado } = await supabaseAdmin
        .from('pedidos')
        .update({ estado: 'cancelado', auto_rechazado: true })
        .eq('id', p.id)
        .eq('estado', 'borrador')
        .select('id')
        .maybeSingle();
      if (!cancelado) continue;

      cancelados++;
      if (decision.avisarCliente) {
        await enviarMensajeWhatsApp(p.telefono, MENSAJE_AUTO_RECHAZO);
      }
      await marcarHistorialDescartado(p.telefono);
      console.log(`🚫 Borrador ${p.id} auto-rechazado por silencio de ${AUTO_RECHAZO_HORAS}h.`);
    }
  }

  console.log(`🧹 Gestión de borradores: ${recordados} recordatorio(s), ${cancelados} auto-rechazo(s).`);
  return NextResponse.json({ status: 'ok', recordados, cancelados });
}

export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('token');
  if (!process.env.VERIFY_TOKEN || token !== process.env.VERIFY_TOKEN) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  return gestionarBorradores();
}

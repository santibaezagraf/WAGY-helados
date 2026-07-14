import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { enviarMensajeWhatsApp, enviarMensajeConBotones } from '@/lib/whatsapp';
import { marcarHistorialDescartado } from '@/lib/bot/procesar';
import { cronAutorizado } from '@/lib/auth-cron';

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
 * Auth: header `Authorization: Bearer <CRON_SECRET>` (ver auth-cron.ts).
 *
 * Programación (pg_cron + pg_net en Supabase, manual como el reenvío de resúmenes).
 * OJO: la expresión cron es cada 5 minutos, SIN el espacio entre * y / — acá va
 * separado solo porque el literal cerraría este comentario de JS:
 *   select cron.schedule(
 *     'gestionar-borradores', '* /5 * * * *',
 *     $$ select net.http_post(
 *          url := 'https://TU-APP/api/gestionar-borradores',
 *          headers := '{"Content-Type":"application/json","Authorization":"Bearer EL_CRON_SECRET"}'::jsonb,
 *          body := '{}'::jsonb) $$
 *   );
 */

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Minutos de silencio del cliente antes de mandar el "¿seguís ahí?". Mismo
// umbral que usaba la vieja auto-confirmación.
const RECORDATORIO_SILENCIO_MIN = 20;
// Horas sin confirmar tras las cuales el borrador se cancela solo.
const AUTO_RECHAZO_HORAS = 6;
// Solo avisamos la cancelación de borradores razonablemente recientes: a un
// zombie de días no tiene sentido escribirle (y Meta rechaza fuera de la
// ventana de 24h igual). El pedido se cancela en DB de todos modos.
const AVISO_CANCELACION_HORAS = 12;

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
  const limiteRechazo = new Date(ahora - AUTO_RECHAZO_HORAS * 60 * 60 * 1000).toISOString();
  const limiteAviso = new Date(ahora - AVISO_CANCELACION_HORAS * 60 * 60 * 1000).toISOString();

  // ── 1. Recordatorios ──────────────────────────────────────────────────────
  // Solo recordamos borradores COMPLETOS: un borrador parcial (armado a medias)
  // usa '' de placeholder en direccion/metodo_pago y todavía le falta un dato,
  // así que ofrecerle el botón "confirmar" no tendría sentido. El flujo del bot
  // ya le pidió lo que falta; si igual queda mudo, el auto-rechazo lo limpia.
  const { data: candidatos, error: errorCandidatos } = await supabaseAdmin
    .from('pedidos')
    .select('id, telefono')
    .eq('estado', 'borrador')
    .eq('recordatorio_enviado', false)
    .neq('direccion', '')
    .neq('metodo_pago', '')
    .or('cantidad_agua.gt.0,cantidad_crema.gt.0')
    .gte('created_at', limiteRechazo); // los más viejos van directo al paso 2

  if (errorCandidatos) {
    console.error('❌ Error consultando borradores para recordatorio:', errorCandidatos);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }

  let recordados = 0;
  for (const p of candidatos ?? []) {
    if (await clienteActivoReciente(p.telefono)) continue;
    if (await hayMensajesEnVuelo(p.telefono)) continue;

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
  }

  // ── 2. Auto-rechazo ───────────────────────────────────────────────────────
  const { data: vencidos, error: errorVencidos } = await supabaseAdmin
    .from('pedidos')
    .select('id, telefono, created_at')
    .eq('estado', 'borrador')
    .lt('created_at', limiteRechazo);

  if (errorVencidos) {
    console.error('❌ Error consultando borradores vencidos:', errorVencidos);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }

  let cancelados = 0;
  for (const p of vencidos ?? []) {
    if (await hayMensajesEnVuelo(p.telefono)) continue;

    // Guard sobre el estado: si el cliente confirmó/canceló entre el read y acá,
    // el UPDATE afecta 0 filas y no hacemos nada.
    const { data: cancelado } = await supabaseAdmin
      .from('pedidos')
      .update({ estado: 'cancelado', auto_rechazado: true })
      .eq('id', p.id)
      .eq('estado', 'borrador')
      .select('id')
      .maybeSingle();
    if (!cancelado) continue;

    cancelados++;
    if (p.created_at >= limiteAviso) {
      await enviarMensajeWhatsApp(p.telefono, MENSAJE_AUTO_RECHAZO);
    }
    await marcarHistorialDescartado(p.telefono);
    console.log(`🚫 Borrador ${p.id} auto-rechazado por silencio de ${AUTO_RECHAZO_HORAS}h.`);
  }

  console.log(`🧹 Gestión de borradores: ${recordados} recordatorio(s), ${cancelados} auto-rechazo(s).`);
  return NextResponse.json({ status: 'ok', recordados, cancelados });
}

export async function POST(request: Request) {
  if (!cronAutorizado(request)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  return gestionarBorradores();
}

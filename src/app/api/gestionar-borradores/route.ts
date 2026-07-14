import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { enviarMensajeWhatsApp, enviarMensajeConBotones } from '@/lib/whatsapp';
import { marcarHistorialDescartado, pedirDatosFaltantes, procesarMensajesDeCliente } from '@/lib/bot/procesar';
import {
  decidirAccionBorrador,
  decidirAccionEsperandoCancelacion,
  esBorradorCompleto,
  AUTO_RECHAZO_HORAS,
  CANCELACION_SILENCIO_HORAS,
} from '@/lib/bot/borradores';

/**
 * Gestión de borradores silenciosos. Reemplaza a la vieja auto-confirmación
 * (pg_cron `auto_confirmar_borradores_silenciosos`, eliminada por migración):
 * un pedido NUNCA se confirma solo — la política nueva es insistir y, si el
 * cliente sigue sin responder, cancelarlo.
 *
 *  1. RECORDATORIO: borradores sin recordatorio previo y con suficiente silencio
 *     del cliente. Según esté completo o parcial:
 *       - COMPLETO (>= RECORDATORIO_SILENCIO_MIN): "¿Seguís ahí?" con los mismos
 *         botones del resumen (confirmar_borrador_{id} / modificar_borrador_{id},
 *         los resuelve el webhook sin LLM).
 *       - PARCIAL (>= RECORDATORIO_PARCIAL_SILENCIO_MIN): re-pide el dato que
 *         falta vía pedirDatosFaltantes (botones de pago / pedido de dirección /
 *         texto), porque a un parcial no hay nada que "confirmar" todavía.
 *     `recordatorio_enviado` se marca solo si el envío salió bien (si Meta está
 *     caído, el próximo tick reintenta) y se re-arma en false cada vez que se
 *     manda un resumen nuevo (o sea, cuando el borrador se completa). Ambos
 *     recordatorios son one-shot.
 *
 *  2. AUTO-RECHAZO: borradores cuyo CLIENTE lleva más de AUTO_RECHAZO_HORAS
 *     callado → estado='cancelado' con auto_rechazado=true, aviso al cliente y
 *     descarte del historial (misma limpieza que una cancelación explícita).
 *     Se mide el silencio, NO la edad del borrador: un 'pendiente' viejo recién
 *     modificado vuelve a 'borrador' con su created_at original, y medir por
 *     edad lo cancelaba a los minutos con el cliente activo.
 *
 *  0. BARRIDO DE HUÉRFANOS: si el publish a QStash falló en el webhook, el
 *     mensaje quedó procesado=false para siempre — el cliente no recibe
 *     respuesta y los pasos de abajo saltean su teléfono por "wake-up en
 *     vuelo". Acá rescatamos los pendientes con más de BARRIDO_PENDIENTES_MIN
 *     llamando al mismo flow del consumer. Es seguro frente a un wake-up real
 *     simultáneo: el defer espera silencio y el claim atómico deduplica.
 *
 *  3. CANCELACIÓN COLGADA: pedidos en 'esperando_cancelacion' cuyo cliente
 *     lleva >= CANCELACION_SILENCIO_HORAS sin escribir → se RESPETA el pedido
 *     de cancelación (estado='cancelado') aunque nunca haya confirmado el
 *     "¿estás seguro?". La última indicación fue cancelar; entregarle algo que
 *     creía cancelado es peor que no entregarle. Sin esto, el pedido quedaba
 *     trabado para siempre en un estado invisible (fuera de la ventana de 12h
 *     de pedidoActivo y del filtro default del dashboard).
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
const MENSAJE_CANCELACION_POR_SILENCIO =
  'Como pediste cancelar y no volviste a responder, dimos de baja tu pedido ✅ Si querés pedir de nuevo, escribime y lo armamos 🍦';

// Edad mínima de un mensaje pendiente para considerarlo huérfano (su wake-up
// de QStash nunca va a llegar). Bien mayor al debounce de 8s del webhook para
// no pisar wake-ups legítimos que todavía están en vuelo.
const BARRIDO_PENDIENTES_MIN = 5;

/**
 * Rescata mensajes de cliente que quedaron procesado=false sin wake-up (falló
 * el publish a QStash). Delegamos en procesarMensajesDeCliente, que ya trae
 * toda la seguridad: si el cliente está tipeando ahora, el defer difiere; si
 * un wake-up real dispara a la vez, el claim atómico deduplica; y los gates de
 * atención humana aplican igual que siempre. Devuelve cuántos teléfonos barrió.
 */
async function barrerPendientesHuerfanos(): Promise<number> {
  const limite = new Date(Date.now() - BARRIDO_PENDIENTES_MIN * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('mensajes_chat')
    .select('telefono')
    .eq('rol', 'cliente')
    .eq('procesado', false)
    .lt('created_at', limite)
    .not('telefono', 'is', null)
    .limit(200);

  if (error) {
    console.error('❌ Error buscando mensajes pendientes huérfanos:', error);
    return 0;
  }

  const telefonos = [...new Set((data ?? []).map((r) => r.telefono as string))];

  for (const telefono of telefonos) {
    console.log(`🛟 Rescatando mensajes pendientes huérfanos de ${telefono} (wake-up perdido).`);
    try {
      await procesarMensajesDeCliente(telefono);
    } catch (e) {
      // Un teléfono que falla no debe frenar el resto del barrido ni del cron.
      console.error(`❌ Error rescatando pendientes de ${telefono}:`, e);
    }
  }

  return telefonos.length;
}

/**
 * Timestamp (ms) del último mensaje del cliente, o null si no hay ninguno.
 * Sin filtrar `descartado`: para medir silencio cuenta cualquier actividad.
 */
async function ultimoMensajeClienteMs(telefono: string): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from('mensajes_chat')
    .select('created_at')
    .eq('telefono', telefono)
    .eq('rol', 'cliente')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? new Date(data.created_at).getTime() : null;
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

  // 0. Rescatar mensajes con wake-up perdido ANTES de decidir sobre borradores:
  //    así el estado que leen los pasos siguientes ya incorpora esas respuestas
  //    (y hayMensajesEnVuelo deja de saltear el teléfono para siempre).
  const rescatados = await barrerPendientesHuerfanos();

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
    const ultimoMs = await ultimoMensajeClienteMs(p.telefono);
    const decision = decidirAccionBorrador({
      msDesdeCreacion: ahora - new Date(p.created_at).getTime(),
      esCompleto: esBorradorCompleto(p),
      recordatorioEnviado: p.recordatorio_enviado,
      msSilencioCliente: ultimoMs === null ? null : ahora - ultimoMs,
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
    } else if (decision.accion === 'recordar_parcial') {
      // Borrador parcial abandonado: en vez de "confirmar/modificar" (no hay
      // nada que confirmar) re-pedimos el dato que falta. Mismos placeholders
      // '' que usa el flujo en vivo → misma detección de faltantes.
      const faltaCantidad = !(p.cantidad_agua > 0 || p.cantidad_crema > 0);
      const faltaDireccion = !p.direccion;
      const faltaPago = !p.metodo_pago;
      const ok = await pedirDatosFaltantes(p.telefono, faltaCantidad, faltaDireccion, faltaPago);
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

  // 3. Cancelaciones colgadas: respetar el "cancelar" nunca confirmado.
  let canceladosPorSilencio = 0;

  const { data: esperando, error: errorEsperando } = await supabaseAdmin
    .from('pedidos')
    .select('id, telefono, created_at')
    .eq('estado', 'esperando_cancelacion');

  if (errorEsperando) {
    console.error('❌ Error consultando pedidos en esperando_cancelacion:', errorEsperando);
  }

  for (const p of esperando ?? []) {
    // El pedido de cancelación siempre fue un mensaje del cliente (texto o
    // botón), así que "silencio desde su último mensaje" acota por arriba el
    // tiempo que lleva sin contestar el "¿estás seguro?". Si no hay mensajes
    // (raro), caemos a la edad del pedido.
    const ultimoMs = await ultimoMensajeClienteMs(p.telefono);
    const decision = decidirAccionEsperandoCancelacion({
      msSilencioCliente: ahora - (ultimoMs ?? new Date(p.created_at).getTime()),
      hayMensajesEnVuelo: await hayMensajesEnVuelo(p.telefono),
    });

    if (decision.accion !== 'cancelar') continue;

    // Guard de estado: si el cliente respondió o el flow lo movió entre el
    // read y acá, el UPDATE afecta 0 filas y no hacemos nada.
    const { data: cancelado } = await supabaseAdmin
      .from('pedidos')
      .update({ estado: 'cancelado' })
      .eq('id', p.id)
      .eq('estado', 'esperando_cancelacion')
      .select('id')
      .maybeSingle();
    if (!cancelado) continue;

    canceladosPorSilencio++;
    if (decision.avisarCliente) {
      await enviarMensajeWhatsApp(p.telefono, MENSAJE_CANCELACION_POR_SILENCIO);
    }
    await marcarHistorialDescartado(p.telefono);
    console.log(`🚫 Pedido ${p.id} cancelado: pidió cancelar y lleva ${CANCELACION_SILENCIO_HORAS}h+ sin confirmar.`);
  }

  console.log(`🧹 Gestión de borradores: ${rescatados} rescatado(s), ${recordados} recordatorio(s), ${cancelados} auto-rechazo(s), ${canceladosPorSilencio} cancelación(es) colgada(s).`);
  return NextResponse.json({ status: 'ok', rescatados, recordados, cancelados, canceladosPorSilencio });
}

export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('token');
  if (!process.env.VERIFY_TOKEN || token !== process.env.VERIFY_TOKEN) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  return gestionarBorradores();
}

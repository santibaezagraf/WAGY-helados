import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { cronAutorizado } from '@/lib/auth-cron';

/**
 * Retención del bucket `whatsapp-media`.
 *
 * Cada media entrante (imagen/audio/video/documento/sticker) se descarga y
 * se guarda en el bucket privado `whatsapp-media`. Sin retención, el storage
 * crece indefinidamente aunque los mensajes viejos ya no le importen a nadie
 * (pedidos cerrados hace semanas). Este endpoint borra archivos cuyos
 * `mensajes_chat` asociados son más viejos que `RETENCION_DIAS` (60).
 *
 * Estrategia:
 *  1. Buscamos filas `mensajes_chat` con `media_path` no nulo y
 *     `created_at < now - 60d`.
 *  2. Borramos esos paths del bucket en lotes.
 *  3. Limpiamos `media_path` en las filas correspondientes (el mensaje queda
 *     en la base como registro histórico; solo se pierde el archivo).
 *
 * NO borramos las filas de mensajes_chat: son parte del historial del
 * cliente. Solo se pierde el archivo asociado, que a esa altura ya no le
 * sirve a nadie (el operador que iba a mirarlo tenía 60 días).
 *
 * Auth: header `Authorization: Bearer <CRON_SECRET>` (ver auth-cron.ts).
 *
 * Programación sugerida (pg_cron + pg_net, semanal — no diario, para no
 * gastar el budget del cron y porque la ganancia es acumulativa):
 *   select cron.schedule(
 *     'limpiar-storage-whatsapp-media', '0 4 * * 0',
 *     $$ select net.http_post(
 *          url := 'https://TU-APP/api/limpiar-storage',
 *          headers := '{"Content-Type":"application/json","Authorization":"Bearer EL_CRON_SECRET"}'::jsonb,
 *          body := '{}'::jsonb) $$
 *   );
 */

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MEDIA_BUCKET = 'whatsapp-media';
const RETENCION_DIAS = 60;
// Batching: la API de storage acepta remover múltiples paths en un solo call.
// 100 es holgado y evita URLs enormes si el bucket viene muy cargado.
const LOTE_BORRADO = 100;
// Cota por corrida para no saturar el timeout de la función serverless
// (Vercel free/pro tiene 60s por función). En régimen la cola es chica; el
// primer barrido histórico puede necesitar varias corridas seguidas, ok.
const MAX_POR_CORRIDA = 2000;

async function limpiarStorage() {
  const limite = new Date(Date.now() - RETENCION_DIAS * 24 * 60 * 60 * 1000).toISOString();

  const { data: filas, error } = await supabaseAdmin
    .from('mensajes_chat')
    .select('id, media_path')
    .not('media_path', 'is', null)
    .lt('created_at', limite)
    .limit(MAX_POR_CORRIDA);

  if (error) {
    console.error('❌ Error buscando media a limpiar:', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }

  if (!filas || filas.length === 0) {
    return NextResponse.json({ status: 'ok', borrados: 0, revisados: 0 });
  }

  // TS: media_path se filtró como .not(...is null), pero el tipo sigue
  // string | null hasta que hagamos el narrow explícito.
  const paths = filas
    .map((f) => f.media_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);

  let borrados = 0;
  for (let i = 0; i < paths.length; i += LOTE_BORRADO) {
    const lote = paths.slice(i, i + LOTE_BORRADO);
    const { error: errBorrado } = await supabaseAdmin.storage
      .from(MEDIA_BUCKET)
      .remove(lote);
    if (errBorrado) {
      console.error(`⚠️ Error borrando lote ${i / LOTE_BORRADO + 1}:`, errBorrado);
      // No cortamos: seguimos con los otros lotes. El storage puede rechazar
      // paths que ya no existen (por una corrida previa que borró pero no
      // limpió media_path) y esos casos no deben tirar todo abajo.
      continue;
    }
    borrados += lote.length;
  }

  // Limpiamos media_path en las filas que efectivamente barrimos, así en la
  // próxima corrida no vuelven a aparecer. Si un lote falló arriba, esas
  // filas van a reintentarse en el próximo tick, que es lo que queremos.
  const idsExitosos = filas
    .filter((f) => typeof f.media_path === 'string' && f.media_path.length > 0)
    .map((f) => f.id);
  if (idsExitosos.length > 0) {
    const { error: errUpdate } = await supabaseAdmin
      .from('mensajes_chat')
      .update({ media_path: null })
      .in('id', idsExitosos);
    if (errUpdate) {
      console.error('⚠️ Error limpiando media_path tras borrar:', errUpdate);
    }
  }

  console.log(`🧹 Limpieza de storage: ${borrados}/${paths.length} archivos borrados (retención=${RETENCION_DIAS}d).`);
  return NextResponse.json({ status: 'ok', borrados, revisados: paths.length });
}

export async function POST(request: Request) {
  if (!cronAutorizado(request)) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  return limpiarStorage();
}

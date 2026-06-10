import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Client as QStashClient } from '@upstash/qstash';
import { Database } from '@/types/supabase';

// 1. GET: Meta usa esto una sola vez para verificar que la URL es tuya
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ WEBHOOK VERIFICADO POR META!');
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: 'Token inválido' }, { status: 403 });
}

// Server-only Supabase client con service role
const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN! });

// Cuántos segundos esperamos antes de procesar (debounce: el cliente puede
// seguir escribiendo). Cada mensaje agenda su propio wake-up.
const DEBOUNCE_SECONDS = 8;

/**
 * POST: Recibe los mensajes de WhatsApp.
 *
 * Esta función NO procesa nada. Solo:
 *   1. Guarda el mensaje en la BD (con idempotencia vía wa_message_id).
 *   2. Agenda un wake-up en QStash con delay de 8s.
 *   3. Devuelve 200 al toque para que Meta no reintente.
 *
 * Toda la lógica del bot vive en /api/procesar-pendientes, que QStash llama
 * 8 segundos después. Si llegan varios mensajes seguidos, todos agendan
 * wake-ups, pero el primer wake-up que dispare hace un "claim" atómico de
 * todos los mensajes pendientes; los siguientes salen sin hacer nada.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body.object !== 'whatsapp_business_account') {
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
    }

    const entry = body.entry?.[0];
    const message = entry?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return NextResponse.json({ status: 'no_message' }, { status: 200 });
    }

    // Manejo de mensajes que no son de texto (audio, imagen, sticker, etc.)
    if (message.type !== 'text') {
      console.log(`📎 Mensaje no-texto recibido (tipo: ${message.type}). Ignorando.`);
      return NextResponse.json({ status: 'unsupported_type' }, { status: 200 });
    }

    let numeroCliente: string = message.from;
    if (numeroCliente.startsWith("549")) {
      numeroCliente = "54" + numeroCliente.slice(3);
    }
    const waMessageId: string | undefined = message.id;

    // Validación de largo: ignoramos vacíos y truncamos textos muy largos.
    // El máximo de WhatsApp es 4096 chars; para un bot de heladería, mensajes
    // por encima de 1000 son casi seguro spam/copy-paste y queman tokens al pedo.
    const MAX_LARGO_MENSAJE = 1000;
    const rawTexto = (message.text?.body ?? '').trim();

    if (!rawTexto) {
      console.log(`⚠️ Mensaje vacío de ${numeroCliente}. Ignorando.`);
      return NextResponse.json({ status: 'empty_message' }, { status: 200 });
    }

    let textoMensaje = rawTexto;
    if (textoMensaje.length > MAX_LARGO_MENSAJE) {
      console.warn(`✂️ Mensaje de ${numeroCliente} excede ${MAX_LARGO_MENSAJE} chars (${textoMensaje.length}). Truncando.`);
      textoMensaje = textoMensaje.slice(0, MAX_LARGO_MENSAJE);
    }

    console.log(`📩 Recibido de ${numeroCliente}: "${textoMensaje}" (wa_id: ${waMessageId})`);

    // 1. Insert con idempotencia: si Meta reintenta, el unique index en
    //    wa_message_id devuelve 23505 y cortamos sin volver a procesar.
    const { error: insertError } = await supabaseAdmin
      .from('mensajes_chat')
      .insert([{
        telefono: numeroCliente,
        texto: textoMensaje,
        wa_message_id: waMessageId,
      }]);

    if (insertError) {
      if (insertError.code === '23505') {
        console.log(`⏭️ Mensaje duplicado de Meta (wa_id: ${waMessageId}). Ignorando reintento.`);
        return NextResponse.json({ status: 'duplicate_ignored' }, { status: 200 });
      }
      console.error("Error al guardar el mensaje:", insertError);
      return NextResponse.json({ status: 'error' }, { status: 200 });
    }

    // 2. Agendar el wake-up en QStash. Cada mensaje agenda el suyo. El primer
    //    wake-up que dispare se lleva todos los mensajes pendientes con un
    //    UPDATE...RETURNING atómico; los siguientes encuentran 0 filas y salen.
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL}`;
    try {
      await qstash.publishJSON({
        url: `${baseUrl}/api/procesar-pendientes`,
        delay: DEBOUNCE_SECONDS,
        body: { telefono: numeroCliente },
      });
      console.log(`⏰ Wake-up agendado en QStash para ${numeroCliente} en ${DEBOUNCE_SECONDS}s.`);
    } catch (qstashError) {
      console.error("❌ Error al agendar wake-up en QStash:", qstashError);
      // No devolvemos error: el mensaje ya está guardado. Otro wake-up futuro
      // (o uno de un mensaje siguiente) lo va a barrer.
    }

    // 3. Responder 200 inmediatamente
    return NextResponse.json({ status: 'ok' }, { status: 200 });

  } catch (error) {
    console.error('❌ Error en webhook:', error);
    // Devolvemos 200 igual para que Meta no nos bloquee
    return NextResponse.json({ status: 'error_interno' }, { status: 200 });
  }
}

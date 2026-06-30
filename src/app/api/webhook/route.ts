import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Client as QStashClient } from '@upstash/qstash';
import { Database } from '@/types/supabase';
import { ejecutarBoton, parsearBotonId } from '@/lib/bot/botones';
import { enviarMensajeWhatsApp } from '@/lib/whatsapp';

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

console.log(`🔧 Webhook arrancado con WHATSAPP_PHONE_ID=${process.env.WHATSAPP_PHONE_ID}`);

// Cuántos segundos esperamos antes de procesar (debounce: el cliente puede
// seguir escribiendo). Cada mensaje agenda su propio wake-up.
const DEBOUNCE_SECONDS = 8;

// Normalización del número argentino: Meta nos manda "549..." pero internamente
// lo guardamos sin el 9 para alinearnos con lo que muestran las apps.
function normalizarNumero(numero: string): string {
  if (numero.startsWith("549")) return "54" + numero.slice(3);
  return numero;
}

// Texto humano para informar el tipo de mensaje no soportado.
function nombreLegibleTipo(tipo: string): string {
  const mapa: Record<string, string> = {
    audio: "audios",
    image: "imágenes",
    video: "videos",
    sticker: "stickers",
    document: "documentos",
    location: "ubicaciones",
    contacts: "contactos",
  };
  return mapa[tipo] ?? `mensajes de tipo "${tipo}"`;
}

/**
 * POST: Recibe los mensajes de WhatsApp.
 *
 * Dos caminos según el tipo de mensaje:
 *
 *  - Texto: guarda el mensaje y agenda un wake-up en QStash (8s). Toda la
 *    lógica vive en /api/procesar-pendientes.
 *
 *  - Interactive (botón): la intención del cliente está codificada en el
 *    button_id, así que NO necesitamos pasar por Groq. Guardamos el mensaje
 *    con procesado=true (para que el consumer lo ignore si llegara a verlo)
 *    y ejecutamos la acción directamente. Respuesta instantánea para el
 *    cliente y 0 tokens.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body.object !== 'whatsapp_business_account') {
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
    }

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      return NextResponse.json({ status: 'no_message' }, { status: 200 });
    }

    const numeroCliente = normalizarNumero(message.from);
    const waMessageId: string | undefined = message.id;

    if (message.type === 'interactive') {
      return await manejarInteractivo(message, numeroCliente, waMessageId);
    }

    if (message.type === 'text') {
      return await manejarTexto(message, numeroCliente, waMessageId);
    }

    // Cualquier otro tipo (audio, image, sticker, video, location, document, etc.):
    // le avisamos al cliente que solo entendemos texto, pero NO insertamos en
    // mensajes_chat ni publicamos QStash — los mensajes de texto del mismo batch
    // ya están agendando sus propios wake-ups y el debounce los junta.
    console.log(`📎 Mensaje no soportado (tipo: ${message.type}) de ${numeroCliente}. Avisando al cliente.`);
    await enviarMensajeWhatsApp(
      numeroCliente,
      `Por ahora solo puedo leer mensajes de texto, no entiendo ${nombreLegibleTipo(message.type)}. Escribime así te ayudo con tu pedido. 🙏`,
    );
    return NextResponse.json({ status: 'unsupported_type' }, { status: 200 });

  } catch (error) {
    console.error('❌ Error en webhook:', error);
    // Devolvemos 200 igual para que Meta no nos bloquee
    return NextResponse.json({ status: 'error_interno' }, { status: 200 });
  }
}

async function manejarTexto(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  numeroCliente: string,
  waMessageId: string | undefined,
) {
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

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

async function manejarInteractivo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  numeroCliente: string,
  waMessageId: string | undefined,
) {
  const buttonReply = message.interactive?.button_reply;
  if (message.interactive?.type !== 'button_reply' || !buttonReply) {
    console.log(`📎 Mensaje interactive no soportado (subtipo: ${message.interactive?.type}). Ignorando.`);
    return NextResponse.json({ status: 'unsupported_interactive' }, { status: 200 });
  }

  const buttonId: string = buttonReply.id;
  const buttonTitle: string = buttonReply.title;
  console.log(`🔘 Click de botón de ${numeroCliente}: id="${buttonId}", title="${buttonTitle}"`);

  const parsed = parsearBotonId(buttonId);
  if (!parsed) {
    console.warn(`⚠️ Button id desconocido "${buttonId}". Lo guardo como texto para que el flow lo trate.`);
    // Fallback: si el id no matchea nuestras acciones (botón viejo o externo),
    // tratamos el click como un mensaje de texto con el title del botón. El
    // pipeline normal lo va a procesar como cualquier respuesta de cliente.
    return await guardarComoTextoYAgendar(numeroCliente, buttonTitle, waMessageId);
  }

  // Insert con idempotencia + procesado=true: el consumer no debe tocarlo.
  // El title visible queda como texto del mensaje (lo que el cliente "dijo").
  const { error: insertError } = await supabaseAdmin
    .from('mensajes_chat')
    .insert([{
      telefono: numeroCliente,
      texto: buttonTitle,
      wa_message_id: waMessageId,
      procesado: true,
    }]);

  if (insertError) {
    if (insertError.code === '23505') {
      console.log(`⏭️ Click duplicado de Meta (wa_id: ${waMessageId}). Ignorando reintento.`);
      return NextResponse.json({ status: 'duplicate_ignored' }, { status: 200 });
    }
    console.error("Error al guardar el click de botón:", insertError);
    // Seguimos con la acción igual: el log es secundario.
  }

  await ejecutarBoton(numeroCliente, parsed.accion, parsed.pedidoId);
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

// Helper para el fallback del botón desconocido: tratar el click como texto.
async function guardarComoTextoYAgendar(
  numeroCliente: string,
  texto: string,
  waMessageId: string | undefined,
) {
  const { error: insertError } = await supabaseAdmin
    .from('mensajes_chat')
    .insert([{
      telefono: numeroCliente,
      texto,
      wa_message_id: waMessageId,
    }]);

  if (insertError) {
    if (insertError.code === '23505') {
      return NextResponse.json({ status: 'duplicate_ignored' }, { status: 200 });
    }
    console.error("Error al guardar fallback de botón:", insertError);
    return NextResponse.json({ status: 'error' }, { status: 200 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL}`;
  try {
    await qstash.publishJSON({
      url: `${baseUrl}/api/procesar-pendientes`,
      delay: DEBOUNCE_SECONDS,
      body: { telefono: numeroCliente },
    });
  } catch (qstashError) {
    console.error("❌ Error al agendar wake-up en QStash (fallback botón):", qstashError);
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

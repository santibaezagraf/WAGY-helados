import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Client as QStashClient } from '@upstash/qstash';
import { Database } from '@/types/supabase';
import { ejecutarBoton, parsearBotonId } from '@/lib/bot/botones';
import { enviarMensajeWhatsApp, descargarYGuardarMedia } from '@/lib/whatsapp';
import { atencionHumanaActiva, marcarRequiereAtencion } from '@/lib/bot/atencion-humana';
import { verificarFirmaMeta } from '@/lib/firma-meta';

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

// Tipos de media que descargamos y mostramos en el chat del dashboard.
const TIPOS_MEDIA = ['image', 'audio', 'video', 'document', 'sticker'];

// Lo que le respondemos al cliente cuando manda algo que el bot no entiende
// (media) y no hay un operador ya manejando la conversación.
const MENSAJE_REQUIERE_HUMANO =
  'Recibí tu mensaje, en un momento te atiende una persona 🙏';

// Botones de "respuesta rápida" que manda el bot cuando falta un solo dato
// (ver procesar.ts > datos faltantes). No codifican un pedidoId: el click se
// convierte en un mensaje de texto canónico y sigue el pipeline normal
// (QStash + LLM), que es quien sabe fusionarlo con el pedido en armado.
const RESPUESTAS_RAPIDAS: Record<string, string> = {
  resp_pago_efectivo: 'efectivo',
  resp_pago_transferencia: 'transferencia',
  resp_retira: 'paso a retirar',
};

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
    // Verificación de autenticidad ANTES de tocar nada: Meta firma cada entrega
    // con HMAC-SHA256(App Secret, body crudo) en X-Hub-Signature-256. Sin esto,
    // cualquiera que conozca la URL puede forjar mensajes de "clientes" (crear/
    // cancelar pedidos ajenos, disparar WhatsApps salientes, quemar tokens).
    // La firma es sobre los bytes crudos → leemos text() y parseamos después.
    const rawBody = await request.text();

    // Fail-closed: sin el secret configurado no podemos distinguir un request
    // de Meta de uno forjado, así que rechazamos todo. Si el bot deja de
    // responder tras un deploy, revisar que WHATSAPP_APP_SECRET esté cargada
    // (App Secret de la app de Meta: panel → Configuración → Básica).
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      console.error('⛔ WHATSAPP_APP_SECRET no configurado: rechazando el webhook. Cargar el App Secret de Meta en las env vars.');
      return NextResponse.json({ error: 'webhook sin configurar' }, { status: 503 });
    }

    const firma = request.headers.get('x-hub-signature-256');
    if (!verificarFirmaMeta(rawBody, firma, appSecret)) {
      console.warn('⛔ Webhook con firma inválida o ausente. Rechazado (403).');
      // 403 y no 200: un request forjado no debe procesarse. Los requests
      // legítimos de Meta siempre traen firma válida, así que esto no afecta
      // el flujo normal ni provoca reintentos de Meta sobre mensajes reales.
      return NextResponse.json({ error: 'firma inválida' }, { status: 403 });
    }

    const body = JSON.parse(rawBody);

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

    if (TIPOS_MEDIA.includes(message.type)) {
      return await manejarMedia(message, numeroCliente, waMessageId);
    }

    if (message.type === 'location') {
      return await manejarUbicacion(message, numeroCliente, waMessageId);
    }

    // Tipos que todavía no manejamos (contacts, etc.): le avisamos al cliente
    // que solo entendemos texto, sin persistir ni agendar nada.
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

  // Toma humana: si un operador está manejando esta conversación a mano, el bot
  // no debe auto-responder. Guardamos el mensaje como procesado=true (visible en
  // el chat del dashboard y vía Realtime, pero invisible al claim atómico y al
  // defer) y NO agendamos el wake-up de QStash. 0 tokens, el LLM ni se entera.
  const enTomaHumana = await atencionHumanaActiva(numeroCliente);

  // 1. Insert con idempotencia: si Meta reintenta, el unique index en
  //    wa_message_id devuelve 23505 y cortamos sin volver a procesar.
  const { error: insertError } = await supabaseAdmin
    .from('mensajes_chat')
    .insert([{
      telefono: numeroCliente,
      texto: textoMensaje,
      wa_message_id: waMessageId,
      procesado: enTomaHumana,
    }]);

  if (insertError) {
    if (insertError.code === '23505') {
      console.log(`⏭️ Mensaje duplicado de Meta (wa_id: ${waMessageId}). Ignorando reintento.`);
      return NextResponse.json({ status: 'duplicate_ignored' }, { status: 200 });
    }
    console.error("Error al guardar el mensaje:", insertError);
    return NextResponse.json({ status: 'error' }, { status: 200 });
  }

  if (enTomaHumana) {
    console.log(`🙋 Toma humana activa para ${numeroCliente}. Mensaje guardado sin agendar al bot.`);
    return NextResponse.json({ status: 'atencion_humana' }, { status: 200 });
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

/**
 * Media (imagen/audio/video/documento/sticker). El bot no lo entiende, pero lo
 * descargamos y guardamos para que el operador lo vea en el modal de chat.
 *
 * Descargamos ANTES de insertar la fila para que ya traiga media_path cuando
 * dispara el Realtime del modal (que escucha INSERT, no UPDATE). La fila va con
 * procesado=true: nunca entra al claim/defer del bot.
 */
async function manejarMedia(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  numeroCliente: string,
  waMessageId: string | undefined,
) {
  const tipo: string = message.type;
  const mediaObj = message[tipo] ?? {};
  const mediaId: string | undefined = mediaObj.id;
  const caption: string | null = mediaObj.caption ?? null;
  const filename: string | null = mediaObj.filename ?? null;

  console.log(`📎 Media (${tipo}) de ${numeroCliente} (wa_id: ${waMessageId}).`);

  let mediaPath: string | null = null;
  let mediaMime: string | null = mediaObj.mime_type ?? null;
  if (mediaId) {
    const res = await descargarYGuardarMedia(mediaId, numeroCliente, waMessageId);
    if (res) {
      mediaPath = res.media_path;
      mediaMime = res.media_mime;
    }
  }

  const { error: insertError } = await supabaseAdmin
    .from('mensajes_chat')
    .insert([{
      telefono: numeroCliente,
      texto: null,
      tipo,
      media_path: mediaPath,
      media_mime: mediaMime,
      media_caption: caption,
      media_filename: filename,
      wa_message_id: waMessageId,
      procesado: true,
    }]);

  if (insertError) {
    if (insertError.code === '23505') {
      console.log(`⏭️ Media duplicado de Meta (wa_id: ${waMessageId}). Ignorando reintento.`);
      return NextResponse.json({ status: 'duplicate_ignored' }, { status: 200 });
    }
    console.error('Error al guardar el media:', insertError);
    return NextResponse.json({ status: 'error' }, { status: 200 });
  }

  return await avisarSiHaceFaltaHumano(numeroCliente);
}

/**
 * Ubicación compartida. No es un archivo (no hay media_id): viene con lat/long
 * y opcionalmente nombre/dirección. La guardamos como tipo='location'.
 *
 * A diferencia del media, acá NO derivamos a un humano: quien manda un pin
 * casi seguro está pasando su dirección de entrega, así que el bot le pide la
 * versión escrita (calle y número) y el pedido se sigue cargando solo. El pin
 * queda visible en el chat del dashboard igual, por si el operador lo necesita.
 */
async function manejarUbicacion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  numeroCliente: string,
  waMessageId: string | undefined,
) {
  const loc = message.location ?? {};
  const etiqueta = [loc.name, loc.address].filter(Boolean).join(' — ') || 'Ubicación compartida';

  console.log(`📍 Ubicación de ${numeroCliente} (${loc.latitude}, ${loc.longitude}).`);

  const { error: insertError } = await supabaseAdmin
    .from('mensajes_chat')
    .insert([{
      telefono: numeroCliente,
      texto: etiqueta,
      tipo: 'location',
      media_lat: loc.latitude ?? null,
      media_lng: loc.longitude ?? null,
      wa_message_id: waMessageId,
      procesado: true,
    }]);

  if (insertError) {
    if (insertError.code === '23505') {
      console.log(`⏭️ Ubicación duplicada de Meta (wa_id: ${waMessageId}). Ignorando reintento.`);
      return NextResponse.json({ status: 'duplicate_ignored' }, { status: 200 });
    }
    console.error('Error al guardar la ubicación:', insertError);
    return NextResponse.json({ status: 'error' }, { status: 200 });
  }

  // Con un operador en la conversación no interferimos; si no, pedimos la
  // dirección escrita para que el flujo normal la tome sin intervención humana.
  const enTomaHumana = await atencionHumanaActiva(numeroCliente);
  if (!enTomaHumana) {
    await enviarMensajeWhatsApp(
      numeroCliente,
      '¡Gracias por la ubicación! 🙏 Para el reparto necesito la dirección escrita: mandame calle y número (ej: *Mitre 950*).',
    );
  }
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

/**
 * Tras registrar un mensaje que el bot no puede resolver: si NO hay un operador
 * ya manejando la conversación, marcamos el teléfono como "requiere atención"
 * (para el aviso del dashboard) y le avisamos al cliente que lo atiende alguien.
 * Si ya hay toma humana, no hace falta avisar nada: el operador está ahí.
 */
async function avisarSiHaceFaltaHumano(numeroCliente: string) {
  const enTomaHumana = await atencionHumanaActiva(numeroCliente);
  if (!enTomaHumana) {
    await marcarRequiereAtencion(numeroCliente);
    await enviarMensajeWhatsApp(numeroCliente, MENSAJE_REQUIERE_HUMANO);
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

  // Respuesta rápida (falta un solo dato): el click ES el dato. Lo mapeamos a
  // su texto canónico y lo mandamos por el pipeline normal de texto.
  const textoRapido = RESPUESTAS_RAPIDAS[buttonId];
  if (textoRapido) {
    console.log(`⚡ Respuesta rápida "${buttonId}" → texto "${textoRapido}".`);
    return await guardarComoTextoYAgendar(numeroCliente, textoRapido, waMessageId);
  }

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

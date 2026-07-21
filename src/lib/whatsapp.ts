// Helpers para enviar mensajes a la Cloud API de WhatsApp.
//
// Además de mandar a Meta, cada send exitoso persiste una fila en
// mensajes_chat con rol='bot' y procesado=true. Eso permite que el LLM vea
// el último turno del bot al clasificar la próxima respuesta del cliente,
// sin contaminar el claim atómico ni el defer (ambos filtran por
// procesado=false). Ver CLAUDE.md > "El bot pipeline".

import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { formatearPesos, PAGO_TRANSFERENCIA, ENTREGA } from '@/lib/precios-publico';

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function persistirMensajeBot(telefono: string, texto: string) {
  const { error } = await supabaseAdmin.from('mensajes_chat').insert({
    telefono,
    texto,
    rol: 'bot',
    procesado: true,    // invisible al claim atómico y al defer
    descartado: false,  // visible en el historial de 15 min y al traer "último turno del bot"
  });
  if (error) {
    // No bloqueamos el flow: el mensaje al cliente ya se mandó. Solo perdemos contexto futuro.
    console.error('⚠️ No se pudo persistir el mensaje del bot:', error);
  }
}

// Timeout propio por intento hacia Meta. Si dispara (AbortError) NO reintentamos:
// el abort ocurre DESPUÉS de mandar la request, así que Meta pudo haberla
// entregado (la Cloud API no tiene idempotencia en outbound) y reintentar
// duplicaría el mensaje. Ver esErrorTimeoutPropio + postAMeta. Generoso a
// propósito (Meta suele responder en 1-3s); no conviene subirlo mucho porque el
// worker corre dentro del budget de la función serverless.
const META_TIMEOUT_MS = 10000;
// 1 intento + 2 reintentos. Solo aplica a fallos de CONEXIÓN (fetch failed / DNS
// / ECONNREFUSED, donde la request no llegó) y a 5xx (Meta respondió que no la
// procesó): ahí reintentar es seguro. El caso típico que motivó el retry: el
// cliente quedaba sin recibir el resumen porque el `fetch` falló una vez y el
// error se tragaba en silencio. Los timeouts propios NO entran acá.
const META_MAX_INTENTOS = 3;

/**
 * ¿La excepción de un fetch a Meta es nuestro propio timeout (AbortController)?
 *
 * Determina la política de reintento y por eso está separada y testeada. Un
 * AbortError significa que la request salió y estábamos esperando la respuesta
 * cuando cortamos: Meta pudo haber procesado y ENTREGADO el mensaje igual. Como
 * la Cloud API no ofrece idempotencia en outbound, reintentar ahí DUPLICA el
 * mensaje al cliente (fue el bug de "¿Querés cancelar el pedido?" x2). El resto
 * de las excepciones del catch (TypeError 'fetch failed' por DNS/ECONNREFUSED/
 * reset previo a la respuesta) significan que la request no llegó a destino →
 * reintentar es seguro. Pura y exportada para test.
 */
export function esErrorTimeoutPropio(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// ───────────────────────────────────────────────────────────────────────────
// Modo test (BOT_TEST_MODE='1'): intercepta TODA la salida hacia Meta.
//
// El harness de testeo del bot (scripts/probar-bot.mjs + el endpoint dev
// /api/dev/simular-conversacion) corre el pipeline REAL contra la DB pero NO
// debe mandar WhatsApp de verdad: el WHATSAPP_TOKEN local puede estar vivo.
// Con el flag encendido, postAMeta no hace fetch — registra el body en un
// buffer en memoria por teléfono (el endpoint lo drena) y devuelve true, así la
// persistencia posterior (rol='bot'/'operador') corre igual que en producción y
// las respuestas quedan en mensajes_chat. Con el flag apagado esta rama es
// inerte y el comportamiento es idéntico al de siempre.
// ───────────────────────────────────────────────────────────────────────────
export type SalidaCapturada = { descripcion: string; body: unknown; ts: number };
const bufferSalidaTest = new Map<string, SalidaCapturada[]>();

/** Lee y limpia lo capturado para un teléfono. Solo lo usa el endpoint dev de testeo. */
export function drenarSalidaTest(telefono: string): SalidaCapturada[] {
  const salida = bufferSalidaTest.get(telefono) ?? [];
  bufferSalidaTest.delete(telefono);
  return salida;
}

/**
 * POST al endpoint de mensajes de Meta con timeout + reintentos.
 *
 * Reintenta ante fallo de conexión, timeout o status 5xx (problema del lado de
 * Meta / la red). NO reintenta ante 4xx (request inválido nuestro: token vencido,
 * número mal formado, payload inválido) — reintentar eso solo agrega latencia.
 *
 * Devuelve true si Meta aceptó el mensaje; false si se agotaron los intentos.
 * El caller persiste el mensaje del bot SOLO si devolvió true.
 */
async function postAMeta(body: object, descripcion: string): Promise<boolean> {
  // Modo test: cortamos antes de la red. Los mensajes de status (read/typing)
  // no llevan `to` y no se bufferean; el resto se guarda por teléfono.
  if (process.env.BOT_TEST_MODE === '1') {
    const to = (body as { to?: string }).to;
    if (to) {
      const previas = bufferSalidaTest.get(to) ?? [];
      previas.push({ descripcion, body, ts: Date.now() });
      bufferSalidaTest.set(to, previas);
    }
    return true;
  }

  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const url = `${WHATSAPP_API_URL}/${phoneId}/messages`;

  for (let intento = 1; intento <= META_MAX_INTENTOS; intento++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) return true;

      const detalle = await response.text();
      if (response.status < 500) {
        // 4xx: error nuestro, reintentar no sirve.
        console.error(`Error al enviar ${descripcion} (${response.status}, no reintentable):`, detalle);
        return false;
      }
      console.warn(`Meta respondió ${response.status} en ${descripcion} (intento ${intento}/${META_MAX_INTENTOS}):`, detalle);
    } catch (error) {
      // Timeout propio (AbortError): la request ya salió y Meta pudo haberla
      // ENTREGADO. Sin idempotencia en outbound, reintentar duplicaría el
      // mensaje al cliente. Cortamos y asumimos entregado (true) en vez de
      // reintentar (duplicaría) o devolver false (dejaría los botones sin armar
      // → tap del cliente sin respuesta). Es optimista: si Meta NO entregó, se
      // pierde ese mensaje, pero los flujos críticos tienen red de contención
      // (recordatorio/auto-rechazo de borradores, reenvío de resúmenes, corte
      // por silencio en esperando_cancelacion).
      if (esErrorTimeoutPropio(error)) {
        console.warn(`⏱️ Timeout esperando a Meta en ${descripcion}: no reintento (posible entrega ya hecha; reintentar duplicaría).`);
        return true;
      }
      // Fallo de conexión (fetch failed / DNS / ECONNREFUSED): la request no
      // llegó a destino → reintentar es seguro.
      console.warn(`Fallo la conexión con Meta en ${descripcion} (intento ${intento}/${META_MAX_INTENTOS}):`, error instanceof Error ? error.message : error);
    }

    // Backoff lineal entre intentos (500ms, 1000ms). No dormimos tras el último.
    if (intento < META_MAX_INTENTOS) {
      await new Promise(resolve => setTimeout(resolve, 500 * intento));
    }
  }

  console.error(`❌ No se pudo enviar ${descripcion} tras ${META_MAX_INTENTOS} intentos.`);
  return false;
}

// Bucket privado donde guardamos los archivos que mandan los clientes. Se sirve
// al modal solo vía URLs firmadas generadas server-side (nunca acceso directo).
const MEDIA_BUCKET = 'whatsapp-media';

// Extensión a partir del mime, para que el archivo guardado tenga un nombre
// razonable (no es crítico: al subir seteamos contentType igual). Exportada
// para tests (función pura).
export function mimeAExtension(mime: string | null | undefined): string {
  if (!mime) return 'bin';
  const limpio = mime.split(';')[0].trim();
  const mapa: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/amr': 'amr',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'application/pdf': 'pdf',
  };
  if (mapa[limpio]) return mapa[limpio];
  // Fallback: la parte después de la barra (p.ej. "application/zip" → "zip").
  const sub = limpio.split('/')[1];
  return sub ? sub.replace(/[^a-z0-9]/gi, '') || 'bin' : 'bin';
}

async function fetchConTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Descarga un media de WhatsApp y lo sube al bucket privado de Storage.
 *
 * La Cloud API NO manda el binario en el webhook: manda un `media_id`. Hay que
 *  1) GET /{media-id} (con el token) → devuelve una URL temporal (~5 min) + mime,
 *  2) descargar esa URL (también con el token),
 *  3) subir los bytes a Storage (la URL de Meta caduca y no es accesible desde
 *     el browser sin el token, así que guardarla no sirve).
 *
 * El path es determinístico (`telefono/wa_message_id.ext`) y subimos con
 * upsert=true: si Meta reintenta el webhook, re-subir sobreescribe el mismo
 * objeto en vez de duplicar.
 *
 * Devuelve { media_path, media_mime } o null si algo falló (el caller igual
 * registra la fila, solo que sin archivo recuperable).
 */
export async function descargarYGuardarMedia(
  mediaId: string,
  telefono: string,
  waMessageId: string | undefined,
): Promise<{ media_path: string; media_mime: string | null } | null> {
  const token = process.env.WHATSAPP_TOKEN;
  try {
    // 1. Metadata: URL temporal + mime.
    const metaResp = await fetchConTimeout(`${WHATSAPP_API_URL}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaResp.ok) {
      const detalle = await metaResp.text();
      console.error(`❌ No se pudo obtener la URL del media ${mediaId} (${metaResp.status}):`, detalle);
      return null;
    }
    const metaJson = await metaResp.json() as { url?: string; mime_type?: string };
    if (!metaJson.url) {
      console.error(`❌ Meta no devolvió URL para el media ${mediaId}.`);
      return null;
    }

    // 2. Descarga del binario (la URL de Meta también requiere el token).
    const fileResp = await fetchConTimeout(metaJson.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!fileResp.ok) {
      console.error(`❌ Falló la descarga del media ${mediaId} (${fileResp.status}).`);
      return null;
    }
    const mime = metaJson.mime_type ?? fileResp.headers.get('content-type') ?? null;
    const bytes = new Uint8Array(await fileResp.arrayBuffer());

    // 3. Subida a Storage.
    const ext = mimeAExtension(mime);
    const nombre = (waMessageId ?? `m${bytes.byteLength}`).replace(/[^a-zA-Z0-9._-]/g, '');
    const path = `${telefono}/${nombre}.${ext}`;
    const { error } = await supabaseAdmin.storage
      .from(MEDIA_BUCKET)
      .upload(path, bytes, { contentType: mime ?? undefined, upsert: true });
    if (error) {
      console.error(`❌ No se pudo subir el media ${mediaId} a Storage:`, error.message);
      return null;
    }

    return { media_path: path, media_mime: mime };
  } catch (error) {
    console.error(`❌ Error al procesar el media ${mediaId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export async function enviarMensajeWhatsApp(numeroDestino: string, texto: string): Promise<boolean> {
  const ok = await postAMeta({
    messaging_product: "whatsapp",
    to: numeroDestino,
    type: "text",
    text: { body: texto },
  }, "mensaje de texto");

  if (ok) await persistirMensajeBot(numeroDestino, texto);
  return ok;
}

/**
 * Marca el último mensaje del cliente como leído (tildes azules) y muestra el
 * indicador "escribiendo…" (Meta lo mantiene hasta 25s o hasta que mandemos la
 * respuesta). Se llama recién cuando el worker CLAIMEÓ los mensajes y va a
 * responder — no desde el webhook — para no cortar al cliente que sigue
 * tipeando durante el debounce: si ve "escribiendo…" deja de escribir para
 * esperar la respuesta. Best-effort: si falla, solo se pierde el efecto visual.
 */
export async function marcarLeidoYEscribiendo(waMessageId: string): Promise<void> {
  await postAMeta({
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: waMessageId,
    typing_indicator: { type: 'text' },
  }, 'indicador de escribiendo');
}

/**
 * Texto de "pedido confirmado" con tiempo estimado y, si paga por
 * transferencia, los datos para transferir. Pura y exportada para tests.
 * Los valores editables viven en precios-publico.ts (ENTREGA / PAGO_TRANSFERENCIA).
 */
export function mensajeConfirmacion(direccion: string, metodoPago: string): string {
  const lineas = ['¡Confirmado! Va a la cocina 🍦'];
  lineas.push(
    direccion === 'retira'
      ? `En aproximadamente ${ENTREGA.tiempoEstimado} lo podés pasar a buscar.`
      : `Te llega en aproximadamente ${ENTREGA.tiempoEstimado} 🛵`
  );
  if (metodoPago === 'transferencia') {
    lineas.push(`💸 Alias para transferir: *${PAGO_TRANSFERENCIA.alias}* (${PAGO_TRANSFERENCIA.titular}). Mandanos el comprobante por acá 🙏`);
  }
  return lineas.join('\n');
}

export type MensajePersistido = {
  id: string;
  rol: string;
  texto: string | null;
  created_at: string;
};

/**
 * Envío MANUAL de un operador desde el dashboard (toma humana).
 *
 * Igual que enviarMensajeWhatsApp pero persiste con rol='operador' para que el
 * chat distinga las respuestas humanas de las del bot. El claim atómico del bot
 * solo filtra rol='cliente', así que estas filas nunca se reclaman como input.
 *
 * Devuelve:
 *  - ok: true si Meta aceptó el mensaje; false si se agotaron los intentos
 *    (p.ej. fuera de la ventana de 24h de Meta → 4xx no reintentable).
 *  - mensaje: la fila insertada en mensajes_chat (o null si el insert falló).
 *    El modal la agrega al toque, sin depender de que Realtime devuelva el eco
 *    del propio insert del operador.
 */
export async function enviarMensajeManual(
  numeroDestino: string,
  texto: string,
): Promise<{ ok: boolean; mensaje: MensajePersistido | null }> {
  const ok = await postAMeta({
    messaging_product: "whatsapp",
    to: numeroDestino,
    type: "text",
    text: { body: texto },
  }, "mensaje manual del operador");

  if (!ok) return { ok: false, mensaje: null };

  const { data, error } = await supabaseAdmin
    .from('mensajes_chat')
    .insert({
      telefono: numeroDestino,
      texto,
      rol: 'operador',
      procesado: true,    // invisible al claim atómico y al defer
      descartado: false,
    })
    .select('id, rol, texto, created_at')
    .single();

  if (error) {
    console.error('⚠️ No se pudo persistir el mensaje del operador:', error);
    return { ok: true, mensaje: null };
  }

  return { ok: true, mensaje: data };
}

export type BotonReply = {
  id: string;   // identificador interno (lo recibimos de vuelta en el webhook). Max 256 chars.
  title: string; // texto visible. Max 20 chars (límite de Meta).
};

/**
 * Manda un mensaje interactivo con hasta 3 botones de respuesta rápida.
 * Cuando el cliente toca un botón, Meta nos manda al webhook un mensaje de
 * tipo "interactive" con interactive.button_reply.id = el id del botón.
 */
export async function enviarMensajeConBotones(
  numeroDestino: string,
  texto: string,
  botones: BotonReply[],
): Promise<boolean> {
  if (botones.length === 0 || botones.length > 3) {
    console.error(`❌ Cantidad inválida de botones (${botones.length}). Meta acepta 1-3.`);
    return false;
  }

  const ok = await postAMeta({
    messaging_product: "whatsapp",
    to: numeroDestino,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: texto },
      action: {
        buttons: botones.map(b => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  }, "mensaje con botones");

  if (!ok) return false;

  // Persistimos el body + el listado de opciones que vio el cliente, así el
  // LLM entiende a qué está respondiendo cuando recibe un "sí" o "dale" suelto.
  const opciones = botones.map(b => b.title).join(' | ');
  await persistirMensajeBot(numeroDestino, `${texto}\n[opciones: ${opciones}]`);
  return true;
}

export type PedidoResumen = {
  id: number;
  cantidad_crema: number;
  cantidad_agua: number;
  observaciones: string | null;
  direccion: string;
  aclaracion: string | null;
  metodo_pago: string;
  precio_total: number | null;
  // Persistido en la fila: la dirección vino del historial (el cliente no la
  // dio en esta conversación). Opcional para no romper llamadores con filas
  // parciales; si falta se asume false.
  direccion_de_historial?: boolean | null;
};

/**
 * Arma el texto del resumen que se manda con los botones de confirmación.
 * Pura y exportada para tests (el envío/persistencia queda en
 * enviarResumenYPedirConfirmacion).
 */
export function construirResumenPedido(
  pedidoDB: PedidoResumen,
  esModificacion: boolean,
  direccionInyectadaDeHistorial: boolean = false,
): string {
  const detalleHelado = [
    pedidoDB.cantidad_crema > 0 ? `• Crema: ${pedidoDB.cantidad_crema}` : '',
    pedidoDB.cantidad_agua > 0 ? `• Agua: ${pedidoDB.cantidad_agua}` : '',
    pedidoDB.observaciones ? `  _Sabores: ${pedidoDB.observaciones}_` : ''
  ].filter(Boolean).join('\n');

  const detalleEnvio = pedidoDB.direccion === 'retira'
    ? '• Retira en sucursal'
    : `• Envío a: ${pedidoDB.direccion}${pedidoDB.aclaracion ? ` (${pedidoDB.aclaracion})` : ''}`;

  const avisoDireccion = direccionInyectadaDeHistorial && pedidoDB.direccion !== 'retira'
    ? "\n_📍 Usé la dirección de tu último pedido. Si cambió, decime._"
    : '';

  // precio_total puede venir null (p.ej. cantidad por debajo del tier mínimo de
  // la lista de precios): sin este fallback el cliente veía "Total: $null".
  const detalleTotal = pedidoDB.precio_total != null
    ? `• *Total: ${formatearPesos(pedidoDB.precio_total)}*`
    : '• *Total: a confirmar*';

  return [
    esModificacion ? "*Pedido actualizado:*" : "*Tu pedido:*",
    "\n" + detalleHelado,
    detalleEnvio,
    `• Pago: ${pedidoDB.metodo_pago}`,
    detalleTotal,
    avisoDireccion,
    "\n¿Está todo bien?"
  ].filter(Boolean).join('\n');
}

export async function enviarResumenYPedirConfirmacion(
  numeroCliente: string,
  pedidoDB: PedidoResumen,
  esModificacion: boolean,
  // #8: cuando la dirección se rellenó desde un pedido anterior (el cliente no
  // la dio en este), lo avisamos para que pueda corregirla si cambió.
  direccionInyectadaDeHistorial: boolean = false,
): Promise<boolean> {
  // El aviso sale si la inyección pasó en ESTE turno (parámetro) O si quedó
  // persistida en la fila (direccion_de_historial): con borradores parciales la
  // inyección suele ocurrir turnos antes de que el resumen finalmente salga, y
  // la variable local de aquel turno ya no existe. También cubre el reenvío de
  // resúmenes del cron, que reconstruye todo desde la fila.
  const avisoHistorial = direccionInyectadaDeHistorial || Boolean(pedidoDB.direccion_de_historial);
  const mensaje = construirResumenPedido(pedidoDB, esModificacion, avisoHistorial);

  const ok = await enviarMensajeConBotones(numeroCliente, mensaje, [
    { id: `confirmar_borrador_${pedidoDB.id}`, title: 'Sí, confirmar' },
    { id: `modificar_borrador_${pedidoDB.id}`, title: 'No, modificar' },
  ]);

  // Mitigación de cortes largos de Meta: si el resumen NO salió (se agotó el
  // budget de retry de postAMeta), marcamos el pedido para que el cron de
  // /api/reenviar-resumenes lo reintente. Si salió, limpiamos el flag (pudo
  // haber quedado en true de un intento anterior). El resumen es reconstruible
  // desde la fila, por eso se puede reenviar; otros mensajes del bot no.
  // Re-armamos también el recordatorio de silencio: cada resumen nuevo abre una
  // nueva espera de confirmación, así el cron puede volver a insistir si el
  // cliente se queda callado otra vez.
  // esperando_respuesta_boton: si el resumen salió, esta es una ronda nueva de
  // botones (Confirmar/Modificar) → armamos el token de un solo uso para que
  // ejecutarBoton procese solo el PRIMER click (ver botones.ts). Si no salió, no
  // hay botones vivos, lo dejamos en false.
  const { error } = await supabaseAdmin
    .from('pedidos')
    .update({ resumen_pendiente: !ok, recordatorio_enviado: false, esperando_respuesta_boton: ok })
    .eq('id', pedidoDB.id);
  if (error) console.error('⚠️ No se pudo actualizar resumen_pendiente:', error);

  console.log(ok
    ? "📩 Resumen enviado al cliente con botones. Esperando respuesta..."
    : `⚠️ Falló el envío del resumen del pedido #${pedidoDB.id}; marcado resumen_pendiente=true para reintento.`);

  return ok;
}

/**
 * Mensaje "¿estás seguro de cancelar?" con botones. Lo usamos tanto cuando
 * el pedido recién pasa a esperando_cancelacion como cuando el cliente nos
 * contesta ambiguo en ese estado.
 */
export async function enviarConfirmacionCancelacion(
  numeroCliente: string,
  pedidoId: number,
  texto: string = "⚠️ ¿Estás seguro de que querés cancelar tu pedido?",
) {
  const ok = await enviarMensajeConBotones(numeroCliente, texto, [
    { id: `confirmar_cancelacion_${pedidoId}`, title: 'Sí, cancelar' },
    { id: `rechazar_cancelacion_${pedidoId}`, title: 'No, mantenerlo' },
  ]);

  // Ronda nueva de botones (Sí,cancelar / No,mantenerlo): armamos el token de
  // un solo uso para que ejecutarBoton procese solo el primer click. Si el
  // envío falló, no hay botones vivos → no lo armamos.
  if (ok) {
    const { error } = await supabaseAdmin
      .from('pedidos')
      .update({ esperando_respuesta_boton: true })
      .eq('id', pedidoId);
    if (error) console.error('⚠️ No se pudo armar esperando_respuesta_boton:', error);
  }
}

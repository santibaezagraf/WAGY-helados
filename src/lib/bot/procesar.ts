import { generateObject } from 'ai';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { Database, Json } from '@/types/supabase';
import { enviarMensajeWhatsApp, enviarMensajeConBotones, enviarResumenYPedirConfirmacion, enviarDesambiguacionConfirmacion, enviarConfirmacionCancelacion, marcarLeidoYEscribiendo, mensajeConfirmacion } from '@/lib/whatsapp';
import { atencionHumanaActiva, intervencionHumanaReciente, marcarRequiereAtencion, requiereAtencionActual } from '@/lib/bot/atencion-humana';
import { esBorradorCompleto } from '@/lib/bot/borradores';
import { registrarAlertaFallback, registrarUsoModelo, siguienteModelo } from '@/lib/bot/alertas';
import { MODELOS_EXTRACCION } from '@/lib/bot/modelos';
import { crearModeloLLM } from '@/lib/bot/proveedor-llm';
import { obtenerListaPreciosPublica, formatearPreciosWhatsApp, SABORES } from '@/lib/precios-publico';
import { construirContextoNegocio, responderConsultaNegocio, elegirTextoDelegacion, redactarPreguntaTipoHelado } from '@/lib/bot/consultas-negocio';
import { patchConEnviadoCoherente } from '@/lib/pedidos-estado';

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// La cadena de modelos de extracción (MODELOS_EXTRACCION) vive ahora en
// @/lib/bot/modelos.ts, fuente de verdad única que también lee la página de
// estado de modelos. esRateLimit solo dispara el salto de modelo con un 429, así
// que un id muerto (404) agotaría los reintentos de validación en vano en vez de
// saltar — por eso la cadena solo lista modelos vigentes en Groq.

// ¿El error del SDK es un rate limit (429)? Es la señal de "modelo sin cuota" que
// dispara el fallback. Miramos statusCode (lo expone APICallError del AI SDK) y,
// como red, el texto del mensaje por si el error llega envuelto de otra forma.
export function esRateLimit(error: unknown): boolean {
  // Recorremos la CADENA de errores, no solo el de arriba: el AI SDK envuelve los
  // reintentos en un `AI_RetryError` cuyo `statusCode` es undefined y que guarda el
  // error real en `lastError` (y a veces en `cause`). Mirar solo el tope daba false
  // para un 429 legítimo → no se disparaba el fallback de modelo y el cliente
  // terminaba con "no te entendí" pese a haber cadena disponible. Verificado
  // 2026-08-28 contra Gemini: name=AI_RetryError, statusCode=undefined,
  // lastError.statusCode=429.
  const vistos = new Set<unknown>();
  let actual: unknown = error;
  for (let profundidad = 0; actual && profundidad < 5; profundidad++) {
    if (vistos.has(actual)) break; // corta ciclos (cause que se apunta a sí mismo)
    vistos.add(actual);

    const e = actual as { statusCode?: number; message?: string; lastError?: unknown; cause?: unknown };
    if (e.statusCode === 429) return true;

    const msg = actual instanceof Error ? actual.message : String(actual);
    // Groq dice "Rate limit reached ..."; Google dice "You exceeded your current
    // quota ..." + "Quota exceeded for metric ...generate_content_free_tier_requests".
    // La regex vieja solo cubría a Groq (y "rate-limits" con guion, que aparece en la
    // URL de doc de Google, NO matchea /rate limit/), así que Google pasaba de largo.
    if (/rate.?limit|tokens per day|\bTPD\b|\b429\b|quota|resource_exhausted|too many requests/i.test(msg)) {
      return true;
    }

    actual = e.lastError ?? e.cause;
  }
  return false;
}

/**
 * ¿El `pregunta_negocio` que devolvió el modelo es una pregunta REAL a delegar?
 * El modelo a veces stringifica el null como el TEXTO "null" (o "none"/"undefined"),
 * mismo no-determinismo que el "false" string — y eso disparaba una delegación a
 * humano fantasma. Tratamos esos placeholders y el vacío como AUSENCIA de pregunta.
 * Pura y exportada para test.
 */
export function esPreguntaNegocioReal(valor: string | null | undefined): boolean {
  if (!valor) return false;
  const v = valor.trim().toLowerCase();
  return v !== '' && v !== 'null' && v !== 'none' && v !== 'undefined' && v !== 'n/a';
}

/**
 * Normaliza el `metodo_pago` que devuelve el modelo a exactamente
 * 'efectivo' | 'transferencia' | null. El prompt ya pide una de esas dos
 * palabras (mapeando sinónimos: "cash", "mp", "en billete", …), así que esto es
 * la red determinista: descarta el placeholder "null" string (mismo no-determinismo
 * que [[esPreguntaNegocioReal]]) y cualquier valor inesperado, para que no se
 * cuele un pago inválido tipo "Pago: null" en el resumen. Pura y exportada para test.
 */
export function normalizarMetodoPago(valor: string | null | undefined): 'efectivo' | 'transferencia' | null {
  if (!valor) return null;
  const v = valor.trim().toLowerCase();
  if (v === 'efectivo') return 'efectivo';
  if (v === 'transferencia') return 'transferencia';
  return null;
}

/**
 * Marca todos los mensajes del cliente como "descartados" (descartado=true).
 * Se llama cuando una conversación se cierra (cancelación confirmada,
 * confirmación de borrador a pendiente), para que la próxima vez que el
 * cliente escriba, el historial de últimos 15 minutos no incluya mensajes
 * de la conversación anterior y el modelo no los combine con los nuevos.
 */
export async function marcarHistorialDescartado(numeroCliente: string) {
  const { error } = await supabaseAdmin
    .from('mensajes_chat')
    .update({ descartado: true })
    .eq('telefono', numeroCliente)
    .eq('descartado', false);

  if (error) {
    console.error(`❌ Error marcando historial descartado para ${numeroCliente}:`, error);
  } else {
    console.log(`🗑️ Historial marcado como descartado para ${numeroCliente}.`);
  }
}

/**
 * Schema de la respuesta del modelo. Validado por Zod, retry automático del SDK
 * si el modelo no respeta el shape. Reemplaza al parsing manual con indexOf+JSON.parse.
 *
 * `datos_completos` NO está acá porque lo calculamos nosotros después
 * (no es algo que el modelo deba decidir).
 */
/**
 * Intención del mensaje del cliente. Mutuamente excluyente — el modelo elige
 * UNA sola. Reemplaza a 6 booleanos (es_cancelacion / es_confirmacion / ...)
 * que el modelo a veces marcaba en combinaciones imposibles.
 *
 * "datos_pedido" es el catch-all cuando el mensaje aporta info concreta
 * (cantidades, sabores, dirección, método de pago), incluso si es para
 * modificar un pedido existente.
 */
export const IntencionEnum = z.enum([
  'cancelar',
  'confirmar',
  'confirmar_cancelacion',
  'rechazar_cancelacion',
  'reactivar',
  'saludo',
  'modificar_sin_datos',
  'consultar_precios',
  'consulta_negocio',
  'datos_pedido',
]);
export type Intencion = z.infer<typeof IntencionEnum>;

export const PedidoIASchema = z.object({
  intencion: IntencionEnum.describe('Intención principal del mensaje. Elegí UNA sola opción.'),
  direccion: z.string().nullable().describe('Calle y número únicamente (ej: "Mitre 951"). null si no se mencionó o si solo dieron aclaración. La palabra "retira" si pasan a retirar.'),
  aclaracion: z.string().nullable().describe('Detalle de ubicación mencionado en ESTE mensaje únicamente (depto, piso, color de casa, etc.). NO lo fusiones con lo que ya había: para "agregar" devolvé solo el detalle nuevo; para "reemplazar" devolvé el texto ya corregido completo; para "mantener" va null. null si no menciona aclaración.'),
  aclaracion_operacion: z.enum(['agregar', 'reemplazar', 'mantener']).describe('Qué hacer con la aclaración: "agregar" si suma un detalle nuevo que NO contradice lo actual (el sistema lo concatena), "reemplazar" si corrige/contradice un detalle del actual (devolvé el texto corregido completo en el campo aclaracion), "mantener" si no menciona ninguna aclaración. En pedidos nuevos desde cero usá siempre "reemplazar".'),
  cantidad_agua: z.number().describe('Valor literal mencionado en el mensaje para agua (no calcules sumas/restas, solo extrae el numero literal). 0 si no se mencionó.'),
  cantidad_agua_operacion: z.enum(['sumar', 'restar', 'reemplazar', 'mantener']).describe('Que hacer con cantidad_agua: "sumar" si el cliente pide agregar al actual ("sumale 5", "agrega 10"), "restar" si pide quitar ("quitale 3", "sacale 2"), "reemplazar" si pide un valor fijo ("que sean 20", "cambialo a 50") o si es un pedido nuevo desde cero, "mantener" si no se menciona agua en el mensaje.'),
  cantidad_crema: z.number().describe('Valor literal mencionado en el mensaje para crema (no calcules sumas/restas). 0 si no se mencionó.'),
  cantidad_crema_operacion: z.enum(['sumar', 'restar', 'reemplazar', 'mantener']).describe('Que hacer con cantidad_crema. Mismas reglas que cantidad_agua_operacion.'),
  // SEÑAL DE TIPO AMBIGUO: el cliente dijo CUÁNTOS quiere pero no si son de
  // agua o de crema ("quiero 50 helados de frutilla"). No se puede adivinar (un
  // mismo sabor existe en los dos tipos), así que el modelo NO reparte esa
  // cantidad: la deja acá y TS le pregunta el tipo al cliente. No se persiste.
  // Nullable (no opcional): Groq exige structured output ESTRICTO, o sea todas las
  // claves en `required` — un campo opcional hace fallar la request entera. Pero el
  // modelo tiende a devolver null cuando el campo no aplica, y eso NO debe tumbar la
  // extracción por validación: null se lee como 0 ("no hay ambigüedad de tipo"),
  // mismo criterio tolerante que la coerción de `normalizarMetodoPago`.
  cantidad_sin_tipo: z.number().nullable().describe('Cantidad de helados que el cliente pidió SIN decir si son de agua o de crema (ej: "quiero 50 helados de frutilla" -> 50). Es solo una señal para que el sistema le pregunte el tipo: NUNCA adivines el tipo ni repartas esa cantidad en cantidad_agua/cantidad_crema. 0 si dijo el tipo, si no dio cantidad, o si la cantidad se puede deducir del pedido actual.'),
  // OBSERVACIONES POR SLOT. El modelo NO fusiona: extrae los sabores de ESTE
  // mensaje por tipo de helado y elige una operación; TS combina con lo actual
  // y reconstruye el texto plano. Esto elimina la clase de bug donde el modelo,
  // al tener que devolver el string completo, pisaba el segmento del otro tipo.
  obs_agua: z.string().nullable().describe('SABORES de los helados de AGUA mencionados en ESTE mensaje (ej: "frutilla y menta", "10 de frutilla y 5 de limón"). Sin el prefijo "los de agua". null si no menciona sabores de agua.'),
  obs_agua_operacion: z.enum(['reemplazar', 'agregar', 'mantener', 'limpiar']).describe('"reemplazar" si el cliente define los sabores de agua ("los de agua que sean X"), "agregar" si suma un sabor a los de agua, "mantener" si no menciona sabores de agua, "limpiar" si pide sacarlos. En pedido nuevo: "reemplazar" si hay sabores de agua, "mantener" si no.'),
  obs_crema: z.string().nullable().describe('SABORES de los helados de CREMA mencionados en ESTE mensaje. Sin el prefijo "los de crema". null si no menciona sabores de crema.'),
  obs_crema_operacion: z.enum(['reemplazar', 'agregar', 'mantener', 'limpiar']).describe('Mismas reglas que obs_agua_operacion, para crema.'),
  obs_general: z.string().nullable().describe('Detalles de preparación SIN tipo específico (ej: "sin coco", "todos sin azúcar", "bien fríos"). NO pongas acá sabores que ya son de agua o de crema. null si no aplica.'),
  obs_general_operacion: z.enum(['reemplazar', 'agregar', 'mantener', 'limpiar']).describe('Mismas reglas que obs_agua_operacion, para los detalles generales.'),
  metodo_pago: z.string().nullable().describe('"efectivo", "transferencia" o null.'),
  // Señal ORTOGONAL a `intencion`: el modelo la llena SIEMPRE que haya una
  // pregunta real de negocio, aunque además clasifique el mensaje como
  // datos_pedido/confirmar/etc. Es lo que permite delegar la pregunta a un
  // humano sin perder el pedido (antes, con un solo enum, la pregunta mezclada
  // con datos se descartaba en silencio).
  pregunta_negocio: z.string().nullable().describe('La pregunta o planteo REAL de negocio que trae el mensaje (horarios, si llegan/cobertura de una zona, cuánto demora la entrega, qué sabores hay disponibles, stock, promos, venta mayorista, un reclamo/problema con un pedido, facturación). Copiala textual acá SIEMPRE que exista, aunque el mensaje además traiga cantidades/dirección/pago y la intención sea "datos_pedido". null si no hay una pregunta de negocio real (bromas, off-topic o mensajes sin sentido NO cuentan).'),
});

/**
 * Observaciones estructuradas por tipo de helado. Es la fuente de verdad
 * INTERNA del bot para el merge keyed (se guarda en la columna jsonb
 * `observaciones_detalle`). El humano nunca la ve: el dashboard sigue
 * mostrando/editando el texto plano `observaciones`, que es la proyección.
 */
export type ObsSlots = { agua: string | null; crema: string | null; general: string | null };

// `observaciones` (proyección plana) y `observaciones_detalle` (slots) los
// computamos en TS a partir de los 6 campos crudos del modelo, así que no
// vienen del schema directo.
export type PedidoIA = z.infer<typeof PedidoIASchema> & {
  datos_completos: boolean;
  observaciones: string | null;
  observaciones_detalle: ObsSlots;
};

/**
 * Pre-clasificador heurístico para evitar llamar al LLM cuando el mensaje es
 * inequívoco dado el estado del pedido (ej. "sí" en esperando_cancelacion,
 * "hola" cuando hay un pedido conocido).
 *
 * Normaliza para tolerar formas reales: tildes, mayúsculas, puntuación,
 * emojis y vocales estiradas ("Siiii!!" → "si", "holaaa 👋" → "hola"). Es
 * conservador: si la forma normalizada NO matchea exacto con uno de los
 * sets, devuelve null y el flujo cae al LLM normal.
 */
type IntencionShortCircuit = Extract<
  Intencion,
  'saludo' | 'confirmar' | 'confirmar_cancelacion' | 'rechazar_cancelacion'
>;

// Exportados (además de para el short-circuit) para que el endpoint de minería
// de expresiones pueda excluir lo que ya está cubierto. Ver scripts/minar-expresiones.mjs.
export const CONFIRMACIONES = new Set([
  'si', 'sip', 'sep', 'dale', 'ok', 'oka', 'oki', 'okey', 'okay',
  'listo', 'perfecto', 'va', 'vale', 'confirmo', 'confirmar', 'confirmalo',
  'claro', 'obvio', 'joya', 'bien', 'genial', 'bueno', 'buenisimo',
  'esta bien', 'esta perfecto', 'todo bien', 'todo ok',
  'asi esta', 'asi va', 'asi mismo', 'tal cual',
  'si confirmo', 'si dale', 'si esta bien', 'dale confirmo', 'si confirmar',
  // Imperativo voseo ("confirmá" → normaliza a "confirma"). Faltaba toda esta
  // familia: "Sí, confirmá." caía al LLM y, cuando el modelo la clasificaba mal,
  // no había ninguna red que la atrapara (hallazgo #1 del informe 32740622175).
  // OJO: el Set es COMPARTIDO entre estados — en esperando_cancelacion un match
  // devuelve confirmar_cancelacion. Estas entradas son del mismo verbo que ya
  // estaba ('confirmar'/'confirmo'/'confirmalo'), así que la semántica por estado
  // no cambia. Por eso NO se agrega 'mandalo'/'envialo': ahí significarían lo
  // contrario (mandar el pedido, no confirmar la cancelación).
  'confirma', 'si confirma', 'dale confirma', 'si confirmalo',
  'confirmame', 'confirmamelo', 'confirmado', 'si confirmado',
]);

export const NEGACIONES = new Set([
  'no', 'nop', 'nope', 'nah', 'no gracias', 'nones', 'mejor no',
]);

export const SALUDOS = new Set([
  'hola', 'ola', 'holi', 'holis', 'hi', 'hello', 'ey', 'hey',
  'buenas', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches',
  'que tal', 'que onda', 'como estas', 'como andas', 'como va',
  'hola buenas', 'hola que tal',
]);

export function normalizarTextoShortCircuit(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')           // sin tildes
    .replace(/[¿?¡!.,;:()"'*~_]/g, ' ')                          // puntuación a espacio
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')   // emojis comunes
    .replace(/([aeiou])\1+/g, '$1')                             // colapsa vocales estiradas
    .replace(/\s+/g, ' ')
    .trim();
}

export function intentarShortCircuit(
  texto: string,
  estado: string | null,
): IntencionShortCircuit | null {
  const n = normalizarTextoShortCircuit(texto);
  if (!n) return null;

  if (estado === 'esperando_cancelacion') {
    if (CONFIRMACIONES.has(n)) return 'confirmar_cancelacion';
    if (NEGACIONES.has(n)) return 'rechazar_cancelacion';
  }

  if (estado === 'borrador' && CONFIRMACIONES.has(n)) {
    return 'confirmar';
  }

  // Saludo solo cuando ya hay un estado conocido (pedido activo).
  // Sin estado, podría haber un pedido a medio armar en el historial y un
  // "hola" suelto sería el final del armado, no un saludo puro — lo dejamos
  // pasar al LLM para que lo integre con el contexto.
  if (estado && SALUDOS.has(n)) {
    return 'saludo';
  }

  return null;
}

function pedidoDesdeShortCircuit(
  tipo: IntencionShortCircuit,
  pedidoActivo: PedidoActivoContext | null,
): PedidoIA {
  return {
    intencion: tipo,
    direccion: null,
    aclaracion: null,
    aclaracion_operacion: 'mantener',
    cantidad_agua: pedidoActivo?.cantidad_agua ?? 0,
    cantidad_agua_operacion: 'mantener',
    cantidad_crema: pedidoActivo?.cantidad_crema ?? 0,
    cantidad_crema_operacion: 'mantener',
    // Un saludo/confirmación/cancelación nunca trae una cantidad sin tipo.
    cantidad_sin_tipo: 0,
    // El short-circuit (saludo/confirmar/cancelar) nunca modifica sabores:
    // todas las operaciones son "mantener" y arrastramos lo que ya había.
    obs_agua: null, obs_agua_operacion: 'mantener',
    obs_crema: null, obs_crema_operacion: 'mantener',
    obs_general: null, obs_general_operacion: 'mantener',
    observaciones: pedidoActivo?.observaciones ?? null,
    observaciones_detalle: leerSlots(pedidoActivo),
    metodo_pago: null,
    // Los mensajes que atrapa el short-circuit (saludo/confirmar/cancelar) nunca
    // son una consulta de negocio, así que nunca hay pregunta que delegar.
    pregunta_negocio: null,
    datos_completos: false,
  };
}

/**
 * Aplica la operación de cantidad de forma determinista (no se la dejamos al modelo).
 * El modelo solo identifica la intención + valor; nosotros hacemos la matemática.
 * Nunca devuelve negativos.
 */
export function aplicarOperacionCantidad(
  operacion: 'sumar' | 'restar' | 'reemplazar' | 'mantener',
  valor: number,
  actual: number
): number {
  switch (operacion) {
    case 'sumar': return Math.max(0, actual + valor);
    case 'restar': return Math.max(0, actual - valor);
    case 'reemplazar': return Math.max(0, valor);
    case 'mantener': return actual;
  }
}

/**
 * Aplica la operación de aclaración de forma determinista. Misma filosofía que
 * aplicarOperacionCantidad: el modelo solo extrae el texto literal de ESTE
 * mensaje + la operación; TS es dueño de la fusión.
 *
 * - "agregar": el modelo manda solo el detalle nuevo; concatenamos con coma.
 *   Esto evita la clase de bug donde el modelo, al tener que devolver la
 *   concatenación completa, perdía o mangaba la parte vieja.
 * - "reemplazar": corrección semántica (contradice lo actual). El modelo SÍ
 *   manda el texto ya fusionado/corregido porque eso no se puede hacer en TS.
 * - "mantener": no se mencionó aclaración; conservamos lo actual.
 */
export function aplicarOperacionAclaracion(
  operacion: 'agregar' | 'reemplazar' | 'mantener',
  texto: string | null,
  actual: string | null,
): string | null {
  switch (operacion) {
    case 'mantener': return actual;
    case 'reemplazar': return texto ?? actual; // defensivo: reemplazar sin texto = no tocar
    case 'agregar':
      if (!texto) return actual;
      if (!actual) return texto;
      return `${actual}, ${texto}`;
  }
}

/**
 * Resuelve la aclaración final combinando la operación del modelo con el estado.
 *
 * Si el cliente CAMBIA la dirección a una distinta y válida, la aclaración previa
 * pertenecía a la dirección vieja (color de casa, portón, etc.) y ya no aplica:
 * la descartamos como base del merge para no arrastrar detalles contradictorios
 * (ej: "portón rojo" de la casa anterior + "portón gris" de la nueva). Solo
 * conservamos lo que traiga ESTE mensaje. Gateamos con `pareceDireccion` para no
 * descartar por una dirección basura que el guard de formato va a anular igual.
 *
 * Vive como helper puro (no inline) para que el endpoint dev /api/dev/test-ia lo
 * reuse y el eval mida exactamente lo que corre en producción.
 */
export function resolverAclaracion(
  operacion: 'agregar' | 'reemplazar' | 'mantener',
  texto: string | null,
  aclaracionActual: string | null,
  direccionNueva: string | null,
  direccionActual: string | null,
): string | null {
  const cambiaDireccion =
    direccionActual != null &&
    direccionNueva != null &&
    direccionNueva !== direccionActual &&
    pareceDireccion(direccionNueva);
  const base = cambiaDireccion ? null : aclaracionActual;
  return aplicarOperacionAclaracion(operacion, texto, base);
}

/**
 * Lee los slots de observaciones de un pedido. Si la columna jsonb está vacía
 * (fila vieja pre-migración, o edición manual del dashboard que la setea null),
 * siembra `general` con el texto plano para no perder nada — degrada limpio:
 * el bot pierde granularidad por tipo hasta que el cliente vuelva a hablar por
 * tipo, pero nunca borra datos.
 */
export function leerSlots(pedidoActivo: PedidoActivoContext | null): ObsSlots {
  const detalle = pedidoActivo?.observaciones_detalle;
  if (detalle && typeof detalle === 'object' && !Array.isArray(detalle)) {
    const d = detalle as Record<string, unknown>;
    return {
      agua: typeof d.agua === 'string' ? d.agua : null,
      crema: typeof d.crema === 'string' ? d.crema : null,
      general: typeof d.general === 'string' ? d.general : null,
    };
  }
  return { agua: null, crema: null, general: pedidoActivo?.observaciones ?? null };
}

/**
 * Aplica una operación de slot. Igual que aplicarOperacionAclaracion + "limpiar".
 */
export function aplicarOperacionObs(
  operacion: 'reemplazar' | 'agregar' | 'mantener' | 'limpiar',
  texto: string | null,
  actual: string | null,
): string | null {
  switch (operacion) {
    case 'mantener': return actual;
    case 'limpiar': return null;
    case 'reemplazar': return texto ?? actual; // defensivo: reemplazar sin texto = no tocar
    case 'agregar':
      if (!texto) return actual;
      if (!actual) return texto;
      return `${actual}, ${texto}`;
  }
}

/**
 * Reconstruye el texto plano de observaciones a partir de los slots. Es la
 * proyección que ven la cocina, el dashboard y el resumen al cliente. Reproduce
 * el formato histórico ("los de agua X, los de crema Y, <general>").
 */
export function reconstruirObservaciones(slots: ObsSlots): string | null {
  const partes = [
    slots.agua ? `los de agua ${slots.agua}` : '',
    slots.crema ? `los de crema ${slots.crema}` : '',
    slots.general ?? '',
  ].filter(Boolean);
  return partes.length ? partes.join(', ') : null;
}

// Palabras que indican una referencia de UNIDAD (aclaración), no el nombre de
// una calle. Un texto cuyo único componente alfabético es uno de estos NO es
// una dirección entregable.
const PALABRAS_NO_CALLE = new Set([
  'depto', 'dpto', 'depa', 'departamento', 'piso', 'torre', 'casa', 'lote',
  'mz', 'manzana', 'block', 'bloque', 'timbre', 'interno', 'int', 'conjunto',
  'barrio', 'edificio', 'monoblock', 'ph', 'unidad', 'sector', 'entre',
  'esquina', 'esq', 'frente', 'fondo',
]);

/**
 * Heurística de FORMATO (no semántica) para decidir si un texto parece una
 * dirección de calle entregable: necesita un NÚMERO (altura) y un NOMBRE de
 * calle (palabra de ≥3 letras que no sea una referencia de unidad como
 * "depto"/"piso"). "retira" es un sentinela válido.
 *
 * Es la red determinista del #7: respalda —no reemplaza— el juicio del modelo.
 * Descarta extracciones donde el modelo metió en `direccion` algo que era una
 * aclaración ("depto 6") o una calle sin altura ("Mitre"). Acepta formas reales
 * como "9 de Julio 23", "Av. San Martín 1234", "Calle 12 1450", "Ruta 8 km 5".
 */
export function pareceDireccion(texto: string | null): boolean {
  if (!texto) return false;
  const t = texto.trim();
  if (t.toLowerCase() === 'retira') return true;

  if (!/\b\d{1,5}\b/.test(t)) return false; // sin altura no es entregable

  const palabras = t
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin tildes
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  return palabras.some(p => /^[a-z]{3,}$/.test(p) && !PALABRAS_NO_CALLE.has(p));
}

/**
 * ¿El texto del cliente expresa que pasa a RETIRAR (retiro en el local) en vez
 * de pedir envío a domicilio? Red determinista que respalda —no reemplaza— al
 * modelo, igual que `pareceDireccion`: si el cliente lo dice pero el modelo no
 * puso el sentinela "retira" en `direccion`, lo seteamos nosotros. Tolera
 * tildes, mayúsculas y las variantes/conjugaciones reales ("retiro", "paso a
 * retirar", "lo paso a buscar", "lo busco", "paso por el local").
 *
 * Se aplica SOLO cuando no quedó una dirección de envío válida, así una frase
 * ambigua tipo "Corrientes 1234, retiro" prioriza la calle real.
 */
export function mencionaRetiro(texto: string | null): boolean {
  if (!texto) return false;
  const n = texto
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // sin tildes

  // Verbo/sustantivo "retirar/retiro" en sus formas comunes: retiro, retira,
  // retirar, retirarlo, retiramos, retirá, retiré, retiro en el local...
  if (/\bretir(o|a|e|ar|as|amos|an|á|é|ó)/.test(n)) return true;

  // "paso/pasamos/voy/vamos/vengo a buscar(lo)" y "lo/los busco".
  if (/\b(paso|pasamos|pasa|voy|vamos|vengo|venimos|pasar)\b[^.]{0,20}\bbuscar/.test(n)) return true;
  if (/\b(lo|los|la|las)\s+busco\b/.test(n)) return true;

  // "paso por el local/negocio/sucursal".
  if (/\bpas(o|amos|a)\s+por\s+(el\s+|la\s+)?(local|negocio|sucursal)\b/.test(n)) return true;

  return false;
}

/**
 * ¿El cliente está RECHAZANDO explícitamente la cancelación? Red determinista que
 * respalda —no reemplaza— al modelo en estado `esperando_cancelacion`, igual que
 * `mencionaRetiro`. El caso real que la motiva (hallazgo #2 del informe): "No, no
 * lo cancelo, dame el total ya" — una negación clara mezclada con un pedido de
 * precio que desviaba la clasificación del modelo, dejando el pedido trabado en
 * `esperando_cancelacion`.
 *
 * Matchea negaciones explícitas de cancelar ("no lo cancelo", "no canceles", "no
 * quiero cancelar", "dejalo así", "no, mantenelo", "no lo anules"). NO matchea un
 * simple "no" suelto (eso ya lo agarra el short-circuit / el modelo) ni un "no"
 * que trae cambios concretos del pedido (eso es rechazo implícito + modificación,
 * ya manejado aparte). Tolera tildes y mayúsculas. Pura y exportada para test.
 */
export function mencionaRechazoCancelacion(texto: string | null): boolean {
  if (!texto) return false;
  const n = texto
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // sin tildes

  // "no ... cancel(o|es|ar|en)" / "no ... anul(o|es|ar|en)": negación + verbo de
  // cancelar/anular cerca (hasta ~20 chars entre medio, para "no lo cancelo",
  // "no la canceles", "no quiero cancelar", "no lo anules").
  if (/\bno\b[^.]{0,20}\bcancel(o|a|as|e|es|en|ar|arlo|arla)\b/.test(n)) return true;
  if (/\bno\b[^.]{0,20}\banul(o|a|as|e|es|en|ar|arlo|arla)\b/.test(n)) return true;

  // "dejalo (asi/como esta)" / "mantenelo" / "no lo toques": pedir que quede como está.
  if (/\bdejalo\b/.test(n)) return true;
  if (/\bmanten(elo|elo asi|lo|emelo)\b/.test(n)) return true;
  if (/\bno\b[^.]{0,15}\btoques\b/.test(n)) return true;

  return false;
}

/**
 * ¿El cliente está CONFIRMANDO explícitamente el borrador? Red determinista que
 * respalda —no reemplaza— al modelo en estado `borrador`, mismo idioma que
 * `mencionaRechazoCancelacion`.
 *
 * El caso real que la motiva (hallazgo #1 del informe 32740622175): tras rechazar
 * una cancelación, el cliente escribió "Sí, confirmá." y el bot repitió el resumen
 * en loop en vez de mandarlo a cocina. `CONFIRMACIONES` no lo atrapó porque el
 * short-circuit matchea el MENSAJE COMPLETO exacto, y el modelo clasificó mal.
 * Esta red trabaja sobre el texto crudo, así que tolera la confirmación mezclada
 * con otras palabras ("dale, confirmalo por favor", "listo, confirmame el pedido").
 *
 * NO matchea una negación ("no confirmes", "todavía no confirmo") ni una pregunta
 * ("¿cuándo confirmás?"). Pura y exportada para test.
 */
/**
 * Intenciones en las que el cliente pidió algo concreto y distinto de "confirmá".
 * Si el modelo eligió una de estas, su decisión manda y la red de confirmación no
 * interviene (no queremos pisar un "cancelá" ni una consulta con un `confirmar`).
 */
const INTENCIONES_ACCIONABLES: Intencion[] = [
  'confirmar', 'cancelar', 'modificar_sin_datos', 'consultar_precios', 'consulta_negocio',
];

export function mencionaConfirmacion(texto: string | null): boolean {
  if (!texto) return false;
  const n = texto
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // sin tildes

  // Vetos primero: si hay negación o pregunta cerca del verbo, no es confirmación.
  if (/\bno\b[^.]{0,15}\bconfirm/.test(n)) return false;
  if (/\b(todavia|aun)\b[^.]{0,15}\bconfirm/.test(n)) return false;
  if (/\b(cuando|como|donde|quien|que)\b[^.]{0,10}\bconfirm/.test(n)) return false;

  return /\bconfirm(a|o|alo|ala|ame|amelo|arlo|arla|ar|ado)\b/.test(n);
}

/**
 * Afirmaciones que, como palabra suelta dentro de un mensaje más largo, siguen
 * leyéndose como un "sí". Deliberadamente NO incluye las ambiguas que aparecen
 * naturalmente en una oración ("va", "vale", "bien", "bueno"): acá un falso
 * positivo desactiva el veto de abajo, que es la dirección peligrosa.
 */
const AFIRMACIONES_SUELTAS = new Set([
  'si', 'sip', 'sep', 'dale', 'ok', 'oka', 'oki', 'okey', 'okay',
  'listo', 'perfecto', 'claro', 'obvio', 'joya', 'exacto', 'correcto',
]);

/**
 * ¿Hay ALGUNA señal textual de que el cliente está afirmando/confirmando? Más
 * amplia que `mencionaConfirmacion` (que solo mira el verbo "confirmar"): también
 * acepta un "sí"/"dale"/"listo" suelto dentro de un mensaje más largo.
 *
 * Se usa para el veto de confirmación fantasma, no para disparar confirmaciones.
 * Pura y exportada para test.
 */
export function traeSenalDeConfirmacion(texto: string | null): boolean {
  if (!texto) return false;
  if (mencionaConfirmacion(texto)) return true;
  const n = normalizarTextoShortCircuit(texto);
  if (!n) return false;
  return n.split(' ').some(palabra => AFIRMACIONES_SUELTAS.has(palabra));
}

/**
 * Qué responder cuando el pedido en armado está incompleto. La regla: si falta
 * UN solo dato y es una elección cerrada, se pide con botones (pago) o con un
 * botón de atajo (retiro cuando falta la dirección); si faltan varios, lista de
 * texto. Pura y exportada para tests — el envío queda en el flow.
 */
/**
 * Señal de "el cliente dio la cantidad pero no el tipo (agua/crema)": la cantidad
 * que quedó sin asignar y el texto crudo del cliente (el sabor que mencionó es lo
 * que hace útil la redacción libre). `null` = no hay ambigüedad de tipo.
 */
export type TipoHeladoAmbiguo = {
  cantidad: number;
  textoCliente: string;
  // Operación a aplicar cuando el cliente elija el tipo. Ausente = 'reemplazar'
  // (el caso original: "quiero 50 helados de frutilla" / "que sean 30"). 'sumar'/
  // 'restar' vienen de un delta pelado ("sumale 10") sobre un pedido con los dos
  // tipos: hay que preguntar el tipo, pero la respuesta suma/resta, no reemplaza.
  operacion?: 'sumar' | 'restar' | 'reemplazar';
};

export type RespuestaDatosFaltantes =
  | { tipo: 'botones_pago' }
  | { tipo: 'boton_retira' }
  | { tipo: 'botones_tipo_helado'; cantidad: number; operacion: 'sumar' | 'restar' | 'reemplazar'; mensaje: string }
  | { tipo: 'texto'; mensaje: string };

// Variantes del saludo de "arranquemos tu pedido" (cuando faltan los 3 datos).
// Se rota según un `seed` determinista para no repetir el MISMO texto palabra
// por palabra ante mensajes off-topic consecutivos, que se sentía robótico
// (#4 del informe). La variante 0 es la histórica (los tests con seed por
// defecto la esperan). El comportamiento de fondo no cambia: sigue siendo el
// mismo pedido de los 3 datos, solo varía el saludo de arriba.
const BIENVENIDAS_DATOS_FALTANTES = [
  "¡Hola! 👋 ¿Qué te gustaría pedir? Mandame:",
  "¡Buenas! 🍦 Contame qué querés y te lo armo. Necesito:",
  "¡Hola! 😋 Dale, armamos tu pedido. Pasame:",
];

export function elegirRespuestaDatosFaltantes(
  faltaCantidad: boolean,
  faltaDireccion: boolean,
  faltaPago: boolean,
  seed = 0,
  cantidadEnUnidadNoSoportada = false,
  pagoNoSoportado = false,
  cantidadSinTipo = 0,
  operacionSinTipo: 'sumar' | 'restar' | 'reemplazar' = 'reemplazar',
): RespuestaDatosFaltantes {
  // TIPO DE HELADO SIN DEFINIR: el cliente dijo CUÁNTOS quiere pero no si son de
  // agua o de crema, así que "me falta la cantidad" es falso (ya la dio) y
  // confuso. Tiene prioridad sobre el resto de los faltantes: hasta que no se
  // sepa el tipo no hay cantidad que guardar, y es una elección cerrada de dos
  // opciones (va con botones). El `mensaje` es el piso determinista; el caller
  // intenta primero una redacción libre acotada (que puede nombrar en qué tipo
  // está el sabor que pidió). Si además la cantidad venía en una unidad que no
  // vendemos, gana ese caso: no hay número que asignarle a ningún tipo.
  //
  // NO exige `faltaCantidad`: la señal también llega con cantidades YA cargadas,
  // cuando el cliente corrige con un número pelado sobre un pedido que tiene los
  // DOS tipos ("mejor que sean 30"). Ahí tampoco se puede adivinar a cuál se
  // refiere, y descartarlo en silencio es justamente el bug que esto evita.
  if (cantidadSinTipo > 0 && !cantidadEnUnidadNoSoportada) {
    // El texto de la pregunta cambia según la operación: para un delta pelado
    // ("sumale 10") no preguntamos "¿esos 10 los querés de agua o de crema?"
    // (que suena a reemplazo), sino "¿esos 10 que querés sumar/sacar…?".
    const mensaje =
      operacionSinTipo === 'sumar'
        ? `¿Esos ${cantidadSinTipo} que querés sumar, son de agua o de crema? 🍦`
        : operacionSinTipo === 'restar'
          ? `¿Esos ${cantidadSinTipo} que querés sacar, son de agua o de crema? 🍦`
          : `¿Esos ${cantidadSinTipo} los querés de agua o de crema? 🍦`;
    return {
      tipo: 'botones_tipo_helado',
      cantidad: cantidadSinTipo,
      operacion: operacionSinTipo,
      mensaje,
    };
  }

  // Falta solo el pago y el cliente mencionó un método no soportado →
  // aclaramos explícitamente en vez de ofrecer los botones sin contexto.
  if (!faltaCantidad && !faltaDireccion && faltaPago && pagoNoSoportado) {
    return {
      tipo: 'texto',
      mensaje: "Por ahora solo aceptamos *efectivo* o *transferencia* 🙏 ¿Cuál preferís?",
    };
  }
  if (!faltaCantidad && !faltaDireccion && faltaPago) return { tipo: 'botones_pago' };
  if (!faltaCantidad && faltaDireccion && !faltaPago) return { tipo: 'boton_retira' };

  // El cliente expresó la cantidad en una unidad que no vendemos (kilo/pote/
  // porción/bola/cucurucho). El "me falta la cantidad" genérico entra en loop
  // porque el cliente cree que ya la dio: le explicamos por qué no cuenta y le
  // pedimos unidades explícitas.
  //
  // NO exige `faltaCantidad`: también llega con un pedido YA completo, cuando el
  // cliente intenta CORREGIR la cantidad en kilos ("que sean 2 kilos") sobre un
  // borrador que ya tiene 40 unidades. Ahí el número tampoco se puede usar, y sin
  // esta rama el mensaje caía al fallback y recibía un "no te entendí" que no
  // explica nada.
  if (!faltaDireccion && !faltaPago && cantidadEnUnidadNoSoportada) {
    return {
      tipo: 'texto',
      mensaje: "Los helados los vendemos por unidad (de agua o de crema), no por kilo/pote/porción 🍦 ¿Cuántas unidades querés? (ej: *10 de agua y 5 de crema*)",
    };
  }

  const datosFaltantes: string[] = [];
  if (faltaCantidad) {
    datosFaltantes.push(
      cantidadEnUnidadNoSoportada
        ? "Cantidad de helados por unidad (los vendemos por unidad, no por kilo/pote) — ¿cuántos en total?"
        : "Cantidades de helado (agua/crema)"
    );
  }
  if (faltaDireccion) datosFaltantes.push("Dirección de envío (o si pasás a retirar)");
  if (faltaPago) datosFaltantes.push("Forma de pago (efectivo o transferencia)");

  const encabezado = datosFaltantes.length === 3
    ? BIENVENIDAS_DATOS_FALTANTES[Math.abs(seed) % BIENVENIDAS_DATOS_FALTANTES.length]
    : "Para armar tu pedido me falta:";
  return { tipo: 'texto', mensaje: [encabezado, ...datosFaltantes.map(d => `• ${d}`)].join('\n') };
}

/**
 * Guard determinista: ¿el cliente mencionó un método de pago que no aceptamos?
 * (tarjeta, débito, crédito, mercado pago como "tarjeta de MP", Rapipago, etc.)
 * Cuando el modelo correctamente devuelve metodo_pago=null y el flow pide
 * "¿cómo lo pagás?" sin explicar, el cliente cree que no lo escucharon.
 * Corre sobre el texto CRUDO del batch, no sobre la extracción del modelo.
 */
export function mencionaMetodoPagoNoSoportado(texto: string | null): boolean {
  if (!texto) return false;
  const n = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return (
    /\btarjeta\b/.test(n) ||
    /\bdebito\b/.test(n) ||
    /\bcredito\b/.test(n) ||
    /\bposnet\b/.test(n) ||
    /\brapipago\b/.test(n) ||
    /\bpago\s*facil\b/.test(n)
  );
}

/**
 * Guard determinista (respalda al modelo): ¿el cliente expresó la cantidad en
 * una unidad que no vendemos? kilos/gramos, potes, porciones, bolas servidas,
 * cucuruchos. El prompt ya le dice al modelo que no convierta esos a unidades
 * (deja cantidad en 0), pero sin esta señal el flow responde con el "me falta
 * cantidad" genérico y el cliente entra en loop porque cree que ya la dio.
 * Corre sobre el texto CRUDO del batch, no sobre la extracción del modelo.
 */
export function mencionaCantidadEnUnidadNoSoportada(texto: string | null): boolean {
  if (!texto) return false;
  const n = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return UNIDADES_NO_SOPORTADAS.some(re => re.test(n));
}

const UNIDADES_NO_SOPORTADAS = [
  /\b(kilos?|kilogramos?|kg)\b/,
  /\bgramos?\b/,
  /\bpotes?\b/,
  /\bporcion(es)?\b/,
  /\bbol(a|as|ita|itas)\b/,
  /\bcucuruchos?\b/,
];

/**
 * ¿El número que el modelo extrajo viene de una unidad que NO vendemos? Veto
 * determinista sobre la cantidad, no sobre el mensaje de respuesta.
 *
 * El prompt le pide al modelo dejar en "mantener" las cantidades expresadas en
 * kilos/potes/porciones/bolas, pero no siempre obedece: con 40 de crema cargados,
 * "que sean 2 kilos" volvió como `cantidad_crema: 2, reemplazar` y el pedido pasó
 * de 40 unidades a **2** ($16.000 → $800). Eso es corrupción silenciosa de datos:
 * mucho peor que no entender el mensaje.
 *
 * Se evalúa POR CLÁUSULA, igual que `detectarCantidadPelada`: solo vetea si el
 * número aparece en la misma cláusula que la unidad rara. Así "que sean 30
 * unidades, no 2 kilos" conserva los 30, que es un dato válido que el cliente sí
 * dio. Pura y exportada para test.
 */
export function cantidadVieneDeUnidadNoSoportada(texto: string | null, valor: number): boolean {
  if (!texto || !Number.isFinite(valor) || valor <= 0) return false;
  const n = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  for (const clausula of n.split(/[.;,]/)) {
    if (!UNIDADES_NO_SOPORTADAS.some(re => re.test(clausula))) continue;
    if (new RegExp(`\\b${valor}\\b`).test(clausula)) return true;
  }
  return false;
}

/**
 * Guard determinista (respalda al modelo): ¿el cliente dijo el TIPO de helado
 * (de agua o de crema)? Se usa como VETO de la señal `cantidad_sin_tipo`: si el
 * texto crudo SÍ nombra el tipo, no le preguntamos nada aunque el modelo haya
 * llenado la señal por no-determinismo.
 *
 * Ojo con los sabores que contienen la palabra de un tipo ("Crema del Cielo" es un
 * sabor DE AGUA): los borramos del texto antes de buscar el tipo, así "50 de crema
 * del cielo" no cuenta como "dijo crema". Corre sobre el texto CRUDO del batch.
 */
export function mencionaTipoHelado(texto: string | null): boolean {
  if (!texto) return false;
  const sinTildes = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  let n = sinTildes(texto);
  for (const sabor of [...SABORES.agua, ...SABORES.crema]) {
    const s = sinTildes(sabor);
    // Solo los sabores que contienen "agua"/"crema" pueden confundir al guard.
    if (s.includes('agua') || s.includes('crema')) n = n.split(s).join(' ');
  }

  return /\baguas?\b/.test(n) || /\bcremas?\b/.test(n);
}

// Palabras que hacen que un número NO sea una cantidad de helados: partes de una
// dirección/aclaración, o unidades que no vendemos (el prompt ya deja esas en 0).
const CONTEXTO_NO_CANTIDAD =
  /(depto|dpto|departamento|piso|torre|timbre|nro|numero|calle|altura|km|kilo|gramo|kg|gr|pote|bola|porcion|cucurucho|copa)/;

// Pistas de que el número es un DELTA y no un total. Si aparecen pegadas al
// número, la operación la resuelve el modelo (sumar/restar), no esta red.
const PISTAS_DELTA = /(mas|menos|sumale|sumal|suma|quitale|quital|saca|sacale|agrega|agregale|otros|otras)/;

/**
 * ¿El mensaje trae una cantidad "pelada" (un número sin decir si es de agua o de
 * crema) que corrige el pedido? Red determinista que respalda al modelo, mismo
 * idioma que `mencionaRetiro` / `mencionaTipoHelado`.
 *
 * El caso real que la motiva (hallazgo #3 del informe 32740622175): con 20 de
 * crema cargados, "espera un toque, me pidieron mas. son 30 ahora" y después
 * "che, se me va la mano, son 40" NO se aplicaron nunca. El modelo devolvía
 * `mantener` (el prompt decía "mantener: no menciona ese tipo en el mensaje"),
 * y `aplicarOperacionCantidad` descarta el literal en silencio cuando la
 * operación es `mantener`.
 *
 * Devuelve el número, o null si no hay una cantidad pelada reconocible.
 *
 * Los vetos se aplican POR CLÁUSULA, no sobre todo el texto: solo descartan si la
 * pista ("más", "sumale", "piso"…) está en la misma cláusula que el número. Es
 * exactamente lo que hace que el caso real dispare — ese "mas" pertenece a otra
 * oración ("me pidieron mas."), no al 30. Un veto global mataría el caso que
 * vinimos a arreglar.
 *
 * Pura y exportada para test. Quien la llama decide a qué tipo aplicarla.
 */
export function detectarCantidadPelada(texto: string | null): number | null {
  if (!texto) return null;
  const n = texto
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Un desglose por sabores ("10 de frutilla y 5 de menta") no es una cantidad
  // pelada: son varios números que el modelo ya sabe sumar dentro de un tipo.
  if ((n.match(/\d+\s+de\s+[a-z]/g) ?? []).length >= 2) return null;

  // Pista ADELANTE del número ("son 30", "que sean 30", "ponele 30") o ATRÁS
  // ("30 ahora", "30 en total"). Ambas formas aparecen en conversación real.
  const patrones = [
    /\b(?:son|serian|seran|sean|ponele|pone|poneme|mejor|hacelo|haceme|dejalo en)\s+(\d{1,4})\b/,
    /\b(\d{1,4})\s+(?:ahora|en total|al final|entonces)\b/,
  ];

  // Partimos en cláusulas para que los vetos sean locales: "me pidieron mas." y
  // "son 30 ahora" son dos cláusulas distintas, y ese "mas" no califica al 30.
  for (const clausula of n.split(/[.;,]/)) {
    for (const patron of patrones) {
      const m = clausula.match(patron);
      if (!m) continue;

      if (PISTAS_DELTA.test(clausula)) continue;
      if (CONTEXTO_NO_CANTIDAD.test(clausula)) continue;

      const valor = Number.parseInt(m[1], 10);
      if (Number.isFinite(valor) && valor > 0) return valor;
    }
  }

  return null;
}

// Deltas que SUMAN / RESTAN sin nombrar el tipo. Complementan a PISTAS_DELTA:
// aquélla solo marca "acá hay un delta, no lo trates como total"; estas dos
// además dicen la DIRECCIÓN, que es lo que necesitamos para saber si el número
// se suma o se resta al aplicar la respuesta del cliente.
const PISTAS_DELTA_RESTAR = /\b(?:quitale|quital|quita|quitame|sacale|sacal|saca|sacame|restale|restame|resta|restar|bajale|baja|menos)\b/;
const PISTAS_DELTA_SUMAR = /\b(?:sumale|sumal|suma|sumame|agregale|agregame|agrega|agregales|añadile|anadile|otros|otras|mas)\b/;

/**
 * ¿El mensaje trae un DELTA "pelado" (un número que se suma o resta al pedido,
 * sin decir si es de agua o de crema)? El caso real: sobre un borrador completo
 * con los dos tipos cargados, "sumale 10" — el cliente quiere AGREGAR 10, pero
 * no dijo de qué tipo. El modelo deja la cantidad en `cantidad_sin_tipo` y no
 * aplica nada; sin esta red el mensaje cae al fallback y recibe un "no te
 * entendí" pese a ser una instrucción clarísima.
 *
 * Es la contraparte de `detectarCantidadPelada` (que resuelve REEMPLAZOS pelados
 * como "son 30 ahora"): aquélla vetea justamente los deltas (PISTAS_DELTA), así
 * que "sumale 10" le devuelve null. Acá los captamos y devolvemos la dirección.
 *
 * Mismos vetos por cláusula que sus hermanas (desglose por sabores y contexto de
 * dirección/unidad no soportada). Pura y exportada para test. Quien la llama
 * decide a qué tipo aplicarla (o si preguntar, cuando hay ambigüedad de tipo).
 */
export function detectarDeltaPelado(
  texto: string | null,
): { operacion: 'sumar' | 'restar'; valor: number } | null {
  if (!texto) return null;
  const n = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Un desglose por sabores ("10 de frutilla y 5 de menta") no es un delta pelado.
  if ((n.match(/\d+\s+de\s+[a-z]/g) ?? []).length >= 2) return null;

  // Veto de dirección/unidad no soportada. Con límites de palabra a propósito:
  // CONTEXTO_NO_CANTIDAD (sin \b) haría que "gr" de gramo matcheara dentro de
  // "agregale" y "sumale" nunca dispararía. Acá el número lo detectamos suelto,
  // así que necesitamos el borde. detectarCantidadPelada no sufre esto porque
  // exige una pista líder ("son"/"sean"/"ponele") que nunca es un delta.
  const contextoNoCantidad =
    /\b(depto|dpto|departamento|piso|torre|timbre|nro|numero|calle|altura|km|kilos?|gramos?|kg|gr|potes?|bolas?|porciones?|cucuruchos?|copas?)\b/;

  for (const clausula of n.split(/[.;,]/)) {
    if (contextoNoCantidad.test(clausula)) continue;

    const m = clausula.match(/\b(\d{1,4})\b/);
    if (!m) continue;
    const valor = Number.parseInt(m[1], 10);
    if (!Number.isFinite(valor) || valor <= 0) continue;

    // Restar primero: si aparecen las dos pistas ("saca 10, no menos"), la
    // resta es la instrucción explícita y gana.
    if (PISTAS_DELTA_RESTAR.test(clausula)) return { operacion: 'restar', valor };
    if (PISTAS_DELTA_SUMAR.test(clausula)) return { operacion: 'sumar', valor };
  }

  return null;
}

/**
 * ¿El mensaje trae datos concretos del pedido, además de lo que sea que el modelo
 * haya elegido como `intencion`? Mira SOLO el output crudo del modelo.
 *
 * El caso real que la motiva (hallazgo #2 del informe 32740622175): "transferencia.
 * y hasta que hora entregan?" sobre un borrador al que solo le faltaba el pago. El
 * modelo clasificó `consulta_negocio`, cuyo handler CORTA el flujo con return antes
 * de aplicar y persistir nada — el "transferencia" se descartó en silencio y el bot
 * volvió a pedir el pago en el turno siguiente.
 *
 * El prompt ya pide usar `datos_pedido` cuando el mensaje además trae datos, pero
 * es una regla soft. Esta es la red determinista equivalente a los overrides que ya
 * existen para `saludo`+datos y `modificar_sin_datos`+cambios.
 *
 * A PROPÓSITO no mira el texto crudo: si el modelo extrajo un dato, es señal fuerte
 * de que el mensaje lo traía. Una heurística de texto acá sería demasiado agresiva
 * en la dirección peligrosa — "retirar" aparece naturalmente en preguntas ("¿tengo
 * que retirar o hacen envío?"), y reclasificar eso como dato haría que una consulta
 * PURA le setee `direccion="retira"` a un cliente que nunca lo pidió. Cuando el
 * cliente sí dice que retira, el modelo pone el sentinela y `direccion` lo capta.
 *
 * Pura y exportada para test.
 */
export function traeDatosDePedido(pedido: PedidoIA): boolean {
  if (normalizarMetodoPago(pedido.metodo_pago) !== null) return true;
  if (pedido.cantidad_agua_operacion !== 'mantener') return true;
  if (pedido.cantidad_crema_operacion !== 'mantener') return true;
  if ((pedido.cantidad_sin_tipo ?? 0) > 0) return true;
  if (pedido.direccion !== null) return true;
  if (pedido.obs_agua_operacion !== 'mantener') return true;
  if (pedido.obs_crema_operacion !== 'mantener') return true;
  if (pedido.obs_general_operacion !== 'mantener') return true;
  return false;
}

/**
 * Intenciones que tienen sentido —y que tienen HANDLER— en un estado dado. Es la
 * misma lista que `buildSystemPrompt` le muestra al modelo; se extrae acá para que
 * el prompt y la validación no drifteen (se usa en los dos lados).
 */
export function intencionesValidasPara(
  estado: string | null,
  opciones?: { hayPedidoCanceladoReciente?: boolean },
): Intencion[] {
  const comunes: Intencion[] = ['saludo', 'consultar_precios', 'consulta_negocio', 'datos_pedido'];

  if (estado === 'esperando_cancelacion') {
    return ['confirmar_cancelacion', 'rechazar_cancelacion', ...comunes];
  }
  if (estado === 'borrador') {
    return ['cancelar', 'confirmar', 'modificar_sin_datos', ...comunes];
  }
  if (estado === 'pendiente' || estado === 'enviado') {
    // Pedido ya en cocina/despachado: no hay borrador que confirmar.
    return ['cancelar', 'modificar_sin_datos', ...comunes];
  }
  // Sin pedido activo. "reactivar" solo se ofrece si hay algo que reactivar.
  return [
    'cancelar',
    ...(opciones?.hayPedidoCanceladoReciente ? (['reactivar'] as Intencion[]) : []),
    ...comunes,
  ];
}

/**
 * Acota la intención que devolvió el modelo a las válidas para el estado actual.
 *
 * `IntencionEnum` es GLOBAL (el schema no puede variar por estado), así que el
 * modelo puede devolver, por ejemplo, `confirmar_cancelacion` estando en `borrador`.
 * El único handler de esa intención está encerrado dentro del bloque de
 * `esperando_cancelacion`, así que fuera de ahí es una intención HUÉRFANA: no
 * matchea ningún handler y el mensaje cae al fallback de "reenviar el resumen",
 * en loop y para siempre (hallazgo #1 del informe 32740622175).
 *
 * Coercionar a `datos_pedido` es seguro y no destructivo: es el catch-all que todos
 * los estados manejan. Nunca convertimos una intención en otra ACCIONABLE (eso sería
 * adivinar en la dirección peligrosa: cancelar o confirmar un pedido por nuestra
 * cuenta). Recuperar la intención real es tarea de las redes deterministas, que
 * miran el texto del cliente.
 *
 * Pura y exportada para test.
 */
export function clampIntencionPorEstado(
  intencion: Intencion,
  estado: string | null,
  opciones?: { hayPedidoCanceladoReciente?: boolean },
): Intencion {
  return intencionesValidasPara(estado, opciones).includes(intencion) ? intencion : 'datos_pedido';
}

/**
 * Campos mínimos de un pedidoActivo que necesita el prompt builder.
 * Usado tanto por el flujo real (donde pasa una row completa de pedidos)
 * como por el endpoint de dev (donde se construye una row sintética).
 */
export type PedidoActivoContext = {
  estado: string;
  cantidad_agua: number;
  cantidad_crema: number;
  direccion: string;
  aclaracion: string | null;
  observaciones: string | null;
  observaciones_detalle?: Json | null;
  metodo_pago: string;
  enviado?: boolean | null;
  // Total ya calculado del pedido (DB-side, vía procesar_pedido_final). Lo usa el
  // contexto de la respuesta libre para poder contestar "¿cuánto es mi total?".
  // null en un borrador todavía sin precio.
  precio_total?: number | null;
};

/**
 * ¿El pedido ya salió al cliente? Es TRUE con CUALQUIERA de las dos señales:
 *
 *   - estado === 'enviado': lo marca el usuario a mano en el dashboard, y muchas
 *     veces tarde (a veces recién al día siguiente).
 *   - enviado === true: se marca solo al copiar desde el sistema el mensaje para
 *     el cadete (copiar == "ya lo despaché"). Es la señal TEMPRANA y confiable.
 *
 * Por eso hay que mirar ambas, no solo el estado: entre que se copia el mensaje
 * (enviado=true) y que mueven el estado a 'enviado' hay una ventana en la que el
 * pedido YA salió pero estado sigue en 'pendiente'. Tratarlo como despachado en
 * esa ventana evita que el bot deje cancelar/modificar algo que ya está en camino.
 *
 * LA CANCELACIÓN GANA SIEMPRE: si estado='cancelado' devolvemos false aunque
 * enviado=true. patchConEnviadoCoherente ya fuerza enviado=false al cancelar
 * desde el dashboard, pero las cancelaciones del bot (auto-rechazo y cancelación
 * colgada en /api/gestionar-borradores) NO limpian el booleano, así que podría
 * quedar un enviado=true colgado sobre un cancelado. Sin este cortocircuito eso
 * re-introduciría el viejo bug de "tu pedido ya fue despachado" sobre algo que
 * el cliente canceló — y además un cancelado no está "en camino" por definición.
 */
export function estaDespachado(p: { estado?: string | null; enviado?: boolean | null }): boolean {
  if (p.estado === 'cancelado') return false;
  return p.estado === 'enviado' || p.enviado === true;
}

// Minutos desde que un pedido entró a cocina ('pendiente') durante los cuales
// el bot todavía deja que el cliente lo modifique solo (cantidades, dirección,
// sabores, pago) sin pasar por un humano. Pasado esto, la cocina puede ya
// estar preparándolo y un cambio silencioso es más riesgoso que demorar el
// cambio hasta que lo vea un operador.
export const PLAZO_MODIFICACION_COCINA_MIN = 15;

/**
 * ¿Todavía se puede modificar un pedido 'pendiente' sin intervención humana?
 * `msDesdeEntradaCocina` es `Date.now() - entro_a_cocina_at` (estampado por el
 * trigger de DB `mantener_entro_a_cocina` al pasar a 'pendiente', ver la
 * migración 20260804120000). `null` cuando el pedido no tiene la marca (fila
 * de antes de la migración): no bloqueamos — la restricción es nueva y no debe
 * afectar pedidos que ya estaban en curso. Pura y exportada para test.
 */
export function dentroDePlazoModificacionCocina(msDesdeEntradaCocina: number | null): boolean {
  if (msDesdeEntradaCocina === null) return true;
  return msDesdeEntradaCocina < PLAZO_MODIFICACION_COCINA_MIN * 60 * 1000;
}

/**
 * Cola contextual para las consultas (precios / negocio) que se resuelven sin
 * tocar el pedido: si el hilo tiene algo en juego, se lo recordamos para que la
 * consulta no le pierda el pedido en el medio.
 *
 * CLAVE: un borrador puede estar COMPLETO (ya se mandó el resumen y espera un
 * SÍ/NO) o EN ARMADO (falta dirección/pago/cantidad). Mandar "Respondé SÍ o NO"
 * sobre un borrador incompleto confunde al cliente, que en realidad está en el
 * paso de elegir pago/dirección/cantidad — no en el de confirmar. Por eso solo
 * usamos la cola de confirmación cuando `esBorradorCompleto`; si está en armado,
 * lo empujamos a completar lo que falta.
 */
export function colaRecordatorioPedido(pedidoActivo: PedidoActivoContext | null | undefined): string {
  if (pedidoActivo?.estado === 'borrador') {
    return esBorradorCompleto(pedidoActivo)
      ? '\n\n👆 Ojo: tu pedido sigue esperando tu confirmación. ¿Está todo bien? Respondé *SÍ* o *NO*.'
      : '\n\n👆 Ojo: tu pedido sigue en armado. Cuando puedas, pasame lo que falta para cerrarlo 🙌';
  }
  if (pedidoActivo?.estado === 'esperando_cancelacion') {
    return '\n\n👆 Ojo: tenés una cancelación pendiente. ¿Cancelás el pedido? Respondé *SÍ* o *NO*.';
  }
  return '';
}

/**
 * Intenta responder una consulta de negocio con el conocimiento que el bot SÍ
 * tiene (constantes + lista de precios activa + el pedido en curso). Arma el
 * contexto curado y delega en `responderConsultaNegocio` (módulo consultas-negocio).
 * Devuelve el texto de la respuesta si el modelo pudo contestarla desde el
 * contexto, o `null` si no (el llamador delega a un humano).
 *
 * Es el corazón de la mejora de la consigna: en vez de crear un estado por cada
 * pregunta posible, damos contexto acotado y dejamos que el modelo responda con
 * brevedad, con `puede_responder=false` como escape hatch anti-alucinación.
 */
async function intentarRespuestaNegocio(
  pregunta: string,
  pedidoActivo: PedidoActivoContext | null,
  numeroCliente: string,
): Promise<string | null> {
  const lista = await obtenerListaPreciosPublica();
  const contexto = construirContextoNegocio(pedidoActivo, lista);
  const { puede_responder, respuesta } = await responderConsultaNegocio(pregunta, contexto, numeroCliente);
  return puede_responder && respuesta ? respuesta : null;
}

/**
 * Delega una consulta a un humano: levanta `requiere_atencion` y avisa al cliente
 * con un texto de delegación ROTADO (hallazgo #4 — no repetir palabra por palabra
 * ante insistencia). Si la conversación YA tenía el aviso levantado (delegación
 * reciente sin atender), usa la variante "ya avisé". `sufijo` agrega la cola de
 * recordatorio del pedido cuando la consulta corta el flujo (pregunta pura).
 */
async function delegarAHumano(
  numeroCliente: string,
  seed: number,
  sufijo = '',
): Promise<void> {
  const yaAvisado = await requiereAtencionActual(numeroCliente);
  await marcarRequiereAtencion(numeroCliente);
  await enviarMensajeWhatsApp(numeroCliente, elegirTextoDelegacion(seed, yaAvisado) + sufijo);
}

/**
 * Construye el SYSTEM_PROMPT que se le pasa a Groq, dependiendo de si hay
 * un pedido activo y en qué estado está. Exportado para que el endpoint de
 * dev pueda reproducir el mismo contexto que el flujo real.
 *
 * `opciones.hayPedidoCanceladoReciente`: cuando NO hay pedido activo pero el
 * cliente canceló uno hace poco, habilitamos la intención "reactivar" en el
 * prompt de pedido nuevo, para que un "no, quiero el pedido" recupere el
 * cancelado con sus datos en vez de arrancar de cero.
 */
export function buildSystemPrompt(
  pedidoActivo: PedidoActivoContext | null,
  opciones?: { hayPedidoCanceladoReciente?: boolean },
): string {
  const hayPedidoCanceladoReciente = Boolean(opciones?.hayPedidoCanceladoReciente);
  const pedidoEnviado = Boolean(pedidoActivo && estaDespachado(pedidoActivo));
  const tieneBorrador = pedidoActivo && pedidoActivo.estado === 'borrador';
  const yaExisteEnCocina = pedidoActivo && pedidoActivo.estado === 'pendiente' && !pedidoEnviado;
  const esperandoCancelacion = pedidoActivo && pedidoActivo.estado === 'esperando_cancelacion';

  if (pedidoActivo && (tieneBorrador || yaExisteEnCocina || esperandoCancelacion)) {
    // Misma fuente de verdad que `clampIntencionPorEstado`, que descarta lo que el
    // modelo devuelva fuera de esta lista (el enum del schema es global y no puede
    // variar por estado). Si divergieran, el modelo podría elegir una intención sin
    // handler y el mensaje caería al fallback de reenviar el resumen, en loop.
    const intencionesValidas = intencionesValidasPara(pedidoActivo.estado)
      .map(i => `"${i}"`)
      .join(', ');

    const slots = leerSlots(pedidoActivo);

    return `
      ACTÚA COMO UNA API DE EXTRACCIÓN Y MODIFICACIÓN DE DATOS. NO ERES UN ASISTENTE CONVERSACIONAL. NO SALUDES, NO EXPLIQUES NADA.

      CONTEXTO: El cliente tiene un pedido activo en el sistema con el estado "${pedidoActivo.estado}". Tu objetivo es devolver el objeto JSON final con los datos combinados y actualizados.

      DATOS ACTUALES DEL PEDIDO EN LA BASE DE DATOS:
      - cantidad_crema: ${pedidoActivo.cantidad_crema}
      - cantidad_agua: ${pedidoActivo.cantidad_agua}
      - direccion: "${pedidoActivo.direccion}"
      - aclaracion: ${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'}
      - sabores de los de agua: ${slots.agua ? `"${slots.agua}"` : 'null'}
      - sabores de los de crema: ${slots.crema ? `"${slots.crema}"` : 'null'}
      - detalles generales: ${slots.general ? `"${slots.general}"` : 'null'}
      - metodo_pago: "${pedidoActivo.metodo_pago}"

      1. INTENCIÓN DEL MENSAJE (campo "intencion", elegí UNA opción):
      Valores válidos en este contexto: ${intencionesValidas}.
      ${esperandoCancelacion ? `
      * EL PEDIDO ESTÁ EN PROCESO DE CANCELACIÓN *. El bot le preguntó al cliente si está seguro de cancelar.
      - "confirmar_cancelacion": el cliente confirma que SÍ quiere cancelar (ej: "sí", "dale", "borralo", "exacto", "sí, cancelar").
      - "rechazar_cancelacion": el cliente se arrepiente y NO quiere cancelar, SIN aportar ningún dato del pedido (ej: "no", "no, pará", "me equivoqué", "dejalo así", "no lo canceles", "no, mantenelo"). Esto vale AUNQUE en el mismo mensaje pida un precio o el total ("no, no lo cancelo, dame el total ya") — pedir el total es una consulta, NO un cambio del pedido. SOLO si trae cambios CONCRETOS (cantidades, sabores, dirección, pago) usá "datos_pedido" en vez de esta (el sistema entiende que no quiere cancelar Y aplica los cambios).
      - "saludo": SOLO si el mensaje es un saludo o cortesía reconocible y nada más (ej: "hola", "buenas", "buen día", "gracias"). Un mensaje sin sentido, off-topic o que no encaja en ninguna de las otras opciones NO es un saludo → usá "datos_pedido".
      - "consultar_precios": el cliente pregunta por la LISTA de precios general o cuánto sale un helado EN GENERAL (ej: "cuánto salen?", "me pasás la lista de precios?", "qué precio tienen"), SIN referirse a SU PROPIO pedido. Si en cambio pregunta cuánto sale / cuál es el total de SU PEDIDO (ej: "cuánto sale mi pedido?", "cuánto es el total?"), NO uses esta opción — usá "consulta_negocio": el sistema ya conoce el total exacto de ESTE pedido y responde con ese número puntual, no con la lista general. Si el mensaje ADEMÁS trae cantidades, sabores, dirección o pago, NO uses esta opción — usá "datos_pedido" (el resumen del pedido ya le muestra el precio).
      - "consulta_negocio": el cliente pregunta o plantea algo REAL sobre el negocio o su pedido que las otras opciones no cubren y que requiere que lo responda una persona o el contexto del pedido: horarios, zonas de entrega, qué sabores hay disponibles, stock, promociones, venta mayorista, demora de la entrega, un reclamo o problema con un pedido, facturación, o cuánto sale/es el total de SU PROPIO PEDIDO, etc. NO uses esta opción para mensajes sin sentido, bromas, o preguntas que no tienen NADA que ver con una heladería (ej: "quién ganó el partido?") — eso es "datos_pedido". Si el mensaje ADEMÁS trae datos concretos del pedido, usá "datos_pedido".
      - "datos_pedido": cualquier otra cosa. Incluye mensajes que rechazan la cancelación PERO traen cambios concretos (ej: "no, mejor sumale 5 de agua" → datos_pedido con cantidad_agua=5/sumar).
      ` : `
      - "cancelar": el cliente pide explícitamente cancelar, anular, dar de baja, o dice "ya no quiero el pedido" / "fue mentira".
      - "confirmar": ${tieneBorrador ? `el cliente acepta el resumen (ej: "sí", "dale", "está bien", "confirmo").` : `NO APLICA en este estado (el pedido no está en borrador).`}
      - "saludo": SOLO si el mensaje es un saludo o cortesía reconocible y nada más (ej: "hola", "buenas", "buen día", "gracias"). Un mensaje sin sentido, off-topic o que no encaja en ninguna de las otras opciones NO es un saludo → usá "datos_pedido" (el default).
      - "modificar_sin_datos": el cliente quiere cambiar el pedido pero NO aporta NINGÚN dato concreto (ej: "quiero cambiar algo", "modificar"). Si menciona sabores, cantidades, dirección o pago, NO uses esta opción — usá "datos_pedido".
      - "consultar_precios": el cliente pregunta por la LISTA de precios general o cuánto sale un helado EN GENERAL (ej: "cuánto salen?", "me pasás la lista de precios?", "qué precio tienen"), SIN referirse a SU PROPIO pedido. Si en cambio pregunta cuánto sale / cuál es el total de SU PEDIDO (ej: "cuánto sale mi pedido?", "cuánto es el total?"), NO uses esta opción — usá "consulta_negocio": el sistema ya conoce el total exacto de ESTE pedido y responde con ese número puntual, no con la lista general. Si el mensaje ADEMÁS trae cantidades, sabores, dirección o pago nuevos, NO uses esta opción — usá "datos_pedido" (el resumen del pedido ya le muestra el precio).
      - "consulta_negocio": el cliente pregunta o plantea algo REAL sobre el negocio o su pedido que las otras opciones no cubren y que requiere que lo responda una persona o el contexto del pedido: horarios, zonas de entrega, qué sabores hay disponibles, stock, promociones, venta mayorista, demora de la entrega, un reclamo o problema con un pedido, facturación, o cuánto sale/es el total de SU PROPIO PEDIDO, etc. NO uses esta opción para mensajes sin sentido, bromas, o preguntas que no tienen NADA que ver con una heladería (ej: "quién ganó el partido?") — eso es "datos_pedido". Si el mensaje ADEMÁS trae datos concretos del pedido, usá "datos_pedido".
      - "datos_pedido": el cliente trae info concreta del pedido (cantidades, sabores, dirección, pago), incluso para modificar uno existente. Default cuando no aplique ninguna otra.
      `}

      CAMPO "pregunta_negocio" (INDEPENDIENTE de la intención): si el mensaje incluye una pregunta o planteo REAL de negocio (horarios, si llegan/cobertura de una zona, cuánto demora la entrega, qué sabores hay disponibles, stock, promos, venta mayorista, un reclamo o problema con un pedido, facturación), copiá esa pregunta textual en "pregunta_negocio" — SIEMPRE, aunque además elijas "datos_pedido"/"confirmar"/etc. porque el mensaje trae datos del pedido. Dejala en null si no hay una pregunta de negocio real (bromas, off-topic o mensajes sin sentido NO son consulta de negocio).

      2. REGLAS DE ACTUALIZACIÓN DE DATOS (Combina el mensaje actual con los datos de arriba):
      - "direccion": ÚNICAMENTE nombre de calle y número (Ej: "Mitre 951"). Si el cliente solo menciona un departamento (ej: "depto 6"), un conjunto o una torre, PERO NO menciona la calle, ${pedidoActivo.direccion ? `mantén la dirección actual: "${pedidoActivo.direccion}"` : `poné null (eso corresponde a la aclaración; este pedido TODAVÍA NO TIENE dirección cargada)`}. Si el cliente dice que pasa a RETIRAR / lo pasa a buscar / retira en el local (cualquier conjugación: "retiro", "paso a retirar", "lo busco"), poné direccion="retira" (sentinela), aunque lo diga junto con otros datos.
      - "aclaracion" + "aclaracion_operacion": Detalles extra de la ubicación (departamento, piso, torre, conjunto, color de casa). Ej: "depto 6 del conjunto violeta", "la casa de 2 pisos", "donde el tacho gris", "con el porton verde". NO fusiones vos el texto: solo extraé el dato de ESTE mensaje y elegí la operación; el sistema combina con lo actual (${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'}).
        * "agregar": el cliente suma un detalle NUEVO sobre un objeto/atributo que NO estaba descrito. Devolvé SOLO el detalle nuevo en "aclaracion" (el sistema lo concatena con coma). Ej: actual "la casa es verde" + mensaje "con marco naranja" → aclaracion="con marco naranja", aclaracion_operacion="agregar" (color de casa y marco son cosas distintas). Otro: actual "depto 6" + mensaje "piso 3" → aclaracion="piso 3", aclaracion_operacion="agregar".
        * "reemplazar": el cliente CONTRADICE un detalle del actual. OJO: contradecir NO requiere que diga "no". Si vuelve a describir el MISMO objeto/atributo (el portón, la casa, la puerta, el piso, el color) con otro valor, ES una contradicción → reemplazar, no agregar. Devolvé el texto ya corregido COMPLETO en "aclaracion", reemplazando el valor viejo de ese atributo y conservando los demás detalles. Ej explícito: actual "casa marron, de 2 pisos" + mensaje "no, es verde" → aclaracion="casa verde, de 2 pisos". Ej implícito: actual "porton rojo, puerta gris" + mensaje "porton gris" → aclaracion="porton gris, puerta gris" (el portón ya estaba descrito como rojo; se pisa ese valor, la puerta se mantiene), aclaracion_operacion="reemplazar".
        * "mantener": el cliente no menciona ninguna aclaración en este mensaje. aclaracion=null, aclaracion_operacion="mantener".
      - "metodo_pago": "efectivo", "transferencia" o null. El cliente puede nombrarlos de formas distintas ("en billete", "cash", "mercado pago", "mp", "por transferencia"); mapealos SIEMPRE a una de esas 2 palabras exactas. ${pedidoActivo.metodo_pago ? `Si no menciona un cambio explícito, mantén el actual: "${pedidoActivo.metodo_pago}".` : `Este pedido TODAVÍA NO TIENE forma de pago cargada: si el mensaje la menciona —aunque sea al pasar y mezclada con otra cosa (ej. "transferencia. y hasta qué hora entregan?")— extraela. Solo poné null si el mensaje realmente no la menciona.`}
      - SABORES (campos "obs_agua" / "obs_crema" / "obs_general" + sus "_operacion"): NO armes el texto final ni pongas el prefijo "los de agua/crema"; extraé solo los sabores de ESTE mensaje en su slot y elegí la operación, TS combina y reconstruye. "de agua"/"de crema" es el TIPO, NO un sabor.
        * Slot: "obs_agua"/"obs_crema" = sabores que el cliente atribuye a ese tipo, sin prefijo (ej. "10 de frutilla y 5 de menta"). "obs_general" = detalles sin tipo ("sin coco") o sabores sin tipo declarado ("de dulce de leche").
        * Operación (igual que aclaracion, + "limpiar"): "reemplazar" si DEFINE los sabores de ese tipo ("los de agua que sean X"); "agregar" si suma un sabor (devolvé solo el nuevo); "mantener" si no menciona ese tipo (texto null); "limpiar" si pide sacarlos. Conservá desgloses numéricos tal cual; NUNCA inventes sabores.
        * Si solo dice tipo+cantidad sin sabor ("10 de crema", "50 helados"), TODOS los slots = "mantener".
        * Ej: actual agua="de vainilla", crema="de chocolate" + "los de agua que sean 10 de frutilla y 30 de chocolate" → obs_agua="10 de frutilla y 30 de chocolate"/reemplazar, obs_crema=null/mantener (crema intacto). "sin coco" → obs_general="sin coco"/agregar, resto mantener.
      - "cantidad_agua" / "cantidad_crema" + sus "_operacion": NO hagas matemática, extraé el valor literal y la operación; TS calcula sobre el actual. ÚNICA suma permitida: si dan un desglose por sabores de UN tipo, sumalo ("los de agua 20 de X y 40 de Y" → 60).
        * "sumar": agrega al actual. Pistas: "más", "sumá", "agregá", "otro/s". Ej: "sumale 50", "5 más de agua", "que sean 25 más" (con "más" = delta 25, NO total).
        * "restar": quita. Pistas: "menos", "quitá", "sacá". Ej: "quitale 3", "5 menos de crema".
        * "reemplazar": valor FIJO, SIN "más"/"menos". Ej: "que sean 50", "cambialo a 20", "ahora 30 de crema". También el desglose ya sumado ("que los de agua sean 20 de frutilla y 40 de menta" → 60).
        * "mantener": el mensaje no da NINGUNA cantidad para ese tipo, ni explícita ("20 de crema") ni implícita (ver NÚMERO PELADO). Valor = 0. NUNCA devuelvas "mantener" con un valor distinto de 0: si extraíste un número, elegí la operación que corresponda.
        * NÚMERO PELADO (un número SIN decir el tipo, corrigiendo lo que ya hay): si el mensaje da una cantidad y NO dice "de agua" ni "de crema", mirá el pedido actual. Si hay EXACTAMENTE UN tipo con cantidad > 0, ese número se refiere a ESE tipo → "reemplazar" sobre él (y el otro tipo en "mantener"), SALVO que el número venga con una pista explícita de delta pegada ("5 más", "sumale 5", "5 menos"), que entonces es sumar/restar. El preámbulo conversacional no cambia nada: lo que importa es la palabra pegada al número. Si los DOS tipos tienen cantidad > 0, NO adivines: ver "SIN TIPO" abajo.
        * CAMBIO DE TIPO (reemplaza un tipo por el OTRO): cuando el cliente CORRIGE el tipo del pedido —"mejor N de <otro tipo>", "no, N de <otro tipo>", "en vez de eso N de <otro tipo>", "mejor que sean de <otro tipo>"— NO está sumando un segundo tipo: está cambiando el pedido al otro tipo. Poné el tipo NUEVO en "reemplazar" con la cantidad dicha, Y el tipo VIEJO en "reemplazar" con valor 0 (se limpia). Si NO da número nuevo ("mejor que sean de crema"), arrastrá la cantidad actual del tipo viejo al nuevo (nuevo=reemplazar con esa cantidad, viejo=reemplazar 0). Pistas de CAMBIO: "mejor", "no", "en vez de", "que sean de". Pistas de AGREGADO (esto NO es cambio, es "sumar" y CONSERVA el tipo viejo con "mantener"): "y", "sumale", "agregá", "también", "además", "más".
        Contraste clave (cada tipo es independiente; suponé actual agua=25, crema=0): "25 más de agua" = agua sumar 25 | "25 de agua" = agua reemplazar 25 | "5 menos de crema" = crema restar 5 | "mejor 30 pero de crema" = crema reemplazar 30 + agua reemplazar 0 (cambio de tipo) | "no, 30 de crema" = crema reemplazar 30 + agua reemplazar 0 (cambio de tipo) | "mejor que sean de crema" = crema reemplazar 25 + agua reemplazar 0 (cambio de tipo sin número, arrastra la cantidad) | "y sumale 30 de crema" = crema sumar 30 + agua mantener (agregado, conserva agua) | "mejor 30" = agua reemplazar 30 + crema mantener (corrige la cantidad del MISMO tipo, no toca el otro).
        Contraste de NÚMERO PELADO (suponé ahora actual crema=20, agua=0): "son 30 ahora" = crema reemplazar 30 + agua mantener | "che, se me va la mano, son 40" = crema reemplazar 40 + agua mantener | "espera un toque, me pidieron mas. son 30 ahora" = crema reemplazar 30 (el "mas" está en OTRA oración y no está pegado al número: es total, no delta) | "que sean 30" = crema reemplazar 30 | "ponele 30" = crema reemplazar 30 | "sumale 30" = crema sumar 30 (acá SÍ hay pista de delta pegada al número) | "30 más" = crema sumar 30.
        * SIN TIPO ("cantidad_sin_tipo"): si el mensaje da una cantidad, el pedido tiene agua=0 Y crema=0 y no dice "de agua" ni "de crema" ("50 helados de frutilla"), NO adivines (el sabor NO define el tipo): las dos cantidades en "mantener", el número en "cantidad_sin_tipo" y el sabor en "obs_general". Si hay EXACTAMENTE UN tipo con cantidad > 0, tampoco: ese número va a ESE tipo (ver NÚMERO PELADO arriba), cantidad_sin_tipo=0. PERO si los DOS tipos tienen cantidad > 0 y el cliente da un número pelado ("mejor que sean 30"), NO adivines a cuál se refiere: las dos cantidades en "mantener" y el número en "cantidad_sin_tipo" (el sistema le pregunta cuál). Si la unidad no se vende (kilos/potes/porciones/bolas), cantidad_sin_tipo=0.
        * Si el último turno del bot preguntó el tipo y el cliente lo responde ("de agua", "50 de crema"), poné en ese tipo la cantidad del mensaje o, si no la repite, la que preguntó el bot, con "reemplazar", y mové obs_general al slot de ese tipo ("agregar" + obs_general "limpiar").
        POR UNIDAD DE AGUA/CREMA, NUNCA POR PESO NI POR PORCIÓN SERVIDA: los helados se venden por unidad (de agua o de crema), no por kilo/gramo ni como porción/bola/pote/cucurucho/copa servida. Si el cliente expresa la cantidad en kilos/gramos ("2 kilos de crema", "medio kilo de agua") o como porciones/bolas servidas ("una porción con 2 bolas", "un pote de 3 bolas", "2 cucuruchos"), NO conviertas ni inventes un número de unidades: dejá esa cantidad en "mantener" (el sistema vuelve a pedir las unidades de agua/crema). Un sabor mencionado ("de chocolate") SÍ va a su slot de observaciones aunque la cantidad quede sin definir.

      IMPORTANTE: Devolvé TODOS los campos del schema. "intencion" es una sola opción del enum, no un booleano.
    `;
  }

  return `
    ACTÚA COMO UNA API DE EXTRACCIÓN DE DATOS. NO ERES UN ASISTENTE CONVERSACIONAL. NO SALUDES, NO EXPLIQUES NADA.

    CONTEXTO: El cliente no tiene pedidos activos. Extrae una nueva orden desde cero.

    1. INTENCIÓN DEL MENSAJE (campo "intencion", elegí UNA opción):
    Valores válidos en este contexto: ${intencionesValidasPara(null, { hayPedidoCanceladoReciente }).map(i => `"${i}"`).join(', ')}.
    - "cancelar": el cliente pide explícitamente cancelar/anular un pedido (puede estar refiriéndose a uno ya despachado, aunque no haya pedido activo).${hayPedidoCanceladoReciente ? `
    - "reactivar": el cliente acaba de cancelar un pedido y se ARREPIENTE: quiere recuperar ese mismo pedido tal cual estaba, SIN aportar datos nuevos (ej: "no, no lo canceles", "en realidad sí lo quiero", "reactivalo", "volvé a activar el pedido", "quiero el pedido que cancelé"). Si en cambio arranca un pedido NUEVO con datos concretos (cantidades/dirección/pago distintos), usá "datos_pedido".` : ''}
    - "saludo": el mensaje es ÚNICAMENTE un saludo (ej: "hola", "buenas"), sin datos del pedido.
    - "consultar_precios": el cliente pregunta por la LISTA de precios general o cuánto sale un helado EN GENERAL (ej: "cuánto salen?", "me pasás la lista de precios?", "qué precio tienen los helados?"), SIN referirse a un pedido propio. Si en cambio pregunta cuánto sale / cuál es el total de "su pedido" (ej: "cuánto sale mi pedido?"), NO uses esta opción — usá "consulta_negocio": como acá no hay pedido activo, el sistema le va a avisar que no tiene uno en curso, en vez de mandarle la lista general que no fue lo que pidió.
    - "consulta_negocio": el cliente pregunta o plantea algo REAL sobre el negocio que las otras opciones no cubren y que requiere que lo responda una persona: horarios, zonas de entrega, qué sabores hay disponibles, stock, promociones, venta mayorista, un reclamo o problema con un pedido anterior, facturación, cuánto sale/es el total de "su pedido", etc. NO uses esta opción para mensajes sin sentido, bromas, o preguntas que no tienen NADA que ver con una heladería (ej: "quién ganó el partido?") — eso es "datos_pedido". Si el mensaje ADEMÁS trae datos concretos de un pedido, usá "datos_pedido".
    - "datos_pedido": el cliente trae info del pedido (cantidades, sabores, dirección, pago). Default cuando no aplique otra.

    CAMPO "pregunta_negocio" (INDEPENDIENTE de la intención): si el mensaje incluye una pregunta o planteo REAL de negocio (horarios, si llegan/cobertura de una zona, cuánto demora la entrega, qué sabores hay disponibles, stock, promos, venta mayorista, un reclamo o problema con un pedido, facturación), copiá esa pregunta textual en "pregunta_negocio" — SIEMPRE, aunque además elijas "datos_pedido" porque el mensaje trae datos del pedido. Dejala en null si no hay una pregunta de negocio real (bromas, off-topic o mensajes sin sentido NO son consulta de negocio).

    2. REGLAS DE EXTRACCIÓN:
    - "direccion": ÚNICAMENTE nombre de calle y número (Ej: "Mitre 951"). Si el cliente solo menciona un departamento (ej: "depto 6"), un conjunto o una torre, PERO NO menciona la calle, pon null porque no es una dirección válida, eso corresponde a la aclaracion. Si el cliente dice que pasa a RETIRAR / lo pasa a buscar / retira en el local (cualquier conjugación: "retiro", "paso a retirar", "lo busco"), poné direccion="retira" (sentinela). Si NO menciona ni dirección ni retiro, pon null.
    - "aclaracion": Detalles extra de la dirección física (color de la casa, pisos, entre calles, timbre, departamento). Ejemplos: "la casa rosada de 2 pisos", "timbre 2B", "donde el porton gris" y asi. Si no se especifica, pon null.
    - "aclaracion_operacion": SIEMPRE "reemplazar" en este contexto (es un pedido nuevo desde cero, no hay aclaración previa que combinar).
    - "cantidad_agua" y "cantidad_crema": Cantidad en números, por defecto 0. Si el cliente da un desglose por sabores dentro de UN tipo (ej. "10 helados de agua: 4 de frutilla y 6 de menta"), SUMÁ esos números y devolvé el total (10). POR UNIDAD DE AGUA/CREMA, NUNCA POR PESO NI POR PORCIÓN SERVIDA: los helados se venden por unidad (de agua o de crema), no por kilo/gramo ni como porción/bola/pote/cucurucho/copa servida. Si el cliente expresa la cantidad en kilos/gramos ("2 kilos de crema", "medio kilo de agua") o como porciones/bolas servidas ("una porción con 2 bolas", "un pote de 3 bolas", "2 cucuruchos"), NO conviertas ni inventes un número de unidades: dejá esa cantidad en 0 (el sistema vuelve a pedir las unidades de agua/crema). Un sabor mencionado ("de chocolate") SÍ va a su slot de observaciones aunque la cantidad quede en 0.
    - "cantidad_agua_operacion" y "cantidad_crema_operacion": SIEMPRE "reemplazar" en este contexto (es un pedido nuevo desde cero, no hay valor previo que sumar/restar/mantener).
    - "cantidad_sin_tipo": si el cliente dice CUÁNTOS quiere pero NO si son de agua o de crema (ej: "quiero 50 helados de frutilla", "mandame 20 helados"), poné ese número acá y dejá cantidad_agua=0 y cantidad_crema=0. NUNCA deduzcas el tipo por el sabor: un mismo sabor puede existir en los dos tipos, y el sistema le va a preguntar al cliente cuál quiere. El sabor mencionado va igual a "obs_general". Si el cliente SÍ dice el tipo, cantidad_sin_tipo=0. Tampoco lo uses para cantidades en kilos/gramos/potes/porciones/bolas/cucuruchos (esas quedan en 0, sin señal).
    - SABORES (campos "obs_agua" / "obs_crema" / "obs_general"): poné los sabores en el slot del tipo, SIN el prefijo "los de agua/crema". NO confundas el tipo de helado con un sabor.
      * "obs_agua": sabores de los de agua (ej. "frutilla y menta", "5 de frutilla y 5 de menta"). "obs_crema": ídem crema. "obs_general": sabores/detalles sin tipo ("sin coco", "de dulce de leche").
      * Conservá desgloses numéricos tal cual ("6 de chocolate y 4 de granizado"); la cocina los necesita.
      * Si el cliente solo dice tipo + cantidad sin sabor ("10 de crema", "50 helados de agua"), el slot va en null.
      * NUNCA INVENTES sabores.
    - "obs_agua_operacion" / "obs_crema_operacion" / "obs_general_operacion": "reemplazar" si el slot tiene sabores, "mantener" si va null. (Pedido nuevo: no hay nada previo que combinar.)
    - "metodo_pago": "efectivo", "transferencia" o null. Puede referirse a cualquiera de los 2 metodos de formas distintas ("en billete", "cash", "mercado pago", "mp", etc.), de ellas obten alguna de estas 2 opciones validas.

    IMPORTANTE: Devolvé TODOS los campos del schema. "intencion" es una sola opción del enum, no un booleano.
  `;
}

/**
 * Procesa todos los mensajes pendientes de un cliente.
 *
 * Esta función se invoca desde el consumer de QStash (8 segundos después de
 * que llegó el último mensaje). Hace un "claim" atómico con UPDATE...RETURNING:
 * si dos wake-ups de QStash se solapan, solo uno se lleva los mensajes y
 * procesa; el otro recibe 0 filas y sale sin hacer nada.
 */
// Si el último mensaje pendiente llegó hace menos que este umbral, asumimos
// que el cliente sigue tipeando y diferimos el procesamiento al próximo
// wake-up. Cada mensaje ya agenda su propio wake-up de QStash, así que con
// que UNO de ellos vea silencio suficiente alcanza para procesar todo el
// batch junto. Tiene que ser menor a DEBOUNCE_SECONDS (8s) del webhook para
// que la última wake-up siempre vea su propio mensaje como "viejo" y procese.
const DEFER_THRESHOLD_MS = 5000;

// Ventana para "deshacer" una cancelación: si el cliente canceló hace menos que
// esto y se arrepiente ("no, quiero el pedido"), reabrimos el pedido cancelado
// con sus datos en vez de arrancar de cero. Medida desde updated_at (≈ el
// momento de la cancelación). Corta a los 30 min: pasado eso, un "quiero el
// pedido" es un pedido nuevo, no un arrepentimiento inmediato.
const VENTANA_REACTIVAR_MS = 30 * 60 * 1000;

/**
 * Envía el mensaje que pide el/los dato(s) que faltan para completar un pedido.
 * Cuando falta UN solo dato y es una elección cerrada (pago / dirección), lo
 * pedimos con botones: el click vuelve por el webhook mapeado a texto canónico
 * (RESPUESTAS_RAPIDAS) y sigue el pipeline normal. Menos tipeo y menos
 * ambigüedad que pedirlo como texto libre.
 *
 * Se comparte entre el armado de un pedido nuevo y la actualización de un
 * borrador todavía incompleto, así el texto es idéntico en ambos caminos.
 */
// Exportada porque también la usa el cron /api/gestionar-borradores para
// re-pedir el dato faltante de un borrador parcial abandonado (recordatorio
// one-shot). Devuelve si el envío a Meta salió bien, para que el cron solo
// marque `recordatorio_enviado` en ese caso (igual que el recordatorio completo).
export async function pedirDatosFaltantes(
  numeroCliente: string,
  faltaCantidad: boolean,
  faltaDireccion: boolean,
  faltaPago: boolean,
  saludo?: string,
  seed = 0,
  cantidadEnUnidadNoSoportada = false,
  pagoNoSoportado = false,
  tipoHeladoAmbiguo: TipoHeladoAmbiguo | null = null,
): Promise<boolean> {
  console.log(`⚠️ Datos faltantes: cantidad=${faltaCantidad}, direccion=${faltaDireccion}, pago=${faltaPago}, unidadNoSoportada=${cantidadEnUnidadNoSoportada}, pagoNoSoportado=${pagoNoSoportado}, cantidadSinTipo=${tipoHeladoAmbiguo?.cantidad ?? 0}`);

  // La decisión (botones vs texto) es pura y testeada; acá solo se envía.
  // `seed` rota el saludo cuando faltan los 3 datos (ver elegirRespuestaDatosFaltantes),
  // para no repetir el mismo texto ante mensajes off-topic seguidos.
  const respuesta = elegirRespuestaDatosFaltantes(faltaCantidad, faltaDireccion, faltaPago, seed, cantidadEnUnidadNoSoportada, pagoNoSoportado, tipoHeladoAmbiguo?.cantidad ?? 0, tipoHeladoAmbiguo?.operacion ?? 'reemplazar');
  // Cuando entramos por la rama "saludo con borrador parcial", el caller
  // prepende un "¡Hola! 👋 …" al cuerpo así el cliente ve UNA sola burbuja en
  // vez de dos seguidas (saludo + pedido de datos). Vale para las tres formas
  // (texto libre, botones de pago, botón de retiro).
  const prefijo = saludo ? `${saludo}\n\n` : '';

  if (respuesta.tipo === 'botones_pago') {
    return enviarMensajeConBotones(numeroCliente, `${prefijo}¿Cómo lo pagás? 💰`, [
      { id: 'resp_pago_efectivo', title: 'Efectivo' },
      { id: 'resp_pago_transferencia', title: 'Transferencia' },
    ]);
  }

  if (respuesta.tipo === 'botones_tipo_helado') {
    // RESPUESTA LIBRE PERO ACOTADA (mismo mecanismo que las consultas de negocio):
    // acá no hay un texto fijo que sirva —lo que conviene decirle depende del sabor
    // que pidió y de en qué tipos existe—, pero los sabores son un área que el bot
    // conoce, así que la redacción se la pedimos al modelo con contexto curado. Si
    // falla o se va de tema, va el texto determinista de `respuesta.mensaje`.
    //
    // Solo para REEMPLAZO ("quiero 50 helados de frutilla"): la redacción libre
    // está pensada para nombrar en qué tipo está el sabor. Para un delta pelado
    // ("sumale 10") no hay sabor que ubicar y la redacción tendería a leerlo como
    // reemplazo, así que usamos el texto determinista (que ya dice "sumar/sacar").
    const libre =
      tipoHeladoAmbiguo && respuesta.operacion === 'reemplazar'
        ? await redactarPreguntaTipoHelado(respuesta.cantidad, tipoHeladoAmbiguo.textoCliente, numeroCliente)
        : null;
    // La cantidad Y la operación viajan en el ID del botón (y la operación también
    // en el título), así que el click vuelve como el texto canónico —"N de agua"
    // para reemplazo, "sumale N de agua"/"sacale N de agua" para delta—: el turno
    // siguiente no tiene que deducir el número ni la operación del historial.
    const sufijoOp = respuesta.operacion === 'reemplazar' ? '' : `${respuesta.operacion}_`;
    const signo = respuesta.operacion === 'sumar' ? '+' : respuesta.operacion === 'restar' ? '-' : '';
    return enviarMensajeConBotones(numeroCliente, `${prefijo}${libre ?? respuesta.mensaje}`, [
      // (los prefijos + la operación los parsea `parsearBotonTipoHelado` en botones.ts,
      // igual que los ids literales de RESPUESTAS_RAPIDAS que manda este mismo helper)
      { id: `resp_tipo_agua_${sufijoOp}${respuesta.cantidad}`, title: `${signo}${respuesta.cantidad} de agua` },
      { id: `resp_tipo_crema_${sufijoOp}${respuesta.cantidad}`, title: `${signo}${respuesta.cantidad} de crema` },
    ]);
  }

  if (respuesta.tipo === 'boton_retira') {
    // Si falta solo la dirección es porque tampoco hay histórica (la inyección
    // ya corrió). Pedimos calle y número; el botón cubre el caso retiro sin que
    // lo tenga que escribir.
    return enviarMensajeConBotones(
      numeroCliente,
      `${prefijo}¿A qué dirección te lo llevamos? Mandame calle y número (ej: *Mitre 950*) 🛵`,
      [{ id: 'resp_retira', title: 'Paso a retirar' }],
    );
  }

  return enviarMensajeWhatsApp(numeroCliente, `${prefijo}${respuesta.mensaje}`);
}

/**
 * Fallback del índice único pedidos_un_borrador_por_telefono: si un INSERT de
 * borrador rebota con 23505, ya existe un borrador para ese teléfono que el
 * lookup de pedidoActivo no vio (zombie fuera de la ventana de 12h, o una
 * carrera). En vez de perder los datos del mensaje, los fusionamos sobre el
 * borrador existente: lo que vino en este turno pisa, lo que no vino se
 * conserva. Devuelve la fila fusionada, o null si no se pudo (el borrador
 * desapareció entre el conflicto y el update — caso rarísimo; el caller loguea).
 */
async function fusionarEnBorradorExistente(
  numeroCliente: string,
  entrante: {
    direccion: string;
    aclaracion: string | null;
    cantidad_agua: number;
    cantidad_crema: number;
    observaciones: string | null;
    observaciones_detalle: Json | null;
    metodo_pago: string;
    direccion_de_historial: boolean;
  },
) {
  const { data: existente } = await supabaseAdmin
    .from('pedidos')
    .select('*')
    .eq('telefono', numeroCliente)
    .eq('estado', 'borrador')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!existente) return null;

  const { data: fusionado } = await supabaseAdmin
    .from('pedidos')
    .update({
      cantidad_agua: entrante.cantidad_agua > 0 ? entrante.cantidad_agua : existente.cantidad_agua,
      cantidad_crema: entrante.cantidad_crema > 0 ? entrante.cantidad_crema : existente.cantidad_crema,
      direccion: entrante.direccion || existente.direccion,
      // El flag de dirección histórica sigue a la dirección que quedó.
      direccion_de_historial: entrante.direccion
        ? entrante.direccion_de_historial
        : existente.direccion_de_historial,
      aclaracion: entrante.aclaracion ?? existente.aclaracion,
      observaciones: entrante.observaciones ?? existente.observaciones,
      observaciones_detalle: entrante.observaciones_detalle ?? existente.observaciones_detalle,
      metodo_pago: entrante.metodo_pago || existente.metodo_pago,
    })
    .eq('id', existente.id)
    .eq('estado', 'borrador') // guard: sigue siendo borrador
    .select('*')
    .maybeSingle();

  if (fusionado) {
    console.log(`🔀 Borrador duplicado evitado: fusionado sobre el existente ${existente.id}.`);
  }
  return fusionado;
}

export async function procesarMensajesDeCliente(numeroCliente: string) {
  // 0.bis TOMA HUMANA (defensa): el webhook ya no agenda wake-ups durante una
  //    toma humana, pero pudo quedar uno agendado de antes de iniciarla. Si la
  //    toma está activa — o el último saliente fue de un OPERADOR hace <6h
  //    (gate por mensajes, misma red de seguridad que aplica el webhook) —,
  //    reclamamos los pendientes (procesado=true) para que no queden colgados
  //    ni disparen wake-ups futuros, pero NO respondemos.
  const tomaActiva = await atencionHumanaActiva(numeroCliente);
  const operadorReciente = !tomaActiva && await intervencionHumanaReciente(numeroCliente);
  if (tomaActiva || operadorReciente) {
    await supabaseAdmin
      .from('mensajes_chat')
      .update({ procesado: true })
      .eq('telefono', numeroCliente)
      .eq('rol', 'cliente')
      .eq('procesado', false);
    if (operadorReciente) {
      // Sin toma activa nadie está mirando el chat: avisamos al operador que
      // el cliente escribió y el bot se abstuvo.
      await marcarRequiereAtencion(numeroCliente);
    }
    console.log(`🙋 ${tomaActiva ? 'Toma humana activa' : 'Último saliente de operador hace <6h'} para ${numeroCliente}. El bot no responde.`);
    return;
  }

  // 0. DEBOUNCE: chequeamos si el último mensaje pendiente es muy reciente.
  //    El claim atómico solo evita doble-procesamiento del MISMO mensaje;
  //    no evita que dos wake-ups consecutivos procesen SUBSETS distintos
  //    cuando los mensajes llegan espaciados (el primer wake-up se lleva
  //    los primeros mensajes, llega uno nuevo, el segundo wake-up se lleva
  //    ese, y ambos terminan respondiendo). Con este defer, esperamos a
  //    que haya silencio antes de claimear.
  const { data: ultimoPendiente } = await supabaseAdmin
    .from('mensajes_chat')
    .select('created_at')
    .eq('telefono', numeroCliente)
    .eq('rol', 'cliente') // defensivo: mensajes del bot van con procesado=true, no aparecen acá igual
    .eq('procesado', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!ultimoPendiente) {
    console.log(`⏭️ Sin mensajes pendientes para ${numeroCliente}. Otro worker ya los procesó.`);
    return;
  }

  const msDesdeUltimo = Date.now() - new Date(ultimoPendiente.created_at).getTime();
  if (msDesdeUltimo < DEFER_THRESHOLD_MS) {
    console.log(`⏳ Mensaje pendiente muy reciente (${msDesdeUltimo}ms < ${DEFER_THRESHOLD_MS}ms) para ${numeroCliente}. Difiriendo al próximo wake-up.`);
    return;
  }

  // 1. CLAIM ATÓMICO: marcamos los mensajes nuevos como procesados y traemos
  //    su contenido. Esto es lo que nos da la dedupliación entre wake-ups
  //    concurrentes: si otro worker ya los reclamó, este recibe 0 filas y sale.
  const { data: mensajesClaim, error: claimError } = await supabaseAdmin
    .from('mensajes_chat')
    .update({ procesado: true })
    .eq('telefono', numeroCliente)
    .eq('rol', 'cliente') // refuerzo: nunca reclamamos un row del bot como input
    .eq('procesado', false)
    .select('id, texto, created_at, wa_message_id, tipo');

  if (claimError) {
    console.error(`❌ Error al hacer claim de mensajes para ${numeroCliente}:`, claimError);
    return;
  }

  if (!mensajesClaim || mensajesClaim.length === 0) {
    console.log(`⏭️ Sin mensajes pendientes para ${numeroCliente}. Otro worker probablemente ya los procesó.`);
    return;
  }

  console.log(`📦 Claimed ${mensajesClaim.length} mensaje(s) nuevo(s) para ${numeroCliente}.`);

  // Texto CRUDO del batch del cliente. Es la entrada de todas las redes
  // deterministas (retiro, rechazo de cancelación, confirmación, cantidad pelada,
  // unidad/pago no soportado): trabajan sobre lo que el cliente escribió, no sobre
  // la extracción del modelo, que es justamente lo que vienen a respaldar.
  const textoBatch = mensajesClaim.map(m => m.texto ?? '').join(' ');

  // Tildes azules + "escribiendo…" sobre el mensaje más reciente del batch.
  // Va acá (post-claim) y NO en el webhook a propósito: durante el debounce el
  // cliente puede seguir tipeando, y si ve "escribiendo…" antes de tiempo deja
  // de mandar sus mensajes para esperar la respuesta.
  const masReciente = [...mensajesClaim].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];
  if (masReciente?.wa_message_id) {
    await marcarLeidoYEscribiendo(masReciente.wa_message_id);
  }

  // 2. Buscar pedido activo reciente — necesitamos saber si existe ANTES de
  //    armar el historial, porque el contexto que le damos al modelo depende
  //    de eso.
  //
  //    Usamos una ventana móvil de 12 horas en lugar de "desde la medianoche":
  //    así un cliente que armó un borrador a las 23:50 puede confirmarlo a las
  //    00:10, y uno con pedido enviado a las 22:00 sigue siendo "su pedido
  //    activo" si pregunta a las 00:30. Borradores zombies de hace varios
  //    días igual quedan excluidos.
  const hace12Horas = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const { data: pedidoActivo } = await supabaseAdmin
    .from('pedidos')
    .select('*')
    .eq('telefono', numeroCliente)
    .gte('created_at', hace12Horas)
    .in('estado', ['borrador', 'pendiente', 'esperando_cancelacion'])
    .eq('enviado', false) // defensivo por si quedó un pendiente con enviado=true
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Lookup del pedido MÁS RECIENTE del cliente en la ventana (sin filtrar por
  // estado), para respuestas contextuales tipo "tu pedido ya está en camino"
  // o "ya canceleste hace un rato". Lo usamos solo si la última acción del
  // cliente fue un despacho — si después de eso canceló (u otro evento), su
  // "estado actual" ya no es el del despacho y caemos al saludo genérico.
  //
  // "Despachado" = estado='enviado' O enviado=true (ver estaDespachado): el
  // query de pedidoActivo de arriba excluye enviado=true, así que un pedido ya
  // copiado al cadete pero con estado todavía en 'pendiente' cae acá y lo
  // reconocemos igual como despachado.
  let ultimoPedidoEnviado: { id: number; estado: string; created_at: string } | null = null;
  // Pedido cancelado hace poco (dentro de VENTANA_REACTIVAR_MS): si el cliente
  // se arrepiente, lo reabrimos con sus datos en vez de perder cantidad/pago.
  let ultimoPedidoCancelado: { id: number; created_at: string } | null = null;
  if (!pedidoActivo) {
    const { data: ultimoPedido } = await supabaseAdmin
      .from('pedidos')
      .select('id, estado, enviado, created_at, updated_at')
      .eq('telefono', numeroCliente)
      .gte('created_at', hace12Horas)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ultimoPedido && estaDespachado(ultimoPedido)) {
      ultimoPedidoEnviado = ultimoPedido;
      console.log(`📦 El último pedido del cliente (id ${ultimoPedido.id}) ya está despachado (estado=${ultimoPedido.estado}, enviado=${ultimoPedido.enviado}). Lo uso para respuestas contextuales.`);
    } else if (ultimoPedido && ultimoPedido.estado === 'cancelado') {
      // ¿Se canceló hace poco? updated_at ≈ el momento de la cancelación
      // (fallback a created_at por si la columna viniera null).
      const marcaCancelacion = ultimoPedido.updated_at ?? ultimoPedido.created_at;
      const msDesdeCancelacion = Date.now() - new Date(marcaCancelacion).getTime();
      if (msDesdeCancelacion < VENTANA_REACTIVAR_MS) {
        ultimoPedidoCancelado = ultimoPedido;
        console.log(`↩️ El último pedido del cliente (id ${ultimoPedido.id}) se canceló hace ${Math.round(msDesdeCancelacion / 1000)}s; habilito reactivar.`);
      } else {
        console.log(`📦 El último pedido del cliente (id ${ultimoPedido.id}) está cancelado pero hace rato (${Math.round(msDesdeCancelacion / 60000)} min); no habilito reactivar.`);
      }
    } else if (ultimoPedido) {
      console.log(`📦 El último pedido del cliente (id ${ultimoPedido.id}) está en estado ${ultimoPedido.estado} (enviado=${ultimoPedido.enviado}); no aplica respuesta contextual de despacho.`);
    }
  }

  // 3. HISTORIAL: la lógica depende de si ya existe un pedido activo.
  //
  //   - SIN pedidoActivo: el cliente está armando el pedido en partes y todavía
  //     no se persistió nada. Necesitamos ver los últimos 15 min para juntar
  //     fragmentos (ej: "10 de crema" en un batch, "transferencia" en otro).
  //
  //   - CON pedidoActivo: el estado consolidado YA vive en pedidoActivo. Los
  //     mensajes viejos pueden confundir al modelo (caso real: "sumale 50 de
  //     agua" del batch anterior se reaplicaba al confirmar). Pasamos solo lo
  //     nuevo que el cliente acaba de mandar.
  type MensajeHistorial = { texto: string | null; created_at: string; rol: string };
  let mensajesParaIA: MensajeHistorial[];

  if (pedidoActivo) {
    // Mensajes nuevos del cliente del batch...
    const nuevosCliente: MensajeHistorial[] = [...mensajesClaim]
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map(m => ({ texto: m.texto, created_at: m.created_at, rol: 'cliente' }));

    // ...más el último turno SALIENTE (bot u operador) anterior al batch. Esto
    // le da contexto al LLM para responder "dale" / "sí" / "Av. Mitre 1234"
    // sueltos, sin tener que adivinar a qué pregunta se refiere el cliente.
    // Incluimos 'operador' porque, al reactivarse el bot tras una toma humana,
    // el cliente suele estar respondiendo al último mensaje del operador.
    const primerNuevo = nuevosCliente[0]?.created_at ?? new Date().toISOString();
    const { data: ultimoBot, error: errUltimoBot } = await supabaseAdmin
      .from('mensajes_chat')
      .select('texto, created_at, rol')
      .eq('telefono', numeroCliente)
      .in('rol', ['bot', 'operador'])
      .eq('descartado', false)
      // Excluimos envíos que Meta rechazó: si el bot "dijo" algo que el cliente
      // nunca vio, no debe entrar al contexto como si fuera su último turno —
      // el modelo interpretaría la próxima respuesta contra una pregunta fantasma.
      .eq('fallido', false)
      .lt('created_at', primerNuevo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    // Un error acá (ej. columna inexistente por drift de esquema) devolvía data=null
    // en silencio: el bot seguía sin contexto y, en el peor caso, la próxima query
    // vacía lo dejaba mudo sin ninguna señal. En modo test lo propagamos para que el
    // harness lo marque como fallo en vez de "no respondió".
    if (errUltimoBot) {
      console.error("❌ Error leyendo el último turno para contexto:", errUltimoBot);
      if (process.env.BOT_TEST_MODE === '1') throw new Error(`contexto ultimoBot: ${errUltimoBot.message}`);
    }

    mensajesParaIA = ultimoBot ? [ultimoBot, ...nuevosCliente] : nuevosCliente;
    console.log(`📚 Hay pedidoActivo (${pedidoActivo.estado}): pasamos ${nuevosCliente.length} mensaje(s) nuevo(s)${ultimoBot ? ' + último turno del bot' : ''}.`);
  } else {
    const hace15Minutos = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: historial, error: errHistorial } = await supabaseAdmin
      .from('mensajes_chat')
      .select('texto, created_at, rol')
      .eq('telefono', numeroCliente)
      .eq('descartado', false) // ignoramos mensajes de conversaciones ya cerradas
      .eq('fallido', false)    // ignoramos envíos del bot/operador que Meta rechazó (ver sección anterior)
      .gte('created_at', hace15Minutos)
      .order('created_at', { ascending: true })
      .limit(15);
    // Si esta query falla (ej. columna 'fallido' inexistente por drift de esquema),
    // data=null → mensajesParaIA=[] → return temprano "sin mensajes" = SILENCIO TOTAL
    // sin ninguna traza de error. Es exactamente el modo de falla que dejó al bot mudo
    // en staging durante días. Lo hacemos ruidoso, y en modo test lo propagamos.
    if (errHistorial) {
      console.error("❌ Error leyendo el historial reciente para contexto:", errHistorial);
      if (process.env.BOT_TEST_MODE === '1') throw new Error(`contexto historial: ${errHistorial.message}`);
    }

    mensajesParaIA = historial ?? [];
    console.log(`📚 Sin pedidoActivo: traemos ${mensajesParaIA.length} mensajes recientes (últimos 15 min, ambos roles) para captar el pedido en armado.`);
  }

  if (mensajesParaIA.length === 0) {
    console.log(`⚠️ Sin mensajes para procesar para ${numeroCliente}. Algo raro pasó.`);
    return;
  }

  const historialParaIA = mensajesParaIA
    // Solo 'cliente' es el cliente; 'bot' y 'operador' son ambos lado-negocio
    // (un mensaje del operador NO debe etiquetarse como "Cliente").
    .map(m => `${m.rol === 'cliente' ? 'Cliente' : 'Bot'}: "${m.texto}"`)
    .join("\n");

  console.log(`🤖 Texto final agrupado para la IA (${numeroCliente}):\n${historialParaIA}`);

  const pedidoEnviado = Boolean(pedidoActivo && estaDespachado(pedidoActivo));

  console.log("🔍 Ultimo pedido encontrado para el cliente:", pedidoActivo);
  console.log(`¿El pedido ya fue enviado? ${pedidoEnviado}`);

  // 3. Buscar última dirección histórica del cliente
  let direccionGuardada: string | null = null;
  let aclaracionGuardada: string | null = null;

  if (!pedidoActivo) {
    const { data: ultimoPedido } = await supabaseAdmin
      .from('pedidos')
      .select('direccion, aclaracion')
      .eq('telefono', numeroCliente)
      .not('direccion', 'is', null)
      .neq('direccion', 'retira')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ultimoPedido) {
      direccionGuardada = ultimoPedido.direccion;
      aclaracionGuardada = ultimoPedido.aclaracion;
      console.log(`📍 Dirección histórica encontrada: ${direccionGuardada}`);
      console.log(`📝 Aclaración histórica encontrada: ${aclaracionGuardada}`);
    }
  } else {
    direccionGuardada = pedidoActivo.direccion;
    aclaracionGuardada = pedidoActivo.aclaracion;
  }

  // 4. PROMPT DINÁMICO. La lógica del prompt vive en buildSystemPrompt para
  //    poder reusarla desde el endpoint de dev.
  const tieneBorrador = pedidoActivo && pedidoActivo.estado === 'borrador';
  const yaExisteEnCocina = pedidoActivo && pedidoActivo.estado === 'pendiente' && !pedidoEnviado;
  const esperandoCancelacion = pedidoActivo && pedidoActivo.estado === 'esperando_cancelacion';

  console.log("📊 Evaluando contexto para construir el SYSTEM_PROMPT...");
  console.log(`- Tiene pedido en borrador? ${tieneBorrador}`);
  console.log(`- Ya existe en cocina? ${yaExisteEnCocina}`);
  console.log(`- Está esperando confirmación de cancelación? ${esperandoCancelacion}`);

  const SYSTEM_PROMPT = buildSystemPrompt(pedidoActivo, {
    hayPedidoCanceladoReciente: Boolean(ultimoPedidoCancelado),
  });

  // 5. LLAMADA A GROQ con structured output validado por Zod.
  //    El AI SDK marca `json_validate_failed` como no-retryable (es un 400),
  //    pero en la práctica son errores por non-determinismo del modelo (ej:
  //    devuelve "false" string en vez de false boolean). Reintentamos a mano.
  const MAX_ATTEMPTS = 3;
  let pedido: PedidoIA | null = null;
  // Cantidad "pelada" que la red no pudo asignar porque el pedido tiene los DOS
  // tipos cargados: se resuelve preguntándole al cliente cuál (ver más abajo).
  let cantidadPeladaAmbigua = 0;
  // Delta "pelado" ("sumale 10") sobre un pedido con los DOS tipos cargados:
  // igual que el reemplazo pelado, pero la operación (sumar/restar) se propaga a
  // los botones para que la respuesta del cliente sume/reste en vez de reemplazar.
  let deltaPeladoAmbiguo: { operacion: 'sumar' | 'restar'; valor: number } | null = null;
  let lastError: unknown = null;
  let modeloIdx = 0; // índice en MODELOS_EXTRACCION; avanza ante un 429 (fallback)
  let attempt = 0; // reintentos por validación DENTRO del modelo actual

  // 4b. SHORT-CIRCUIT: si el batch es un único mensaje inequívoco dado el
  //     estado del pedido (ej. "sí" en esperando_cancelacion, "hola" con
  //     pedido en cocina), salteamos el LLM. Reduce latencia, costo y
  //     errores del modelo en los casos triviales.
  //
  //     EXCEPCIÓN — audios transcriptos (tipo='audio'): Whisper alucina con
  //     ALTA confianza cuando hay ruido de fondo con habla (TV, gente hablando
  //     lejos): puede escupir un "sí, dale" perfectamente formado que pasa
  //     esSegmentoAlucinado/esTranscripcionUtil (esos filtros atrapan silencio
  //     y ruido no-verbal, no habla de fondo). Un short-circuit sobre un
  //     transcript alucinado puede confirmar/cancelar un pedido con ruido
  //     ambiente, sin ninguna red de razonamiento contextual. Forzamos el
  //     paso por el LLM así al menos ve el estado y el último turno del bot y
  //     puede detectar la incongruencia. Cuesta ~1s + tokens; los audios son
  //     minoría y el trade-off es correcto (seguridad > latencia).
  const fuenteEsAudio = mensajesClaim.length === 1 && mensajesClaim[0].tipo === 'audio';
  if (mensajesClaim.length === 1 && !fuenteEsAudio) {
    const intento = intentarShortCircuit(
      mensajesClaim[0].texto ?? '',
      pedidoActivo?.estado ?? null,
    );
    if (intento) {
      pedido = pedidoDesdeShortCircuit(intento, pedidoActivo);
      console.log(`⚡ Short-circuit (sin LLM): tipo=${intento}, mensaje="${mensajesClaim[0].texto}"`);
    }
  } else if (fuenteEsAudio) {
    console.log(`🎤 Fuente=audio: salteo short-circuit, mando al LLM aunque el transcript parezca inequívoco.`);
  }

  // Recorremos la cadena de modelos. Dentro de cada modelo reintentamos hasta
  // MAX_ATTEMPTS por errores de VALIDACIÓN (non-determinismo). Ante un 429 (rate
  // limit / TPD) no reintentamos el mismo modelo: saltamos al siguiente.
  while (pedido === null && modeloIdx < MODELOS_EXTRACCION.length) {
    const modelo = MODELOS_EXTRACCION[modeloIdx];
    attempt++;
    try {
      const { object, usage } = await generateObject({
        model: crearModeloLLM(modelo),
        system: SYSTEM_PROMPT,
        prompt: `Conversación reciente (el último turno del bot da contexto al mensaje del cliente):\n${historialParaIA}`,
        schema: PedidoIASchema,
        temperature: 0,
      });

      // Telemetría de tokens (fail-open, no bloqueante): alimenta la página de
      // estado de modelos con el consumo real vs. el TPD diario de Groq.
      void registrarUsoModelo(modelo, 'extraccion', usage, numeroCliente);

      // Aplicamos las operaciones de cantidad de forma determinista en TS.
      // El modelo solo identificó la intención (sumar/restar/reemplazar/mantener)
      // y el valor literal del mensaje; nosotros hacemos la cuenta sobre el
      // estado actual del pedido (o sobre 0 si no hay pedidoActivo).
      const cantidadAguaActual = pedidoActivo?.cantidad_agua ?? 0;
      const cantidadCremaActual = pedidoActivo?.cantidad_crema ?? 0;

      let cantidadAguaFinal = aplicarOperacionCantidad(
        object.cantidad_agua_operacion,
        object.cantidad_agua,
        cantidadAguaActual,
      );
      let cantidadCremaFinal = aplicarOperacionCantidad(
        object.cantidad_crema_operacion,
        object.cantidad_crema,
        cantidadCremaActual,
      );

      console.log(`🧮 Cantidades: agua ${cantidadAguaActual} -> ${cantidadAguaFinal} (op: ${object.cantidad_agua_operacion}, valor: ${object.cantidad_agua}), crema ${cantidadCremaActual} -> ${cantidadCremaFinal} (op: ${object.cantidad_crema_operacion}, valor: ${object.cantidad_crema})`);

      // VETO DE UNIDAD NO SOPORTADA: el modelo tomó el número de una expresión en
      // kilos/potes/porciones y lo asignó como si fueran unidades. El prompt le pide
      // dejarlo en "mantener", pero no siempre obedece: "que sean 2 kilos" sobre 40
      // de crema volvió como `reemplazar 2` y el pedido pasó de 40 unidades a 2.
      // Revertimos al valor actual; abajo el flujo le explica que vendemos por unidad.
      for (const [tipo, valorLiteral, actual, final] of [
        ['agua', object.cantidad_agua, cantidadAguaActual, cantidadAguaFinal],
        ['crema', object.cantidad_crema, cantidadCremaActual, cantidadCremaFinal],
      ] as const) {
        if (final === actual) continue;
        if (!cantidadVieneDeUnidadNoSoportada(textoBatch, valorLiteral)) continue;
        console.warn(`⚖️ Veto: el modelo asignó ${valorLiteral} a ${tipo} tomándolo de una unidad que no vendemos ("${textoBatch}"). Revierto a ${actual}.`);
        if (tipo === 'agua') cantidadAguaFinal = actual;
        else cantidadCremaFinal = actual;
      }

      // TELEMETRÍA: "mantener" con un valor != 0 es una salida INCOHERENTE del
      // modelo (dice "no hay cantidad para este tipo" pero igual extrajo un
      // número). El literal se descarta en silencio, y ese silencio es lo que
      // hizo invisible el hallazgo #3. Lo dejamos ruidoso.
      for (const [tipo, op, valor] of [
        ['agua', object.cantidad_agua_operacion, object.cantidad_agua],
        ['crema', object.cantidad_crema_operacion, object.cantidad_crema],
      ] as const) {
        if (op === 'mantener' && valor !== 0) {
          console.warn(`⚠️ Salida incoherente del modelo: cantidad_${tipo}_operacion="mantener" con valor=${valor}. El literal se descarta; la red de cantidad pelada puede recuperarlo.`);
        }
      }

      // RED DE CANTIDAD PELADA (determinista, respalda al modelo): el cliente
      // corrigió la cantidad sin nombrar el tipo ("son 30 ahora") y el merge no
      // movió NADA. Sin esto la corrección se pierde en silencio y el bot repite
      // el mismo pedido de datos faltantes (hallazgo #3 del informe 32740622175).
      //
      // Solo actúa si: hay pedido activo no despachado, el merge dejó las DOS
      // cantidades intactas, y el cliente no nombró el tipo (si lo nombró, el
      // modelo tenía toda la info y su decisión manda).
      if (
        pedidoActivo &&
        !estaDespachado(pedidoActivo) &&
        cantidadAguaFinal === cantidadAguaActual &&
        cantidadCremaFinal === cantidadCremaActual &&
        !mencionaTipoHelado(textoBatch)
      ) {
        const tiposCargados =
          (cantidadAguaActual > 0 ? 1 : 0) + (cantidadCremaActual > 0 ? 1 : 0);
        const pelada = detectarCantidadPelada(textoBatch);
        if (pelada !== null) {
          if (tiposCargados === 1) {
            // Un solo tipo cargado: el número es inequívocamente de ESE tipo.
            if (cantidadAguaActual > 0) {
              cantidadAguaFinal = pelada;
            } else {
              cantidadCremaFinal = pelada;
            }
            console.log(`🔢 Red de cantidad pelada: "${textoBatch}" → ${pelada} sobre ${cantidadAguaActual > 0 ? 'agua' : 'crema'} (único tipo cargado).`);
          } else if (tiposCargados === 2) {
            // Los dos tipos cargados: NO adivinamos a cuál se refiere. Lo tratamos
            // como tipo ambiguo y le preguntamos, misma maquinaria que
            // `cantidad_sin_tipo` (los botones ya llevan la cantidad).
            cantidadPeladaAmbigua = pelada;
            console.log(`🔢 Red de cantidad pelada: ${pelada} con AMBOS tipos cargados. No adivino: le pregunto cuál.`);
          }
          // tiposCargados === 0 → lo cubre `cantidad_sin_tipo`, no tocamos nada.
        } else {
          // No es un REEMPLAZO pelado. ¿Es un DELTA pelado ("sumale 10")? El modelo
          // lo dejó sin aplicar (por eso el merge no movió nada) porque no supo el
          // tipo. `detectarCantidadPelada` justamente vetea los deltas, así que este
          // caso solo lo capta `detectarDeltaPelado`.
          const delta = detectarDeltaPelado(textoBatch);
          if (delta !== null) {
            if (tiposCargados === 1) {
              // Un solo tipo cargado: el delta es inequívocamente de ESE tipo.
              // Aplicamos con el mismo clamp a 0 que el merge del modelo.
              if (cantidadAguaActual > 0) {
                cantidadAguaFinal = aplicarOperacionCantidad(delta.operacion, delta.valor, cantidadAguaActual);
              } else {
                cantidadCremaFinal = aplicarOperacionCantidad(delta.operacion, delta.valor, cantidadCremaActual);
              }
              console.log(`🔢 Red de delta pelado: "${textoBatch}" → ${delta.operacion} ${delta.valor} sobre ${cantidadAguaActual > 0 ? 'agua' : 'crema'} (único tipo cargado).`);
            } else if (tiposCargados === 2) {
              // Los dos tipos cargados: NO adivinamos a cuál se refiere. Preguntamos,
              // pero llevando la operación para que la respuesta sume/reste.
              deltaPeladoAmbiguo = delta;
              console.log(`🔢 Red de delta pelado: ${delta.operacion} ${delta.valor} con AMBOS tipos cargados. No adivino: le pregunto cuál.`);
            }
            // tiposCargados === 0 → no hay pedido sobre el cual sumar/restar.
          }
        }
      }

      // Misma filosofía que las cantidades: el modelo extrajo el texto literal
      // + la operación; la fusión la hace TS de forma determinista. Si además
      // cambió la dirección, `resolverAclaracion` descarta la aclaración vieja
      // (pertenecía a la dirección anterior) — ver su doc.
      const aclaracionActual = pedidoActivo?.aclaracion ?? null;
      const aclaracionFinal = resolverAclaracion(
        object.aclaracion_operacion,
        object.aclaracion,
        aclaracionActual,
        object.direccion,
        pedidoActivo?.direccion ?? null,
      );
      console.log(`📝 Aclaración: "${aclaracionActual ?? ''}" -> "${aclaracionFinal ?? ''}" (op: ${object.aclaracion_operacion}, texto: "${object.aclaracion ?? ''}")`);

      // OBSERVACIONES: merge keyed por tipo, en TS. Leemos los slots actuales
      // (sembrando general desde el texto plano si la fila no tiene jsonb),
      // aplicamos la operación de cada slot y reconstruimos el texto plano.
      const slotsActuales = leerSlots(pedidoActivo);
      const slotsFinales: ObsSlots = {
        agua: aplicarOperacionObs(object.obs_agua_operacion, object.obs_agua, slotsActuales.agua),
        crema: aplicarOperacionObs(object.obs_crema_operacion, object.obs_crema, slotsActuales.crema),
        general: aplicarOperacionObs(object.obs_general_operacion, object.obs_general, slotsActuales.general),
      };
      const observacionesFinal = reconstruirObservaciones(slotsFinales);
      console.log(`🍨 Observaciones: ${JSON.stringify(slotsActuales)} -> ${JSON.stringify(slotsFinales)} => "${observacionesFinal ?? ''}"`);

      // Red determinista para metodo_pago: el modelo a veces devuelve el TEXTO
      // "null" (u otro placeholder) en vez del null de JSON; sin coerción, ese
      // "null" se colaba como un pago válido ("Pago: null" en el resumen). Solo
      // dejamos pasar 'efectivo'/'transferencia'; el resto cae a null y el flujo
      // vuelve a pedir la forma de pago.
      const metodoPagoFinal = normalizarMetodoPago(object.metodo_pago);

      pedido = {
        ...object,
        cantidad_agua: cantidadAguaFinal,
        cantidad_crema: cantidadCremaFinal,
        aclaracion: aclaracionFinal,
        observaciones: observacionesFinal,
        observaciones_detalle: slotsFinales,
        metodo_pago: metodoPagoFinal,
        datos_completos: Boolean(
          object.direccion && metodoPagoFinal && (cantidadAguaFinal > 0 || cantidadCremaFinal > 0)
        ),
      };

      console.log(`✅ Objeto IA extraído (modelo ${modelo}, intento ${attempt}/${MAX_ATTEMPTS}):`, pedido);
      break;
    } catch (iaError) {
      lastError = iaError;
      // 429 = se agotó la cuota de ESTE modelo (rate limit / TPD). No tiene
      // sentido reintentarlo: saltamos al siguiente de la cadena (que tiene su
      // propia cubeta) para no dejar al cliente sin respuesta.
      if (esRateLimit(iaError)) {
        const fallback = siguienteModelo(modeloIdx, MODELOS_EXTRACCION);
        console.warn(`🚧 Rate limit (429) en "${modelo}". Fallback a "${fallback ?? '(cadena agotada)'}".`);
        // Telemetría de ops: registramos el salto para que el dashboard avise que
        // el primario está caído. Fail-open y no bloqueante — un fallo acá no
        // debe frenar la respuesta al cliente (que ya está en camino degradado).
        void registrarAlertaFallback(modelo, fallback, numeroCliente);
        modeloIdx++;
        attempt = 0;
        continue;
      }
      // Error de validación (non-determinismo del modelo): reintentamos el mismo
      // modelo hasta MAX_ATTEMPTS y, agotados, nos rendimos (comportamiento de
      // siempre; el fallback es solo para cuota, no para mala suerte de parseo).
      console.warn(`⚠️ Intento ${attempt}/${MAX_ATTEMPTS} con "${modelo}" falló:`, iaError instanceof Error ? iaError.message : iaError);
      if (attempt >= MAX_ATTEMPTS) break;
    }
  }

  if (!pedido) {
    console.error("❌ Falló la extracción structured tras toda la cadena de modelos:", lastError);
    await enviarMensajeWhatsApp(numeroCliente, "Disculpá, no te entendí 😅 ¿Me lo repetís? Por ejemplo: *20 de agua y 10 de crema, Mitre 950, efectivo* 🙏");
    return;
  }

  try {

    // #2 — RECHAZO EXPLÍCITO DE CANCELACIÓN (red determinista, temprana): en
    // esperando_cancelacion, un "no lo cancelo" mezclado con otra frase (ej.
    // "No, no lo cancelo, dame el total ya") desviaba la clasificación del
    // modelo y dejaba el pedido trabado. Este flag corre sobre el texto crudo y
    // se usa (a) para que los handlers de consulta —precios / negocio, que
    // CORTAN el flujo con return— no roben el mensaje antes del bloque de
    // cancelación, y (b) para forzar rechazar_cancelacion dentro de ese bloque.
    const rechazoCancelacionExplicito =
      pedidoActivo?.estado === 'esperando_cancelacion' &&
      mencionaRechazoCancelacion(textoBatch);

    // #1 — CLAMP DE INTENCIÓN POR ESTADO. El enum del schema es global, así que el
    // modelo puede devolver una intención que en este estado no tiene handler (ej.
    // `confirmar_cancelacion` estando en `borrador`, cuyo único handler vive dentro
    // del bloque de esperando_cancelacion). Esas intenciones HUÉRFANAS no matchean
    // nada y el mensaje termina en el fallback de reenviar el resumen, en loop y
    // para siempre. Las acotamos al catch-all, que todos los estados manejan.
    const intencionCruda = pedido.intencion;
    pedido.intencion = clampIntencionPorEstado(intencionCruda, pedidoActivo?.estado ?? null, {
      hayPedidoCanceladoReciente: Boolean(ultimoPedidoCancelado),
    });
    if (pedido.intencion !== intencionCruda) {
      console.log(`🧭 Intención "${intencionCruda}" no es válida con estado "${pedidoActivo?.estado ?? 'sin pedido'}". La acoto a "${pedido.intencion}".`);
    }

    // #2 — ¿El mensaje trae datos del pedido además de la consulta? Los handlers de
    // consulta (precios / negocio) CORTAN el flujo con return antes de aplicar y
    // persistir nada, así que sin esta señal un "transferencia. y hasta qué hora
    // entregan?" perdía el pago en silencio (hallazgo #2 del informe 32740622175).
    const traeDatos = traeDatosDePedido(pedido);
    if (traeDatos && (pedido.intencion === 'consulta_negocio' || pedido.intencion === 'consultar_precios')) {
      // El prompt ya pide `datos_pedido` en este caso, pero es una regla soft. Esta
      // es la red determinista equivalente a las que ya existen para `saludo`+datos
      // y `modificar_sin_datos`+cambios. La pregunta NO se pierde: el bloque
      // ortogonal de `pregunta_negocio` (abajo) la responde o la delega igual.
      console.log(`🛠️ OVERRIDE: intención "${pedido.intencion}" pero el mensaje trae datos del pedido. Reclasifico a datos_pedido para no descartarlos.`);
      pedido.intencion = 'datos_pedido';
    }

    // CONSULTA DE NEGOCIO EMBEBIDA (versión completa): el modelo copia en
    // `pregunta_negocio` toda pregunta real de negocio, INCLUSO cuando el
    // mensaje además trae datos del pedido (intención datos_pedido/confirmar/
    // etc.). La delegamos a un humano — flag `requiere_atencion` + aviso al
    // cliente — y DEJAMOS SEGUIR el flujo normal, así el pedido igual se
    // procesa (antes esa pregunta se descartaba en silencio, o peor: si el
    // pedido no parseaba, no pasaba nada). La intención `consulta_negocio`
    // (pregunta PURA) tiene su propio handler abajo que ya delega y corta, así
    // que la excluimos acá para no avisar dos veces.
    // Nota: un mensaje MIXTO que el modelo clasificó `consulta_negocio` ya fue
    // reclasificado a `datos_pedido` arriba, así que entra por acá — que es lo que
    // corresponde, porque este bloque NO corta el flujo y el de abajo sí.
    // ¿Ya contestamos/delegamos una pregunta de negocio embebida este turno? Si
    // sí y el pedido no cambia, esa respuesta ES la respuesta del turno: no hay
    // que mandarle encima la desambiguación "no te entendí" (contradictorio justo
    // después de "ya le pasé tu consulta a una persona"). Caso real: una pregunta
    // PURA ("hasta qué hora abren?") que el modelo clasificó `consulta_negocio`
    // pero con `metodo_pago`/`direccion` ECO del pedido — `traeDatosDePedido`
    // contó el eco y el override la mandó al path mixto (que no corta el flujo).
    let respondiPreguntaNegocioEmbebida = false;
    const hayPreguntaNegocio = esPreguntaNegocioReal(pedido.pregunta_negocio);
    if (hayPreguntaNegocio && pedido.intencion !== 'consulta_negocio') {
      // Primero intentamos responderla NOSOTROS desde el contexto conocido
      // (tipos agua/crema, sabores, demora, envíos, y el total del pedido en
      // curso). Si el modelo puede, contestamos y seguimos armando el pedido:
      // esto elimina el patrón "negar y después contestar" (#3), donde antes
      // mandábamos "te contesta una persona" y en la burbuja siguiente ya
      // mostrábamos el total. Si NO puede (horarios/zonas/stock/promos…),
      // delegamos a un humano como siempre.
      const seedDelegacion = mensajesClaim.reduce((acc, m) => acc + (m.texto?.length ?? 0), 0);
      const respuestaNegocio = await intentarRespuestaNegocio(pedido.pregunta_negocio!, pedidoActivo, numeroCliente);
      if (respuestaNegocio) {
        console.log(`💬 Pregunta de negocio embebida ("${pedido.pregunta_negocio}") respondida desde el contexto. Sigo el flujo del pedido.`);
        await enviarMensajeWhatsApp(numeroCliente, respuestaNegocio);
      } else {
        console.log(`🙋 Pregunta de negocio embebida ("${pedido.pregunta_negocio}") fuera del contexto conocido. Delego a un humano y sigo el flujo del pedido.`);
        await delegarAHumano(numeroCliente, seedDelegacion);
      }
      respondiPreguntaNegocioEmbebida = true;
      // NO retornamos: si el mensaje trae datos del pedido, el flujo de armado
      // de abajo los procesa igual (resumen / pedir lo que falta).
    }

    // CONSULTA DE PRECIOS: intención informativa, independiente del pedido.
    // La resolvemos antes de tocar dirección/cantidades para que un "¿cuánto
    // sale?" NUNCA dispare la lógica de armado (inyección de dirección
    // histórica, datos faltantes, etc.). El pedido activo (si lo hay) queda
    // intacto: solo mandamos la lista y salimos. Es la MISMA lista que muestra
    // la página pública /precios, generada desde la lista de precios activa.
    if (pedido.intencion === 'consultar_precios' && !rechazoCancelacionExplicito) {
      console.log("💲 El cliente pregunta por los precios. Respondiendo con la lista activa.");
      const lista = await obtenerListaPreciosPublica();
      const respuesta = lista
        ? formatearPreciosWhatsApp(lista)
        : "Ahora no puedo ver la lista de precios 😅 Escribime qué querés pedir y te ayudo igual.";
      // Cola contextual: si el hilo quedó con un pedido en juego, se lo
      // recordamos para que la consulta de precios no le pierda el pedido en el
      // medio (distingue borrador completo esperando SÍ/NO vs borrador en armado).
      const cola = colaRecordatorioPedido(pedidoActivo);
      await enviarMensajeWhatsApp(numeroCliente, respuesta + cola);
      return;
    }

    // CONSULTA DE NEGOCIO: pregunta real sobre el negocio (horarios, zonas,
    // sabores disponibles, stock, promos, mayorista, reclamos...) que el bot
    // no sabe responder. Se DELEGA a un humano con el mismo mecanismo que los
    // medias entrantes: requiere_atencion=true → punto ámbar + badge en el
    // menú de conversaciones del dashboard. El pedido activo (si lo hay) queda
    // intacto; igual que con precios, si el hilo esperaba una respuesta se lo
    // recordamos para que la consulta no le pierda el pedido en el medio.
    // El filtro "pregunta REAL vs sin sentido/off-topic" lo hace el prompt:
    // mensajes nada que ver caen en datos_pedido y siguen el flujo normal.
    if (pedido.intencion === 'consulta_negocio' && !rechazoCancelacionExplicito) {
      const cola = colaRecordatorioPedido(pedidoActivo);
      // La pregunta pura la copia el modelo en `pregunta_negocio`; si por algún
      // no-determinismo vino null, usamos el texto crudo del batch como fallback.
      const preguntaTexto = esPreguntaNegocioReal(pedido.pregunta_negocio)
        ? pedido.pregunta_negocio!
        : textoBatch.trim();
      const respuestaNegocio = await intentarRespuestaNegocio(preguntaTexto, pedidoActivo, numeroCliente);
      if (respuestaNegocio) {
        console.log("💬 Consulta de negocio respondida desde el contexto conocido.");
        await enviarMensajeWhatsApp(numeroCliente, respuestaNegocio + cola);
      } else {
        console.log("🙋 Consulta de negocio fuera del contexto conocido. Delegando a un humano.");
        const seedDelegacion = mensajesClaim.reduce((acc, m) => acc + (m.texto?.length ?? 0), 0);
        await delegarAHumano(numeroCliente, seedDelegacion, cola);
      }
      return;
    }

    // #7 — VALIDACIÓN DE DIRECCIÓN (determinista, antes de todo lo demás):
    // si el modelo puso en `direccion` algo que no parece calle+altura (metió
    // una aclaración como "depto 6", o una calle sin número), lo descartamos.
    // Cae a null y abajo se inyecta la histórica si existe; si no, el flujo
    // normal le pide la dirección al cliente. Corre antes del override de saludo
    // (así una dirección inválida no cuenta como "dato útil") y antes de
    // hayCambiosReales (así no se interpreta como un cambio real).
    if (pedido.direccion && !pareceDireccion(pedido.direccion)) {
      console.log(`📍 La dirección "${pedido.direccion}" no pasó la validación de formato (no parece calle+altura). La descarto.`);
      pedido.direccion = null;
    }

    // #2 — RED DE RETIRO (determinista, respalda al modelo): si NO quedó una
    // dirección de envío válida pero el cliente dijo que pasa a retirar (en
    // cualquier conjugación/variante), ponemos el sentinela "retira". Corre
    // DESPUÉS del guard de formato (así "Corrientes 1234, retiro" prioriza la
    // calle real que ya quedó en `direccion`) y ANTES de la inyección histórica
    // (un retiro no debe rellenarse con la dirección guardada). Usa el texto
    // crudo del batch del cliente, no la extracción del modelo.
    if (!pedido.direccion) {
      if (mencionaRetiro(textoBatch)) {
        console.log('🛵 Retiro detectado en el mensaje del cliente. Seteo direccion="retira".');
        pedido.direccion = 'retira';
      }
    }

    // IMPORTANTE: el override de saludo y el cálculo de cambios reales corren
    // ANTES de la inyección de dirección histórica. Si los corriéramos después,
    // un "hola" suelto terminaría con `pedido.direccion` seteado (inyectado de
    // historia) y `trajoDatosUtiles` daría true, anulando todo saludo legítimo.
    // Trabajamos con el output crudo del modelo y recién después rellenamos
    // con la histórica para que el flow downstream pueda armar el pedido.

    let hayCambiosReales = false;

    if (pedidoActivo && !pedidoEnviado) {
      hayCambiosReales =
        (pedido.cantidad_agua ?? pedidoActivo.cantidad_agua) !== pedidoActivo.cantidad_agua ||
        (pedido.cantidad_crema ?? pedidoActivo.cantidad_crema) !== pedidoActivo.cantidad_crema ||
        (pedido.direccion ?? pedidoActivo.direccion) !== pedidoActivo.direccion ||
        (pedido.aclaracion ?? pedidoActivo.aclaracion) !== pedidoActivo.aclaracion ||
        (pedido.observaciones ?? pedidoActivo.observaciones) !== pedidoActivo.observaciones ||
        (pedido.metodo_pago ?? pedidoActivo.metodo_pago) !== pedidoActivo.metodo_pago;

      console.log(`🔍 Evaluación de cambios reales: ${hayCambiosReales}`);

      if (pedido.intencion === 'modificar_sin_datos' && hayCambiosReales) {
        console.log("🛠️ OVERRIDE: La IA marcó modificar_sin_datos pero hay cambios reales. Reclasificando como datos_pedido.");
        pedido.intencion = 'datos_pedido';
      }
    }

    // Override de Saludo Puro
    let trajoDatosUtiles = false;

    if (pedidoActivo && !pedidoEnviado) {
      trajoDatosUtiles = hayCambiosReales || pedido.intencion === 'cancelar' || pedido.intencion === 'confirmar';
    } else {
      // Para anular el flag de saludo solo consideramos señales CONCRETAS
      // (numéricas o con formato esperado). Excluimos `observaciones` a
      // propósito: es texto libre y el modelo a veces lo inventa cuando el
      // cliente solo saluda, lo que llevaba a anular saludos legítimos.
      // `pedido.direccion` acá es el output crudo del modelo: si el cliente
      // NO la mencionó en este mensaje, viene en null aunque haya histórica.
      trajoDatosUtiles =
        pedido.cantidad_agua > 0 ||
        pedido.cantidad_crema > 0 ||
        pedido.direccion !== null ||
        pedido.metodo_pago !== null;
    }

    if (pedido.intencion === 'saludo' && trajoDatosUtiles) {
      console.log("🛠️ OVERRIDE: La IA marcó saludo pero el mensaje trae datos del pedido. Reclasificando como datos_pedido.");
      pedido.intencion = 'datos_pedido';
    }

    // OVERRIDE DE DIRECCIÓN HISTÓRICA: solo después de haber decidido el saludo.
    // Si el cliente solo saludó, no llega acá (return en la rama de saludo),
    // así que la histórica no contamina ese path. Para mensajes con datos
    // reales, rellenamos lo que falte.
    // #8: marcamos cuándo la dirección se rellenó desde un pedido ANTERIOR del
    // cliente (solo en pedidos nuevos: con pedidoActivo la dirección es la del
    // propio pedido en curso, que el cliente ya vio). Se lo avisamos en el
    // resumen para que pueda corregirla si se mudó / quiere otra entrega.
    let direccionInyectadaDeHistorial = false;
    if (!pedido.direccion && direccionGuardada) {
      console.log(`🛠️ OVERRIDE: El cliente no pasó dirección. Inyectando histórica: ${direccionGuardada}`);
      pedido.direccion = direccionGuardada;
      pedido.aclaracion = pedido.aclaracion ?? aclaracionGuardada;
      direccionInyectadaDeHistorial = !pedidoActivo;
    }

    pedido.datos_completos = Boolean(pedido.direccion && pedido.metodo_pago && (pedido.cantidad_agua > 0 || pedido.cantidad_crema > 0));

    // VALORES FINALES tras mergear el mensaje actual con el pedido activo (si
    // lo hay). Son la base tanto para decidir completitud como para persistir.
    // Usamos '' como placeholder de "dato todavía no cargado" en las columnas
    // NOT NULL (direccion/metodo_pago): '' es falsy, así que la lógica de
    // faltantes lo trata como ausente sin ramas especiales. `pedido.cantidad_*`
    // y `pedido.observaciones` ya vienen mergeados de arriba.
    const aguaFinal = pedido.cantidad_agua;
    const cremaFinal = pedido.cantidad_crema;
    const dirFinal = pedido.direccion ?? pedidoActivo?.direccion ?? '';
    const pagoFinal = pedido.metodo_pago ?? pedidoActivo?.metodo_pago ?? '';
    const aclaracionFinal = pedido.aclaracion ?? pedidoActivo?.aclaracion ?? null;

    const faltaCantidad = !(aguaFinal > 0 || cremaFinal > 0);
    const faltaDireccion = !dirFinal;
    const faltaPago = !pagoFinal;
    const pedidoCompleto = !faltaCantidad && !faltaDireccion && !faltaPago;

    // Guard determinista: si el cliente expresó la cantidad en kilo/pote/porción,
    // el modelo la dejó en 0 (por diseño del prompt) y sin esta señal pedirDatos
    // Faltantes respondería con el "me falta cantidad" genérico → loop porque el
    // cliente cree que ya la dio. Reutilizamos el texto crudo del batch de arriba.
    // No se gatea con `faltaCantidad`: el cliente también puede intentar corregir
    // en kilos un pedido que YA tiene cantidad ("que sean 2 kilos" sobre 40). Lo
    // que descalifica la señal es que el mensaje SÍ haya movido algo: ahí la
    // unidad rara era ruido al lado de un dato válido y no hay nada que explicar.
    const cantidadEnUnidadNoSoportada = mencionaCantidadEnUnidadNoSoportada(textoBatch) && !hayCambiosReales;
    const pagoNoSoportado = faltaPago && mencionaMetodoPagoNoSoportado(textoBatch);

    // TIPO DE HELADO AMBIGUO: el modelo dejó la cantidad en `cantidad_sin_tipo`
    // porque el cliente no dijo si eran de agua o de crema ("quiero 50 helados de
    // frutilla" — frutilla existe en los dos tipos, así que adivinar escribía un
    // pedido que el cliente nunca hizo). Veto determinista con `mencionaTipoHelado`:
    // si el texto crudo SÍ nombra el tipo, la señal es un no-determinismo del
    // modelo y la ignoramos.
    //
    // Tres orígenes, misma pregunta al cliente:
    //  (a) NO quedó ninguna cantidad cargada y el modelo puso el número en
    //      `cantidad_sin_tipo` ("quiero 50 helados de frutilla").
    //  (b) el cliente corrigió con un número pelado ("mejor que sean 30") sobre un
    //      pedido que tiene LOS DOS tipos cargados: la red de cantidad pelada no
    //      puede saber a cuál se refiere, así que en vez de descartarlo (que es lo
    //      que pasaba antes, en silencio) preguntamos. → REEMPLAZO.
    //  (c) el cliente mandó un DELTA pelado ("sumale 10") sobre un pedido con los
    //      dos tipos: misma pregunta, pero la respuesta suma/resta en vez de
    //      reemplazar (la operación viaja en `tipoHeladoAmbiguo.operacion`).
    const cantidadSinTipo = mencionaTipoHelado(textoBatch)
      ? 0
      : faltaCantidad
        ? Math.max(0, Math.trunc(pedido.cantidad_sin_tipo ?? 0))
        : cantidadPeladaAmbigua;
    let tipoHeladoAmbiguo: TipoHeladoAmbiguo | null =
      cantidadSinTipo > 0 ? { cantidad: cantidadSinTipo, textoCliente: textoBatch } : null;
    // El delta pelado ambiguo solo aplica cuando NO hubo un reemplazo pelado (son
    // mutuamente excluyentes por construcción: detectarDeltaPelado corre solo si
    // detectarCantidadPelada devolvió null).
    if (!tipoHeladoAmbiguo && deltaPeladoAmbiguo) {
      tipoHeladoAmbiguo = {
        cantidad: deltaPeladoAmbiguo.valor,
        textoCliente: textoBatch,
        operacion: deltaPeladoAmbiguo.operacion,
      };
    }
    if (tipoHeladoAmbiguo) {
      const detalleOp = tipoHeladoAmbiguo.operacion && tipoHeladoAmbiguo.operacion !== 'reemplazar'
        ? ` (${tipoHeladoAmbiguo.operacion})`
        : '';
      console.log(`🍦 El cliente pidió ${tipoHeladoAmbiguo.cantidad} helados sin decir el tipo${detalleOp}. Le pregunto agua/crema en vez de adivinar.`);
    }

    // #1 — RED DE CONFIRMACIÓN (determinista, respalda al modelo): el borrador está
    // completo, el cliente no cambió nada y su texto dice explícitamente que
    // confirma. Si el modelo no lo clasificó como `confirmar`, el mensaje termina en
    // el fallback de reenviar el resumen y el pedido no llega nunca a cocina — el
    // caso real fue "Sí, confirmá." después de rechazar una cancelación (hallazgo #1
    // del informe 32740622175).
    //
    // Solo actúa si el modelo NO eligió ya una intención accionable: si acertó, o si
    // el cliente pidió otra cosa (cancelar, modificar, una consulta), su decisión
    // manda. Y nunca sobre un borrador incompleto: eso lo maneja `pedirDatosFaltantes`.
    if (
      pedidoActivo?.estado === 'borrador' &&
      pedidoCompleto &&
      !hayCambiosReales &&
      !INTENCIONES_ACCIONABLES.includes(pedido.intencion) &&
      mencionaConfirmacion(textoBatch)
    ) {
      console.log(`🛡️ Red determinista: confirmación explícita ("${textoBatch}") que el modelo clasificó "${pedido.intencion}". Reclasifico a confirmar.`);
      pedido.intencion = 'confirmar';
    }

    // 1. PRIORIDAD ABSOLUTA: CANCELACIÓN
    //
    // Todos los UPDATE de estos flujos van con guard atómico:
    //   .neq('estado', 'enviado').neq('enviado', true)
    // Esto evita una race condition: entre que leímos pedidoActivo y ahora,
    // el repartidor pudo haber tocado "Marcar como enviado". Si el UPDATE
    // afecta 0 filas, sabemos que se envió en la ventana y le avisamos al cliente.
    if (pedidoActivo && pedidoActivo.estado === 'esperando_cancelacion') {
      // #2 — Si el texto crudo es una negación EXPLÍCITA de cancelar y el modelo
      // no lo reconoció como confirmar/rechazar ni como una modificación real
      // (datos_pedido + cambios), lo forzamos a rechazar_cancelacion. El handler
      // de abajo reenvía el resumen (con el total), así un "no lo cancelo, dame
      // el total" queda contestado de paso y el pedido no queda trabado.
      if (
        rechazoCancelacionExplicito &&
        pedido.intencion !== 'confirmar_cancelacion' &&
        !(pedido.intencion === 'datos_pedido' && hayCambiosReales)
      ) {
        console.log('🛡️ Red determinista: negación explícita de cancelar; reclasifico a rechazar_cancelacion.');
        pedido.intencion = 'rechazar_cancelacion';
      }
      if (pedido.intencion === 'confirmar_cancelacion') {
        const { data: cancelados } = await supabaseAdmin
          .from('pedidos')
          .update(patchConEnviadoCoherente('cancelado'))
          .eq('id', pedidoActivo.id)
          .neq('estado', 'enviado')
          .neq('enviado', true)
          .select('id');

        if (cancelados && cancelados.length > 0) {
          await enviarMensajeWhatsApp(numeroCliente, "Pedido cancelado. Cuando quieras helado, acá estoy 👋");
          console.log(`✅ Pedido ${pedidoActivo.id} cancelado.`);
          // La conversación cerró: marcamos los mensajes como descartados
          // para que no contaminen el historial de la próxima conversación.
          await marcarHistorialDescartado(numeroCliente);
        } else {
          console.log(`⚠️ Race detectada: el pedido ${pedidoActivo.id} fue enviado entre el read y el UPDATE.`);
          await enviarMensajeWhatsApp(numeroCliente, "Uy, llegamos tarde. Tu pedido ya está en camino y no se pudo cancelar 🛵");
        }
      } else if (pedido.intencion === 'rechazar_cancelacion') {
        // Volvemos el pedido a borrador. Si mientras tanto se envió o canceló
        // por otro lado, no lo tocamos.
        const { data: rechazados } = await supabaseAdmin
          .from('pedidos')
          .update({ estado: 'borrador' })
          .eq('id', pedidoActivo.id)
          .eq('estado', 'esperando_cancelacion') // Solo si sigue en este estado
          .select('*')
          .maybeSingle();

        if (rechazados) {
          // Mismo invariante que el resto de los envíos de resumen: si el
          // borrador reabierto está incompleto (rechazar_cancelacion no aporta
          // datos nuevos, así que la completitud es la de ANTES de la
          // cancelación), pedimos el dato faltante en vez de mandar un resumen
          // vacío con botón "Confirmar" (que dispararía un pedido roto a cocina).
          if (esBorradorCompleto(rechazados)) {
            await enviarResumenYPedirConfirmacion(numeroCliente, rechazados, false);
          } else {
            await pedirDatosFaltantes(
              numeroCliente,
              !((rechazados.cantidad_agua ?? 0) > 0 || (rechazados.cantidad_crema ?? 0) > 0),
              !rechazados.direccion,
              !rechazados.metodo_pago,
              undefined,
              0,
              cantidadEnUnidadNoSoportada,
              pagoNoSoportado,
              tipoHeladoAmbiguo,
            );
          }
        } else {
          console.log(`⚠️ El pedido ${pedidoActivo.id} ya no está en 'esperando_cancelacion'. Algo cambió en paralelo.`);
          await enviarMensajeWhatsApp(numeroCliente, "Algo cambió con tu pedido. Escribime de nuevo y seguimos 🙏");
        }
      } else if (pedido.intencion === 'datos_pedido' && hayCambiosReales) {
        // El cliente no contestó la cancelación: mandó cambios concretos
        // ("no, mejor 20 de crema"). Antes esto se descartaba en silencio y se
        // re-preguntaba "¿querés cancelar?". Lo tratamos como rechazo implícito
        // de la cancelación + modificación: volvemos a borrador con los datos
        // nuevos y mandamos el resumen actualizado.
        console.log("🛠️ Cambios reales durante esperando_cancelacion: rechazo implícito + modificación.");
        const { data: actualizado } = await supabaseAdmin
          .from('pedidos')
          .update({
            cantidad_agua: pedido.cantidad_agua ?? pedidoActivo.cantidad_agua,
            cantidad_crema: pedido.cantidad_crema ?? pedidoActivo.cantidad_crema,
            direccion: pedido.direccion ?? pedidoActivo.direccion,
            // Dirección nueva del cliente → deja de ser la del historial.
            ...(pedido.direccion && pedido.direccion !== pedidoActivo.direccion
              ? { direccion_de_historial: false }
              : {}),
            aclaracion: pedido.aclaracion ?? pedidoActivo.aclaracion,
            observaciones: pedido.observaciones,
            observaciones_detalle: pedido.observaciones_detalle,
            metodo_pago: pedido.metodo_pago ?? pedidoActivo.metodo_pago,
            estado: 'borrador',
          })
          .eq('id', pedidoActivo.id)
          .eq('estado', 'esperando_cancelacion') // guard contra races
          .select('*')
          .maybeSingle();

        if (actualizado) {
          // Igual que en rechazar_cancelacion: el rechazo implícito puede llegar
          // con datos que igual dejen el borrador incompleto (ej: cliente que
          // rechaza la cancelación aportando solo un sabor, sin cantidad). Sin
          // este guard el resumen sale con campos vacíos y botón "Confirmar".
          if (esBorradorCompleto(actualizado)) {
            await enviarResumenYPedirConfirmacion(numeroCliente, actualizado, true);
          } else {
            await pedirDatosFaltantes(
              numeroCliente,
              !((actualizado.cantidad_agua ?? 0) > 0 || (actualizado.cantidad_crema ?? 0) > 0),
              !actualizado.direccion,
              !actualizado.metodo_pago,
              undefined,
              0,
              cantidadEnUnidadNoSoportada,
              pagoNoSoportado,
              tipoHeladoAmbiguo,
            );
          }
        } else {
          console.log(`⚠️ El pedido ${pedidoActivo.id} ya no está en 'esperando_cancelacion'. Algo cambió en paralelo.`);
          await enviarMensajeWhatsApp(numeroCliente, "Algo cambió con tu pedido. Escribime de nuevo y seguimos 🙏");
        }
      } else {
        await enviarConfirmacionCancelacion(numeroCliente, pedidoActivo.id, "Por favor, confirmame: ¿Querés cancelar el pedido?");
      }
      return;
    }

    if (pedido.intencion === 'cancelar' && pedidoActivo) {
      const { data: marcados } = await supabaseAdmin
        .from('pedidos')
        .update({ estado: 'esperando_cancelacion' })
        .eq('id', pedidoActivo.id)
        .neq('estado', 'enviado')
        .neq('enviado', true)
        .select('id');

      if (marcados && marcados.length > 0) {
        await enviarConfirmacionCancelacion(numeroCliente, pedidoActivo.id);
        console.log(`⚠️ Pedido ${pedidoActivo.id} puesto en estado 'esperando_cancelacion'.`);
      } else {
        console.log(`❌ El cliente quiso cancelar pero el pedido ${pedidoActivo.id} ya fue enviado (race o estado previo).`);
        await enviarMensajeWhatsApp(numeroCliente, "Uy, tu pedido ya está en camino, no podemos cancelarlo 🛵");
      }
      return;
    }

    // Cancelación sin pedidoActivo: ¿se refiere a un pedido ya despachado?
    if (pedido.intencion === 'cancelar' && !pedidoActivo) {
      if (ultimoPedidoEnviado) {
        await enviarMensajeWhatsApp(numeroCliente, "Uy, tu pedido ya está en camino, no podemos cancelarlo 🛵");
        console.log(`ℹ️ Cliente intentó cancelar pero el pedido ${ultimoPedidoEnviado.id} ya está despachado.`);
        // La conversación sobre ese pedido se cerró. Descartamos el historial
        // para que próximos mensajes no se mezclen con este intento.
        await marcarHistorialDescartado(numeroCliente);
      } else {
        await enviarMensajeWhatsApp(numeroCliente, "No tenés pedido activo para cancelar. Si querés hacer uno, mandame los datos 🍦");
        console.log(`ℹ️ Cliente pidió cancelar pero no tiene pedidos recientes.`);
      }
      return;
    }

    // #3 — REACTIVAR: el cliente canceló hace poco y se arrepintió ("no, quiero
    // el pedido"). En vez de arrancar de cero (perdiendo cantidad/pago), reabrimos
    // el pedido cancelado con SUS datos y lo devolvemos a borrador. La intención
    // solo la ofrece el prompt cuando hay un cancelado reciente (ultimoPedidoCancelado),
    // así que acá basta con verificar que siga existiendo (guard contra races).
    if (pedido.intencion === 'reactivar') {
      if (ultimoPedidoCancelado) {
        const { data: reabierto } = await supabaseAdmin
          .from('pedidos')
          .update({ estado: 'borrador' })
          .eq('id', ultimoPedidoCancelado.id)
          .eq('telefono', numeroCliente)
          .eq('estado', 'cancelado') // guard: sigue cancelado (no lo tocó otro proceso)
          .neq('enviado', true)
          .select('*')
          .maybeSingle();

        if (reabierto) {
          console.log(`↩️ Pedido ${reabierto.id} reactivado: vuelve a borrador con sus datos.`);
          if (esBorradorCompleto(reabierto)) {
            await enviarMensajeWhatsApp(numeroCliente, "¡Listo! Reactivé tu pedido 🙌 Te paso el resumen de nuevo:");
            await enviarResumenYPedirConfirmacion(numeroCliente, reabierto, false);
          } else {
            // Se había cancelado un borrador parcial: lo retomamos y pedimos lo que falta.
            await enviarMensajeWhatsApp(numeroCliente, "¡Listo! Retomo tu pedido 🙌 Me falta un dato para cerrarlo:");
            await pedirDatosFaltantes(
              numeroCliente,
              !(reabierto.cantidad_agua > 0 || reabierto.cantidad_crema > 0),
              !reabierto.direccion,
              !reabierto.metodo_pago,
              undefined,
              0,
              cantidadEnUnidadNoSoportada,
              pagoNoSoportado,
              tipoHeladoAmbiguo,
            );
          }
          return;
        }
        console.log(`⚠️ No se pudo reactivar el pedido ${ultimoPedidoCancelado.id} (ya no estaba cancelado). Sigo como pedido nuevo.`);
      }
      // Sin pedido cancelado reciente (o se perdió la carrera): no hay nada que
      // reabrir. Invitamos a armar uno nuevo en vez de dejar al cliente colgado.
      await enviarMensajeWhatsApp(numeroCliente, "No tengo un pedido reciente para reactivar 🤔 Si querés, armamos uno nuevo: mandame cantidades, dirección y forma de pago 🍦");
      return;
    }

    // Modificación de un pedido ya despachado (sin pedidoActivo): el pedido ya
    // salió, no se puede tocar. Mismo criterio que la cancelación de un
    // despachado. "Despachado" incluye enviado=true con estado='pendiente' (el
    // usuario copió el mensaje al cadete pero todavía no movió el estado a mano).
    // Limitación conocida: dentro de la ventana de 12h no podemos distinguir
    // "sumale 10 a lo que pedí" de "quiero pedir de nuevo", así que un pedido
    // NUEVO también se rebota hasta que el despachado sale de la ventana.
    if (pedido.intencion === 'datos_pedido' && !pedidoActivo && ultimoPedidoEnviado) {
      await enviarMensajeWhatsApp(numeroCliente, "Uy, tu pedido ya está en camino, no se puede modificar 🛵");
      console.log(`ℹ️ Cliente intentó modificar pero el pedido ${ultimoPedidoEnviado.id} ya está despachado.`);
      // Cerramos la conversación de ese pedido para que no se mezcle después.
      await marcarHistorialDescartado(numeroCliente);
      return;
    }

    // 2. SALUDO
    if (pedido.intencion === 'saludo') {
      if (yaExisteEnCocina) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tu pedido ya está en preparación. ¿Querés modificar algo?");
      } else if (tieneBorrador) {
        if (pedidoCompleto) {
          // Hay un resumen pendiente de confirmar: re-ofrecemos los MISMOS
          // botones del resumen (Sí, confirmar / No, modificar) para que
          // confirme con un toque. El "sí"/"no" escrito a mano sigue andando
          // igual (lo clasifica el LLM), así que damos las dos vías.
          const okBotones = await enviarMensajeConBotones(
            numeroCliente,
            "¡Hola! 👋 Tenés un pedido en pausa esperando confirmación. ¿Está todo bien? Tocá un botón o escribime *SÍ* / *NO*.",
            [
              { id: `confirmar_borrador_${pedidoActivo!.id}`, title: 'Sí, confirmar' },
              { id: `modificar_borrador_${pedidoActivo!.id}`, title: 'No, modificar' },
            ],
          );
          // Ronda nueva de botones: armamos el token de un solo uso para que
          // ejecutarBoton procese solo el primer click (ver botones.ts). Igual
          // que enviarResumenYPedirConfirmacion / enviarConfirmacionCancelacion.
          if (okBotones) {
            await supabaseAdmin
              .from('pedidos')
              .update({ esperando_respuesta_boton: true })
              .eq('id', pedidoActivo!.id);
          }
        } else {
          // Borrador parcial: todavía no hay nada que confirmar (ofrecer
          // "confirmar" acá haría 0 filas). Saludamos y re-pedimos lo que
          // falta en una sola burbuja (el saludo va prependido al cuerpo del
          // pedido de datos, sea texto libre, botones de pago o botón de retiro).
          await pedirDatosFaltantes(
            numeroCliente,
            faltaCantidad,
            faltaDireccion,
            faltaPago,
            "¡Hola! 👋 Tengo tu pedido en armado, me falta un dato para cerrarlo.",
            0,
            cantidadEnUnidadNoSoportada,
            pagoNoSoportado,
            tipoHeladoAmbiguo,
          );
        }
      } else if (esperandoCancelacion) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tu pedido está por cancelarse. ¿Confirmás? *SÍ* o *NO*");
      } else if (ultimoPedidoEnviado) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tu pedido ya está en camino 🛵");
      } else {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 ¿Qué te gustaría pedir?");
      }
      console.log("👋 El cliente saludó. Respondiendo según el contexto...");
      return;
    }

    // 3. MODIFICACIÓN SIN DATOS
    if (pedido.intencion === 'modificar_sin_datos' && (tieneBorrador || yaExisteEnCocina)) {
      await enviarMensajeWhatsApp(numeroCliente, "Dale, ¿qué querés cambiar? 📝");
      console.log("⚠️ El cliente quiere modificar pero no dio datos nuevos.");
      return;
    }

    // A esta altura ya resolvimos cancelación, saludo, precios y modificar_sin_datos.
    // Queda el flujo de armado/modificación con datos concretos (datos_pedido).

    // 4. BORRADOR EN CURSO (completo, o incompleto todavía en armado).
    if (tieneBorrador) {
      // VETO DE CONFIRMACIÓN FANTASMA. Caso real observado en pruebas manuales: con
      // el resumen ya enviado, el cliente REPITE su pedido textual ("20 de crema,
      // paso a retirar, efectivo"). El modelo lee "pregunté ¿está todo bien? y me
      // responde lo mismo" y devuelve `confirmar`; como los datos son idénticos
      // (`hayCambiosReales=false`), el pedido se iba a cocina sin que el cliente
      // hubiera confirmado nada.
      //
      // Repetir el pedido NO es confirmarlo. Exigimos alguna señal textual de
      // afirmación cuando el mensaje trae datos concretos. Un "sí"/"dale" pelado no
      // trae datos, así que las confirmaciones legítimas no se ven afectadas; y el
      // costo de un falso veto es una burbuja de más, contra mandar a cocina un
      // pedido que el cliente no aprobó.
      if (
        pedido.intencion === 'confirmar' &&
        !hayCambiosReales &&
        traeDatos &&
        !traeSenalDeConfirmacion(textoBatch)
      ) {
        console.log(`🛡️ Veto de confirmación fantasma: el modelo dijo "confirmar" pero el mensaje repite los datos del pedido sin ninguna señal de afirmación. Reenvío el resumen en vez de mandarlo a cocina.`);
        await enviarResumenYPedirConfirmacion(numeroCliente, pedidoActivo, false);
        return;
      }

      // Confirmación explícita: solo válida si el borrador ya está completo.
      // Un borrador incompleto (armado en partes) no se puede confirmar: falta
      // algún dato, así que lo pedimos en vez de mandarlo a cocina.
      if (pedido.intencion === 'confirmar' && !hayCambiosReales) {
        if (!pedidoCompleto) {
          console.log("⚠️ El cliente confirmó pero el borrador todavía está incompleto. Pido lo que falta.");
          await pedirDatosFaltantes(numeroCliente, faltaCantidad, faltaDireccion, faltaPago, undefined, 0, cantidadEnUnidadNoSoportada, pagoNoSoportado, tipoHeladoAmbiguo);
          return;
        }
        // Guard atómico: el borrador pudo pasar a cancelado (auto-rechazo del cron
        // u operador cancelando desde el dashboard) o quedar con enviado=true entre
        // el read de pedidoActivo y este UPDATE. Sin guard, este update resucita un
        // cancelado a 'pendiente' o pisa un despachado. Filas afectadas == 0 → race.
        const { data: finalData } = await supabaseAdmin
          .from('pedidos')
          .update({ estado: 'pendiente' })
          .eq('id', pedidoActivo.id)
          .eq('estado', 'borrador')
          .neq('enviado', true)
          .select('*')
          .maybeSingle();
        if (finalData) {
          await enviarMensajeWhatsApp(numeroCliente, mensajeConfirmacion(finalData.direccion, finalData.metodo_pago));
          console.log("✅ Pedido borrador confirmado por el cliente. Enviado a cocina.");
          // Cierre de la fase de armado: descartamos los mensajes del historial
          // para que futuras modificaciones no vean "quiero 10 de crema" etc.
          await marcarHistorialDescartado(numeroCliente);
        } else {
          console.log(`⚠️ Race al confirmar: el pedido ${pedidoActivo.id} ya no está en 'borrador' o fue despachado.`);
          await enviarMensajeWhatsApp(numeroCliente, "Algo cambió con tu pedido. Escribime de nuevo y seguimos 🙏");
        }
        return;
      }

      // TIPO AMBIGUO sobre un borrador COMPLETO: el cliente corrigió con un número
      // pelado —un reemplazo ("mejor que sean 30") o un delta ("sumale 10")— y el
      // pedido tiene los dos tipos cargados, así que no sabemos a cuál aplicarlo.
      // El merge no cambió nada (por eso llegamos acá), y sin esta rama el mensaje
      // caería al fallback de abajo y el número se perdería en silencio (recibiendo
      // un "no te entendí" pese a ser una instrucción clara). Preguntamos el tipo
      // —llevando la operación en los botones— antes de tocar el pedido.
      if (tipoHeladoAmbiguo) {
        await pedirDatosFaltantes(numeroCliente, faltaCantidad, faltaDireccion, faltaPago, undefined, 0, cantidadEnUnidadNoSoportada, pagoNoSoportado, tipoHeladoAmbiguo);
        console.log("🍦 Número pelado ambiguo sobre borrador completo: pregunto el tipo en vez de adivinar.");
        return;
      }

      // UNIDAD NO SOPORTADA sobre un borrador COMPLETO: el cliente quiso corregir la
      // cantidad en kilos/potes/porciones ("que sean 2 kilos" sobre 40 unidades). El
      // merge no movió nada porque ese número no es asignable, así que sin esta rama
      // cae al fallback y se lleva un "no te entendí" que no le explica NADA — y el
      // cliente cree que ya dio la cantidad. Le decimos por qué no cuenta.
      if (cantidadEnUnidadNoSoportada && pedidoCompleto && !hayCambiosReales) {
        await pedirDatosFaltantes(numeroCliente, faltaCantidad, faltaDireccion, faltaPago, undefined, 0, cantidadEnUnidadNoSoportada, pagoNoSoportado, tipoHeladoAmbiguo);
        console.log("⚖️ Cantidad en unidad no soportada sobre borrador completo: explico que vendemos por unidad.");
        return;
      }

      // PREGUNTA DE NEGOCIO PURA sobre un borrador (parcial o completo): ya la
      // respondimos/delegamos arriba y el mensaje NO cambió nada del pedido. No hay
      // que re-pedir los datos faltantes ni reenviar el resumen: sería una segunda
      // burbuja de armado pisando la respuesta a la consulta ("Para armar tu pedido
      // me falta…" justo después de "ya le pasé tu consulta a una persona"). El
      // borrador queda como estaba; cuando el cliente quiera seguir, lo retomamos.
      // (Corre antes del persist: sin cambios reales no hay nada que guardar.)
      if (respondiPreguntaNegocioEmbebida && !hayCambiosReales) {
        console.log("🤝 Pregunta de negocio pura sobre un borrador sin cambios: respondo la consulta y no re-pido datos ni reenvío el resumen.");
        return;
      }

      // Hay cambios reales, o el borrador sigue incompleto: persistimos el merge
      // (aunque quede incompleto) para no perder lo ya cargado, y después
      // decidimos si mandar el resumen o pedir lo que falta.
      if (hayCambiosReales || !pedidoCompleto) {
        // Guard atómico: entre el read de pedidoActivo y este UPDATE, el borrador
        // pudo haber pasado a cancelado (cron / operador) o a pendiente (otro
        // worker confirmó). Sin guard, pisamos con datos viejos o revivimos un
        // cancelado. Solo mutamos si sigue siendo borrador y NO fue despachado.
        const { data: updatedData } = await supabaseAdmin.from('pedidos').update({
          cantidad_agua: aguaFinal,
          cantidad_crema: cremaFinal,
          direccion: dirFinal,
          // Si el cliente cambió la dirección, ya no es la del historial: el
          // aviso "usé tu última dirección" deja de corresponder.
          ...(dirFinal !== pedidoActivo.direccion ? { direccion_de_historial: false } : {}),
          aclaracion: aclaracionFinal,
          // pedido.observaciones ya es la proyección del merge (slots sembrados
          // desde lo actual), así que NO usamos `?? pedidoActivo.observaciones`:
          // eso rompería un "limpiar" que dejó las observaciones en null a propósito.
          observaciones: pedido.observaciones,
          observaciones_detalle: pedido.observaciones_detalle,
          metodo_pago: pagoFinal,
          estado: 'borrador'
        })
          .eq('id', pedidoActivo.id)
          .eq('estado', 'borrador')
          .neq('enviado', true)
          .select('*')
          .maybeSingle();

        console.log("🔄 Borrador actualizado. Datos en DB:", updatedData);

        if (updatedData) {
          if (pedidoCompleto) {
            await enviarResumenYPedirConfirmacion(numeroCliente, updatedData, true);
          } else {
            console.log("📝 El borrador sigue incompleto tras el merge. Pido lo que falta.");
            await pedirDatosFaltantes(numeroCliente, faltaCantidad, faltaDireccion, faltaPago, undefined, 0, cantidadEnUnidadNoSoportada, pagoNoSoportado, tipoHeladoAmbiguo);
          }
        } else {
          console.log(`⚠️ Race al actualizar borrador: el pedido ${pedidoActivo.id} cambió de estado o fue despachado.`);
          await enviarMensajeWhatsApp(numeroCliente, "Algo cambió con tu pedido. Escribime de nuevo y seguimos 🙏");
        }
        return;
      }

      // Borrador completo, sin cambios y sin confirmar. Antes esto era un return
      // silencioso, pero dejaba al cliente en un callejón: si venía de "No,
      // modificar" (el bot preguntó "¿qué querés cambiar?") y respondía "nada"
      // / "así está bien" / cualquier mensaje-ruido, el LLM lo clasificaba como
      // datos_pedido sin cambios reales y el bot no contestaba nada. Reenviamos
      // el resumen con los botones para devolverlo al punto de confirmación en
      // vez de dejarlo colgado. esModificacion=false: no hubo cambios, es el
      // mismo pedido re-ofrecido.
      //
      // ESCAPE ANTI-LOOP: si ya hay una ronda de botones VIVA (el bot mandó el
      // resumen y el cliente contestó por texto sin resolverla), reenviar el mismo
      // resumen es un bucle cerrado: mismo input → mismo output, sin salida. En ese
      // caso mandamos una desambiguación con los mismos botones.
      //
      // Cuando el cliente viene de "No, modificar" (el caso legítimo de arriba) el
      // flag ya fue consumido atómicamente por ejecutarBoton y el "¿qué querés
      // cambiar?" no lleva botones, así que ahí sigue saliendo el resumen.
      //
      // (El caso "ya respondí una pregunta de negocio embebida sin cambios" se
      // ataja arriba, antes del persist — cubre borrador parcial Y completo — así
      // que acá no hace falta re-chequearlo.)
      if (pedidoActivo.esperando_respuesta_boton) {
        await enviarDesambiguacionConfirmacion(numeroCliente, pedidoActivo.id);
        console.log("🤔 Borrador completo sin cambios con ronda de botones viva: desambiguo en vez de repetir el resumen.");
        return;
      }

      await enviarResumenYPedirConfirmacion(numeroCliente, pedidoActivo, false);
      console.log("↩️ Borrador completo sin cambios: reenvío el resumen para no dejar al cliente sin respuesta.");
      return;
    }

    // 5. NO HAY BORRADOR: pedido ya en cocina (modificación) o pedido nuevo.

    // 5.a Pedido en cocina sin cambios reales: probablemente está saludando o
    //     iniciando una conversación nueva; avisamos que ya hay uno en curso.
    //     Salvo que ya hayamos contestado su pregunta de negocio este turno: ahí
    //     el aviso sería una segunda burbuja redundante sobre la respuesta.
    if (yaExisteEnCocina && !hayCambiosReales) {
      if (respondiPreguntaNegocioEmbebida) {
        console.log("🤝 Pregunta de negocio ya respondida sobre pedido en cocina sin cambios: no agrego el aviso de 'ya está en preparación'.");
        return;
      }
      console.log("ℹ️ Cliente con pedido en cocina sin cambios reales. Avisando que ya hay uno en preparación.");
      await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tu pedido ya está en preparación. ¿Querés modificar algo?");
      return;
    }

    // 5.b Falta información para tener un pedido completo.
    if (!pedidoCompleto) {
      if (yaExisteEnCocina) {
        // Un pedido en cocina ya tenía datos completos; si un merge lo dejó
        // "incompleto" es por algo puntual del mensaje. No degradamos su estado
        // ni persistimos placeholders: solo pedimos el dato que falte.
        await pedirDatosFaltantes(numeroCliente, faltaCantidad, faltaDireccion, faltaPago, undefined, 0, cantidadEnUnidadNoSoportada, pagoNoSoportado, tipoHeladoAmbiguo);
        return;
      }

      // PREGUNTA DE NEGOCIO PURA sin datos de pedido: el cliente solo consultó
      // algo (ya se lo respondimos/delegamos arriba) y NO aportó ningún dato real
      // del pedido. La dirección histórica se inyecta abajo por comodidad, pero no
      // es un dato que el cliente haya dado hoy: por sí sola no inicia un pedido.
      // Sin este corte, un cliente con dirección guardada recibía "Para armar tu
      // pedido me falta: cantidad, pago" DESPUÉS de cada consulta, como si hubiera
      // empezado a pedir. `traeDatos` mira el output CRUDO del modelo (antes de la
      // inyección histórica), así que es exactamente "¿el cliente aportó datos?".
      if (respondiPreguntaNegocioEmbebida && !traeDatos) {
        console.log("🤝 Pregunta de negocio pura sin datos de pedido: no pido datos faltantes (la dirección histórica no cuenta como pedido iniciado).");
        return;
      }

      // PEDIDO NUEVO EN ARMADO: persistimos un borrador PARCIAL en cuanto hay
      // algún dato real, así los próximos turnos mergean determinísticamente
      // contra la DB en vez de re-extraer el historial (que perdía datos: ej.
      // la cantidad de crema se caía al pasar el método de pago). Placeholder
      // '' en las columnas NOT NULL para lo que todavía no se cargó.
      //
      // La dirección inyectada de historial NO cuenta como "el cliente aportó un
      // dato": es una comodidad para cuando SÍ está pidiendo, no un pedido iniciado
      // por sí sola. Sin esto, cualquier mensaje de un cliente con dirección
      // guardada creaba un borrador parcial fantasma (solo la dirección histórica).
      const hayAlgunDato = !faltaCantidad || !faltaPago || (!faltaDireccion && !direccionInyectadaDeHistorial);
      if (hayAlgunDato) {
        const { data: parcial, error: errorParcial } = await supabaseAdmin
          .from('pedidos')
          .insert([{
            telefono: numeroCliente,
            direccion: dirFinal,
            aclaracion: aclaracionFinal,
            cantidad_agua: aguaFinal,
            cantidad_crema: cremaFinal,
            observaciones: pedido.observaciones,
            observaciones_detalle: pedido.observaciones_detalle,
            metodo_pago: pagoFinal,
            estado: 'borrador',
            direccion_de_historial: direccionInyectadaDeHistorial,
          }])
          .select('id')
          .single();

        if (errorParcial?.code === '23505') {
          // Índice único de borradores: ya hay uno que el lookup no vio.
          // Fusionamos este mensaje sobre él y seguimos el flujo con la fila
          // fusionada (que puede haber quedado completa).
          const fusionado = await fusionarEnBorradorExistente(numeroCliente, {
            direccion: dirFinal,
            aclaracion: aclaracionFinal,
            cantidad_agua: aguaFinal,
            cantidad_crema: cremaFinal,
            observaciones: pedido.observaciones,
            observaciones_detalle: pedido.observaciones_detalle,
            metodo_pago: pagoFinal,
            direccion_de_historial: direccionInyectadaDeHistorial,
          });
          if (fusionado) {
            if (esBorradorCompleto(fusionado)) {
              await enviarResumenYPedirConfirmacion(numeroCliente, fusionado, true);
              return;
            }
            await pedirDatosFaltantes(
              numeroCliente,
              !(fusionado.cantidad_agua > 0 || fusionado.cantidad_crema > 0),
              !fusionado.direccion,
              !fusionado.metodo_pago,
              undefined,
              0,
              cantidadEnUnidadNoSoportada,
              pagoNoSoportado,
              tipoHeladoAmbiguo,
            );
            return;
          }
          console.error("❌ Conflicto de borrador único pero no se pudo fusionar (¿desapareció en el medio?).");
        } else if (errorParcial) {
          console.error("❌ Error creando el borrador parcial:", errorParcial);
        } else {
          console.log(`💾 Borrador parcial creado (id ${parcial?.id}). Falta: cantidad=${faltaCantidad}, direccion=${faltaDireccion}, pago=${faltaPago}.`);
        }
      }

      // Seed determinista para variar el saludo cuando faltan los 3 datos (caso
      // típico de un mensaje off-topic/sin sentido): mensajes distintos → largo
      // distinto → variante distinta, así no se repite palabra por palabra.
      const seedSaludo = mensajesClaim.reduce((acc, m) => acc + (m.texto?.length ?? 0), 0);
      await pedirDatosFaltantes(numeroCliente, faltaCantidad, faltaDireccion, faltaPago, undefined, seedSaludo, cantidadEnUnidadNoSoportada, pagoNoSoportado, tipoHeladoAmbiguo);
      return;
    }

    // 5.c Datos completos en un solo mensaje: modificar el pedido en cocina, o
    //     crear el borrador nuevo, y mandar el resumen para confirmar.
    {
      let borradorDB = null;

      if (yaExisteEnCocina) {
        // Ventana de modificación sin humano: si el pedido lleva más de
        // PLAZO_MODIFICACION_COCINA_MIN en 'pendiente' (entro_a_cocina_at,
        // estampado por el trigger de DB), la cocina puede estar ya
        // preparándolo — un cambio de cantidad/dirección/sabor a esta altura
        // es más riesgoso que demorarlo hasta que lo vea un operador. La
        // cancelación NO pasa por este gate (sigue siempre disponible, más
        // vale frenar una preparación que no frenarla).
        const msDesdeEntradaCocina = pedidoActivo.entro_a_cocina_at
          ? Date.now() - new Date(pedidoActivo.entro_a_cocina_at).getTime()
          : null;
        if (!dentroDePlazoModificacionCocina(msDesdeEntradaCocina)) {
          console.log(`⏰ Pedido ${pedidoActivo.id} en cocina hace más de ${PLAZO_MODIFICACION_COCINA_MIN} min; no lo modifico solo. Delego a un humano.`);
          await marcarRequiereAtencion(numeroCliente);
          await enviarMensajeWhatsApp(numeroCliente, "Tu pedido ya está en preparación hace un rato y no puedo modificarlo yo solo 🍦 Le aviso a alguien del local para que te ayude con el cambio.");
          return;
        }

        console.log("🔄 El cliente quiere modificar su pedido activo. Actualizando datos...");
        // Guard atómico: pendiente → borrador es un flujo válido (cliente
        // modificando su pedido en cocina), pero entre el read y este UPDATE el
        // operador pudo haber marcado enviado=true (copió el mensaje al cadete)
        // o el estado pudo haber pasado a 'enviado'/'cancelado'. Sin guard,
        // degradaríamos un despachado a 'borrador' con enviado=true colgado.
        const { data: updateData, error: updateError } = await supabaseAdmin
          .from('pedidos')
          .update({
            cantidad_agua: aguaFinal,
            cantidad_crema: cremaFinal,
            direccion: dirFinal,
            ...(dirFinal !== pedidoActivo.direccion ? { direccion_de_historial: false } : {}),
            aclaracion: aclaracionFinal,
            observaciones: pedido.observaciones,
            observaciones_detalle: pedido.observaciones_detalle,
            metodo_pago: pagoFinal,
            estado: 'borrador'
          })
          .eq('id', pedidoActivo.id)
          .eq('estado', 'pendiente')
          .neq('enviado', true)
          .select('*')
          .maybeSingle();

        if (updateError) {
          console.error("❌ Error al actualizar en Supabase:", updateError);
        } else if (updateData) {
          borradorDB = updateData;
          console.log("💾 Pedido actualizado en DB:", borradorDB);
        } else {
          // 0 filas: el pedido ya no está en 'pendiente' o fue despachado.
          console.log(`⚠️ Race al modificar en cocina: el pedido ${pedidoActivo.id} cambió de estado o fue despachado.`);
          await enviarMensajeWhatsApp(numeroCliente, "Uy, tu pedido ya está en camino y no se puede modificar 🛵");
          return;
        }
      } else {
        const { data: insertData, error: insertError } = await supabaseAdmin
          .from('pedidos')
          .insert([{
            telefono: numeroCliente,
            direccion: dirFinal,
            aclaracion: aclaracionFinal,
            cantidad_agua: aguaFinal,
            cantidad_crema: cremaFinal,
            observaciones: pedido.observaciones,
            observaciones_detalle: pedido.observaciones_detalle,
            metodo_pago: pagoFinal,
            estado: 'borrador',
            direccion_de_historial: direccionInyectadaDeHistorial,
          }])
          .select('*')
          .single();

        if (!insertError) {
          borradorDB = insertData;
          console.log("💾 Pedido creado en DB:", borradorDB);
        } else if (insertError.code === '23505') {
          // Índice único de borradores: fusionamos sobre el existente. Como el
          // mensaje traía datos completos, la fila fusionada queda completa y
          // el resumen sale abajo como siempre.
          borradorDB = await fusionarEnBorradorExistente(numeroCliente, {
            direccion: dirFinal,
            aclaracion: aclaracionFinal,
            cantidad_agua: aguaFinal,
            cantidad_crema: cremaFinal,
            observaciones: pedido.observaciones,
            observaciones_detalle: pedido.observaciones_detalle,
            metodo_pago: pagoFinal,
            direccion_de_historial: direccionInyectadaDeHistorial,
          });
          if (!borradorDB) console.error("❌ Conflicto de borrador único pero no se pudo fusionar (¿desapareció en el medio?).");
        } else {
          console.error("❌ Error al crear el pedido en la base de datos:", insertError);
        }
      }

      if (borradorDB) {
        await enviarResumenYPedirConfirmacion(numeroCliente, borradorDB, Boolean(yaExisteEnCocina), direccionInyectadaDeHistorial);
      }
    }
  } catch (flowError) {
    // Cualquier error inesperado en la lógica de flow post-IA cae acá.
    // El error del structured output ya se maneja arriba con su propio try/catch.
    console.error("❌ Error en el flow post-IA:", flowError instanceof Error ? flowError.stack : flowError);
    // En modo test propagamos para que /api/dev/simular-conversacion devuelva
    // { ok:false, error } y el harness lo marque como fallo. En prod seguimos
    // tragándolo (no queremos tumbar el worker), pero ahora con stack completo.
    if (process.env.BOT_TEST_MODE === '1') throw flowError;
  }
}

import { generateObject } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { Database, Json } from '@/types/supabase';
import { enviarMensajeWhatsApp, enviarResumenYPedirConfirmacion, enviarConfirmacionCancelacion } from '@/lib/whatsapp';
import { atencionHumanaActiva } from '@/lib/bot/atencion-humana';

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const groq = createGroq();

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
  'saludo',
  'modificar_sin_datos',
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
type PedidoIA = z.infer<typeof PedidoIASchema> & {
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
    // El short-circuit (saludo/confirmar/cancelar) nunca modifica sabores:
    // todas las operaciones son "mantener" y arrastramos lo que ya había.
    obs_agua: null, obs_agua_operacion: 'mantener',
    obs_crema: null, obs_crema_operacion: 'mantener',
    obs_general: null, obs_general_operacion: 'mantener',
    observaciones: pedidoActivo?.observaciones ?? null,
    observaciones_detalle: leerSlots(pedidoActivo),
    metodo_pago: null,
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
    case 'sumar':       return Math.max(0, actual + valor);
    case 'restar':      return Math.max(0, actual - valor);
    case 'reemplazar':  return Math.max(0, valor);
    case 'mantener':    return actual;
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
    case 'mantener':    return actual;
    case 'reemplazar':  return texto ?? actual; // defensivo: reemplazar sin texto = no tocar
    case 'agregar':
      if (!texto) return actual;
      if (!actual) return texto;
      return `${actual}, ${texto}`;
  }
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
    case 'mantener':    return actual;
    case 'limpiar':     return null;
    case 'reemplazar':  return texto ?? actual; // defensivo: reemplazar sin texto = no tocar
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
};

/**
 * Construye el SYSTEM_PROMPT que se le pasa a Groq, dependiendo de si hay
 * un pedido activo y en qué estado está. Exportado para que el endpoint de
 * dev pueda reproducir el mismo contexto que el flujo real.
 */
export function buildSystemPrompt(pedidoActivo: PedidoActivoContext | null): string {
  const pedidoEnviado = Boolean(
    pedidoActivo && (pedidoActivo.estado === 'enviado' || pedidoActivo.enviado === true)
  );
  const tieneBorrador = pedidoActivo && pedidoActivo.estado === 'borrador';
  const yaExisteEnCocina = pedidoActivo && pedidoActivo.estado === 'pendiente' && !pedidoEnviado;
  const esperandoCancelacion = pedidoActivo && pedidoActivo.estado === 'esperando_cancelacion';

  if (pedidoActivo && (tieneBorrador || yaExisteEnCocina || esperandoCancelacion)) {
    const intencionesValidas = esperandoCancelacion
      ? `"confirmar_cancelacion", "rechazar_cancelacion", "saludo", "datos_pedido"`
      : `"cancelar", "confirmar", "saludo", "modificar_sin_datos", "datos_pedido"`;

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
      - "rechazar_cancelacion": el cliente se arrepiente y NO quiere cancelar (ej: "no", "no, pará", "me equivoqué", "dejalo así").
      - "saludo": el mensaje es ÚNICAMENTE un saludo, sin pista sobre la cancelación.
      - "datos_pedido": cualquier otra cosa.
      ` : `
      - "cancelar": el cliente pide explícitamente cancelar, anular, dar de baja, o dice "ya no quiero el pedido" / "fue mentira".
      - "confirmar": ${tieneBorrador ? `el cliente acepta el resumen (ej: "sí", "dale", "está bien", "confirmo").` : `NO APLICA en este estado (el pedido no está en borrador).`}
      - "saludo": el mensaje es ÚNICAMENTE un saludo, sin datos del pedido.
      - "modificar_sin_datos": el cliente quiere cambiar el pedido pero NO aporta NINGÚN dato concreto (ej: "quiero cambiar algo", "modificar"). Si menciona sabores, cantidades, dirección o pago, NO uses esta opción — usá "datos_pedido".
      - "datos_pedido": el cliente trae info concreta del pedido (cantidades, sabores, dirección, pago), incluso para modificar uno existente. Default cuando no aplique ninguna otra.
      `}

      2. REGLAS DE ACTUALIZACIÓN DE DATOS (Combina el mensaje actual con los datos de arriba):
      - "direccion": ÚNICAMENTE nombre de calle y número (Ej: "Mitre 951"). Si el cliente solo menciona un departamento (ej: "depto 6"), un conjunto o una torre, PERO NO menciona la calle, mantén la dirección actual: "${pedidoActivo.direccion}".
      - "aclaracion" + "aclaracion_operacion": Detalles extra de la ubicación (departamento, piso, torre, conjunto, color de casa). Ej: "depto 6 del conjunto violeta", "la casa de 2 pisos", "donde el tacho gris", "con el porton verde". NO fusiones vos el texto: solo extraé el dato de ESTE mensaje y elegí la operación; el sistema combina con lo actual (${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'}).
        * "agregar": el cliente suma un detalle NUEVO que no contradice lo actual. Devolvé SOLO el detalle nuevo en "aclaracion" (el sistema lo concatena con coma). Ej: actual "la casa es verde" + mensaje "con marco naranja" → aclaracion="con marco naranja", aclaracion_operacion="agregar". Otro: actual "depto 6" + mensaje "piso 3" → aclaracion="piso 3", aclaracion_operacion="agregar".
        * "reemplazar": el cliente CONTRADICE un detalle puntual del actual. Acá SÍ devolvé el texto ya corregido COMPLETO en "aclaracion". Ej: actual "casa marron, de 2 pisos" + mensaje "no, es verde" → aclaracion="casa verde, de 2 pisos", aclaracion_operacion="reemplazar".
        * "mantener": el cliente no menciona ninguna aclaración en este mensaje. aclaracion=null, aclaracion_operacion="mantener".
      - "metodo_pago": Si no menciona un cambio explícito, mantén el actual: "${pedidoActivo.metodo_pago}".
      - SABORES (campos "obs_agua" / "obs_crema" / "obs_general" + sus "_operacion"): NO armes el texto final ni pongas el prefijo "los de agua/crema"; extraé solo los sabores de ESTE mensaje en su slot y elegí la operación, TS combina y reconstruye. "de agua"/"de crema" es el TIPO, NO un sabor.
        * Slot: "obs_agua"/"obs_crema" = sabores que el cliente atribuye a ese tipo, sin prefijo (ej. "10 de frutilla y 5 de menta"). "obs_general" = detalles sin tipo ("sin coco") o sabores sin tipo declarado ("de dulce de leche").
        * Operación (igual que aclaracion, + "limpiar"): "reemplazar" si DEFINE los sabores de ese tipo ("los de agua que sean X"); "agregar" si suma un sabor (devolvé solo el nuevo); "mantener" si no menciona ese tipo (texto null); "limpiar" si pide sacarlos. Conservá desgloses numéricos tal cual; NUNCA inventes sabores.
        * Si solo dice tipo+cantidad sin sabor ("10 de crema", "50 helados"), TODOS los slots = "mantener".
        * Ej: actual agua="de vainilla", crema="de chocolate" + "los de agua que sean 10 de frutilla y 30 de chocolate" → obs_agua="10 de frutilla y 30 de chocolate"/reemplazar, obs_crema=null/mantener (crema intacto). "sin coco" → obs_general="sin coco"/agregar, resto mantener.
      - "cantidad_agua" / "cantidad_crema" + sus "_operacion": NO hagas matemática, extraé el valor literal y la operación; TS calcula sobre el actual. ÚNICA suma permitida: si dan un desglose por sabores de UN tipo, sumalo ("los de agua 20 de X y 40 de Y" → 60).
        * "sumar": agrega al actual. Pistas: "más", "sumá", "agregá", "otro/s". Ej: "sumale 50", "5 más de agua", "que sean 25 más" (con "más" = delta 25, NO total).
        * "restar": quita. Pistas: "menos", "quitá", "sacá". Ej: "quitale 3", "5 menos de crema".
        * "reemplazar": valor FIJO, SIN "más"/"menos". Ej: "que sean 50", "cambialo a 20", "ahora 30 de crema". También el desglose ya sumado ("que los de agua sean 20 de frutilla y 40 de menta" → 60).
        * "mantener": no menciona ese tipo en el mensaje. Valor = 0.
        Contraste clave (cada tipo es independiente): "25 más de agua" = sumar 25 | "25 de agua" = reemplazar 25 | "5 menos de crema" = restar 5.

      IMPORTANTE: Devolvé TODOS los campos del schema. "intencion" es una sola opción del enum, no un booleano.
    `;
  }

  return `
    ACTÚA COMO UNA API DE EXTRACCIÓN DE DATOS. NO ERES UN ASISTENTE CONVERSACIONAL. NO SALUDES, NO EXPLIQUES NADA.

    CONTEXTO: El cliente no tiene pedidos activos. Extrae una nueva orden desde cero.

    1. INTENCIÓN DEL MENSAJE (campo "intencion", elegí UNA opción):
    Valores válidos en este contexto: "cancelar", "saludo", "datos_pedido".
    - "cancelar": el cliente pide explícitamente cancelar/anular un pedido (puede estar refiriéndose a uno ya despachado, aunque no haya pedido activo).
    - "saludo": el mensaje es ÚNICAMENTE un saludo (ej: "hola", "buenas"), sin datos del pedido.
    - "datos_pedido": el cliente trae info del pedido (cantidades, sabores, dirección, pago). Default cuando no aplique otra.

    2. REGLAS DE EXTRACCIÓN:
    - "direccion": ÚNICAMENTE nombre de calle y número (Ej: "Mitre 951"). Si el cliente solo menciona un departamento (ej: "depto 6"), un conjunto o una torre, PERO NO menciona la calle, pon null porque no es una dirección válida, eso corresponde a la aclaracion. Si NO menciona direccion ni retiro, pon null.
    - "aclaracion": Detalles extra de la dirección física (color de la casa, pisos, entre calles, timbre, departamento). Ejemplos: "la casa rosada de 2 pisos", "timbre 2B", "donde el porton gris" y asi. Si no se especifica, pon null.
    - "aclaracion_operacion": SIEMPRE "reemplazar" en este contexto (es un pedido nuevo desde cero, no hay aclaración previa que combinar).
    - "cantidad_agua" y "cantidad_crema": Cantidad en números, por defecto 0. Si el cliente da un desglose por sabores dentro de UN tipo (ej. "10 helados de agua: 4 de frutilla y 6 de menta"), SUMÁ esos números y devolvé el total (10).
    - "cantidad_agua_operacion" y "cantidad_crema_operacion": SIEMPRE "reemplazar" en este contexto (es un pedido nuevo desde cero, no hay valor previo que sumar/restar/mantener).
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

export async function procesarMensajesDeCliente(numeroCliente: string) {
  // 0.bis TOMA HUMANA (defensa): el webhook ya no agenda wake-ups durante una
  //    toma humana, pero pudo quedar uno agendado de antes de iniciarla. Si la
  //    toma está activa, reclamamos los pendientes (procesado=true) para que no
  //    queden colgados ni disparen wake-ups futuros, pero NO respondemos.
  if (await atencionHumanaActiva(numeroCliente)) {
    await supabaseAdmin
      .from('mensajes_chat')
      .update({ procesado: true })
      .eq('telefono', numeroCliente)
      .eq('rol', 'cliente')
      .eq('procesado', false);
    console.log(`🙋 Toma humana activa para ${numeroCliente}. El bot no responde.`);
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
    .select('id, texto, created_at');

  if (claimError) {
    console.error(`❌ Error al hacer claim de mensajes para ${numeroCliente}:`, claimError);
    return;
  }

  if (!mensajesClaim || mensajesClaim.length === 0) {
    console.log(`⏭️ Sin mensajes pendientes para ${numeroCliente}. Otro worker probablemente ya los procesó.`);
    return;
  }

  console.log(`📦 Claimed ${mensajesClaim.length} mensaje(s) nuevo(s) para ${numeroCliente}.`);

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
  let ultimoPedidoEnviado: { id: number; estado: string; created_at: string } | null = null;
  if (!pedidoActivo) {
    const { data: ultimoPedido } = await supabaseAdmin
      .from('pedidos')
      .select('id, estado, created_at')
      .eq('telefono', numeroCliente)
      .gte('created_at', hace12Horas)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ultimoPedido?.estado === 'enviado') {
      ultimoPedidoEnviado = ultimoPedido;
      console.log(`📦 El último pedido del cliente (id ${ultimoPedido.id}) está en estado enviado. Lo uso para respuestas contextuales.`);
    } else if (ultimoPedido) {
      console.log(`📦 El último pedido del cliente (id ${ultimoPedido.id}) está en estado ${ultimoPedido.estado}; no aplica respuesta contextual de despacho.`);
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
    const { data: ultimoBot } = await supabaseAdmin
      .from('mensajes_chat')
      .select('texto, created_at, rol')
      .eq('telefono', numeroCliente)
      .in('rol', ['bot', 'operador'])
      .eq('descartado', false)
      .lt('created_at', primerNuevo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    mensajesParaIA = ultimoBot ? [ultimoBot, ...nuevosCliente] : nuevosCliente;
    console.log(`📚 Hay pedidoActivo (${pedidoActivo.estado}): pasamos ${nuevosCliente.length} mensaje(s) nuevo(s)${ultimoBot ? ' + último turno del bot' : ''}.`);
  } else {
    const hace15Minutos = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: historial } = await supabaseAdmin
      .from('mensajes_chat')
      .select('texto, created_at, rol')
      .eq('telefono', numeroCliente)
      .eq('descartado', false) // ignoramos mensajes de conversaciones ya cerradas
      .gte('created_at', hace15Minutos)
      .order('created_at', { ascending: true })
      .limit(15);

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

  const pedidoEnviado = Boolean(
    pedidoActivo && (pedidoActivo.estado === 'enviado' || pedidoActivo.enviado === true)
  );

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

  const SYSTEM_PROMPT = buildSystemPrompt(pedidoActivo);

  // 5. LLAMADA A GROQ con structured output validado por Zod.
  //    El AI SDK marca `json_validate_failed` como no-retryable (es un 400),
  //    pero en la práctica son errores por non-determinismo del modelo (ej:
  //    devuelve "false" string en vez de false boolean). Reintentamos a mano.
  const MAX_ATTEMPTS = 3;
  let pedido: PedidoIA | null = null;
  let lastError: unknown = null;

  // 4b. SHORT-CIRCUIT: si el batch es un único mensaje inequívoco dado el
  //     estado del pedido (ej. "sí" en esperando_cancelacion, "hola" con
  //     pedido en cocina), salteamos el LLM. Reduce latencia, costo y
  //     errores del modelo en los casos triviales.
  if (mensajesClaim.length === 1) {
    const intento = intentarShortCircuit(
      mensajesClaim[0].texto ?? '',
      pedidoActivo?.estado ?? null,
    );
    if (intento) {
      pedido = pedidoDesdeShortCircuit(intento, pedidoActivo);
      console.log(`⚡ Short-circuit (sin LLM): tipo=${intento}, mensaje="${mensajesClaim[0].texto}"`);
    }
  }

  for (let attempt = 1; pedido === null && attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { object } = await generateObject({
        model: groq('openai/gpt-oss-20b'),
        system: SYSTEM_PROMPT,
        prompt: `Conversación reciente (el último turno del bot da contexto al mensaje del cliente):\n${historialParaIA}`,
        schema: PedidoIASchema,
        temperature: 0,
      });

      // Aplicamos las operaciones de cantidad de forma determinista en TS.
      // El modelo solo identificó la intención (sumar/restar/reemplazar/mantener)
      // y el valor literal del mensaje; nosotros hacemos la cuenta sobre el
      // estado actual del pedido (o sobre 0 si no hay pedidoActivo).
      const cantidadAguaActual = pedidoActivo?.cantidad_agua ?? 0;
      const cantidadCremaActual = pedidoActivo?.cantidad_crema ?? 0;

      const cantidadAguaFinal = aplicarOperacionCantidad(
        object.cantidad_agua_operacion,
        object.cantidad_agua,
        cantidadAguaActual,
      );
      const cantidadCremaFinal = aplicarOperacionCantidad(
        object.cantidad_crema_operacion,
        object.cantidad_crema,
        cantidadCremaActual,
      );

      console.log(`🧮 Cantidades: agua ${cantidadAguaActual} -> ${cantidadAguaFinal} (op: ${object.cantidad_agua_operacion}, valor: ${object.cantidad_agua}), crema ${cantidadCremaActual} -> ${cantidadCremaFinal} (op: ${object.cantidad_crema_operacion}, valor: ${object.cantidad_crema})`);

      // Misma filosofía que las cantidades: el modelo extrajo el texto literal
      // + la operación; la fusión la hace TS de forma determinista.
      const aclaracionActual = pedidoActivo?.aclaracion ?? null;
      const aclaracionFinal = aplicarOperacionAclaracion(
        object.aclaracion_operacion,
        object.aclaracion,
        aclaracionActual,
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

      pedido = {
        ...object,
        cantidad_agua: cantidadAguaFinal,
        cantidad_crema: cantidadCremaFinal,
        aclaracion: aclaracionFinal,
        observaciones: observacionesFinal,
        observaciones_detalle: slotsFinales,
        datos_completos: Boolean(
          object.direccion && object.metodo_pago && (cantidadAguaFinal > 0 || cantidadCremaFinal > 0)
        ),
      };

      console.log(`✅ Objeto IA extraído (intento ${attempt}/${MAX_ATTEMPTS}):`, pedido);
      break;
    } catch (iaError) {
      lastError = iaError;
      console.warn(`⚠️ Intento ${attempt}/${MAX_ATTEMPTS} falló:`, iaError instanceof Error ? iaError.message : iaError);
    }
  }

  if (!pedido) {
    console.error("❌ Falló la extracción structured tras todos los reintentos:", lastError);
    await enviarMensajeWhatsApp(numeroCliente, "Disculpá, no te entendí. ¿Lo repetís? 🙏");
    return;
  }

  try {

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

    // 1. PRIORIDAD ABSOLUTA: CANCELACIÓN
    //
    // Todos los UPDATE de estos flujos van con guard atómico:
    //   .neq('estado', 'enviado').neq('enviado', true)
    // Esto evita una race condition: entre que leímos pedidoActivo y ahora,
    // el repartidor pudo haber tocado "Marcar como enviado". Si el UPDATE
    // afecta 0 filas, sabemos que se envió en la ventana y le avisamos al cliente.
    if (pedidoActivo && pedidoActivo.estado === 'esperando_cancelacion') {
      if (pedido.intencion === 'confirmar_cancelacion') {
        const { data: cancelados } = await supabaseAdmin
          .from('pedidos')
          .update({ estado: 'cancelado' })
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
          await enviarResumenYPedirConfirmacion(numeroCliente, rechazados, false);
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
        console.log(`ℹ️ Cliente intentó cancelar pero el pedido ${ultimoPedidoEnviado.id} ya está enviado.`);
        // La conversación sobre ese pedido se cerró. Descartamos el historial
        // para que próximos mensajes no se mezclen con este intento.
        await marcarHistorialDescartado(numeroCliente);
      } else {
        await enviarMensajeWhatsApp(numeroCliente, "No tenés pedido activo para cancelar. Si querés hacer uno, mandame los datos 🍦");
        console.log(`ℹ️ Cliente pidió cancelar pero no tiene pedidos recientes.`);
      }
      return;
    }

    // 2. SALUDO
    if (pedido.intencion === 'saludo') {
      if (yaExisteEnCocina) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tu pedido ya está en preparación. ¿Querés modificar algo?");
      } else if (tieneBorrador) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tenés un pedido en pausa esperando confirmación. ¿Está bien? Respondé *SÍ* o *NO*");
      } else if (esperandoCancelacion) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tu pedido está por cancelarse. ¿Confirmás? *SÍ* o *NO*");
      } else if (ultimoPedidoEnviado) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tu pedido ya está en camino 🛵 ¿Hacés otro?");
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

    // 4. CONFIRMACIÓN (Solo si está en borrador)
    if (tieneBorrador) {
      if (pedido.intencion === 'confirmar' && !hayCambiosReales) {
        const { data: finalData } = await supabaseAdmin.from('pedidos').update({ estado: 'pendiente' }).eq('id', pedidoActivo.id).select('*').single();
        if (finalData) {
          await enviarMensajeWhatsApp(numeroCliente, `¡Confirmado! Va a la cocina 🍦 ¡Gracias!`);
          console.log("✅ Pedido borrador confirmado por el cliente. Enviado a cocina.");
          // Cierre de la fase de armado: descartamos los mensajes del historial
          // para que futuras modificaciones no vean "quiero 10 de crema" etc.
          await marcarHistorialDescartado(numeroCliente);
        }
      } else if (hayCambiosReales) {
        const { data: updatedData } = await supabaseAdmin.from('pedidos').update({
          cantidad_agua: pedido.cantidad_agua ?? pedidoActivo.cantidad_agua,
          cantidad_crema: pedido.cantidad_crema ?? pedidoActivo.cantidad_crema,
          direccion: pedido.direccion ?? pedidoActivo.direccion,
          aclaracion: pedido.aclaracion ?? pedidoActivo.aclaracion,
          // pedido.observaciones ya es la proyección del merge (slots sembrados
          // desde lo actual), así que NO usamos `?? pedidoActivo.observaciones`:
          // eso rompería un "limpiar" que dejó las observaciones en null a propósito.
          observaciones: pedido.observaciones,
          observaciones_detalle: pedido.observaciones_detalle,
          metodo_pago: pedido.metodo_pago ?? pedidoActivo.metodo_pago,
          estado: 'borrador'
        }).eq('id', pedidoActivo.id).select('*').single();

        console.log("🔄 Pedido en borrador modificado por el cliente. Datos actualizados en DB:", updatedData);

        if (updatedData) await enviarResumenYPedirConfirmacion(numeroCliente, updatedData, true);
      }
    }
    // 5. FLUJO NORMAL: pedido nuevo o pedido en cocina
    else {
      if (pedido.datos_completos === false) {
        const datosFaltantes: string[] = [];

        if ((pedido.cantidad_agua === 0 || !pedido.cantidad_agua) && (pedido.cantidad_crema === 0 || !pedido.cantidad_crema)) {
          datosFaltantes.push("Cantidad y sabores");
        }
        if (!pedido.direccion) {
          datosFaltantes.push("Dirección de envío (o si pasás a retirar)");
        }
        if (!pedido.metodo_pago) {
          datosFaltantes.push("Forma de pago (efectivo o transferencia)");
        }

        console.log("⚠️ Datos faltantes detectados:", datosFaltantes);

        const encabezado = datosFaltantes.length === 3
          ? "¡Hola! 👋 ¿Qué te gustaría pedir? Mandame:"
          : "Para armar tu pedido me falta:";
        const mensajeRespuesta = [encabezado, ...datosFaltantes.map(d => `• ${d}`)].join('\n');

        await enviarMensajeWhatsApp(numeroCliente, mensajeRespuesta);
      }
      else if (pedido.datos_completos === true) {
        // `datos_completos === true` ya garantiza direccion y metodo_pago no nulos,
        // pero TS no lo infiere del Boolean(...). Asertamos no-null acá.
        const direccion = pedido.direccion!;
        const metodoPago = pedido.metodo_pago!;

        // Si el cliente tiene pedido en cocina pero no hay cambios reales,
        // probablemente está saludando o iniciando una conversación nueva
        // (ej: "hola, quiero hacer un pedido"). El modelo "extrajo" datos
        // completos solo porque el prompt le dice que mantenga los valores
        // actuales; no hay intención real de modificar nada.
        if (yaExisteEnCocina && !hayCambiosReales) {
          console.log("ℹ️ Cliente con pedido en cocina sin cambios reales. Avisando que ya hay uno en preparación.");
          await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tu pedido ya está en preparación. ¿Querés modificar algo?");
          return;
        }

        let borradorDB = null;

        if (yaExisteEnCocina) {
          console.log("🔄 El cliente quiere modificar su pedido activo. Actualizando datos...");
          const { data: updateData, error: updateError } = await supabaseAdmin
            .from('pedidos')
            .update({
              cantidad_agua: pedido.cantidad_agua,
              cantidad_crema: pedido.cantidad_crema,
              direccion: direccion,
              aclaracion: pedido.aclaracion,
              observaciones: pedido.observaciones,
              observaciones_detalle: pedido.observaciones_detalle,
              metodo_pago: metodoPago,
              estado: 'borrador'
            })
            .eq('id', pedidoActivo.id)
            .select('*')
            .single();

          if (!updateError) {
            borradorDB = updateData;
            console.log("💾 Pedido actualizado en DB:", borradorDB);
          } else {
            console.error("❌ Error al actualizar en Supabase:", updateError);
          }
        } else {
          const { data: insertData, error: insertError } = await supabaseAdmin
            .from('pedidos')
            .insert([{
              telefono: numeroCliente,
              direccion: direccion,
              aclaracion: pedido.aclaracion,
              cantidad_agua: pedido.cantidad_agua,
              cantidad_crema: pedido.cantidad_crema,
              observaciones: pedido.observaciones,
              observaciones_detalle: pedido.observaciones_detalle,
              metodo_pago: metodoPago,
              estado: 'borrador'
            }])
            .select('*')
            .single();

          if (!insertError) {
            borradorDB = insertData;
            console.log("💾 Pedido creado en DB:", borradorDB);
          } else {
            console.error("❌ Error al crear el pedido en la base de datos:", insertError);
          }
        }

        if (borradorDB) {
          await enviarResumenYPedirConfirmacion(numeroCliente, borradorDB, Boolean(yaExisteEnCocina), direccionInyectadaDeHistorial);
        }
      }
    }
  } catch (flowError) {
    // Cualquier error inesperado en la lógica de flow post-IA cae acá.
    // El error del structured output ya se maneja arriba con su propio try/catch.
    console.error("❌ Error en el flow post-IA:", flowError);
  }
}

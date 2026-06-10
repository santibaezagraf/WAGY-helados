import { generateObject } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { enviarMensajeWhatsApp, enviarResumenYPedirConfirmacion } from '@/lib/whatsapp';

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const groq = createGroq();

/**
 * Schema de la respuesta del modelo. Validado por Zod, retry automático del SDK
 * si el modelo no respeta el shape. Reemplaza al parsing manual con indexOf+JSON.parse.
 *
 * `datos_completos` NO está acá porque lo calculamos nosotros después
 * (no es algo que el modelo deba decidir).
 */
export const PedidoIASchema = z.object({
  direccion: z.string().nullable().describe('Calle y número únicamente (ej: "Mitre 951"). null si no se mencionó o si solo dieron aclaración. La palabra "retira" si pasan a retirar.'),
  aclaracion: z.string().nullable().describe('Detalles extra de la ubicación (depto, piso, color de casa, etc.). null si no aplica.'),
  cantidad_agua: z.number().describe('Valor literal mencionado en el mensaje para agua (no calcules sumas/restas, solo extrae el numero literal). 0 si no se mencionó.'),
  cantidad_agua_operacion: z.enum(['sumar', 'restar', 'reemplazar', 'mantener']).describe('Que hacer con cantidad_agua: "sumar" si el cliente pide agregar al actual ("sumale 5", "agrega 10"), "restar" si pide quitar ("quitale 3", "sacale 2"), "reemplazar" si pide un valor fijo ("que sean 20", "cambialo a 50") o si es un pedido nuevo desde cero, "mantener" si no se menciona agua en el mensaje.'),
  cantidad_crema: z.number().describe('Valor literal mencionado en el mensaje para crema (no calcules sumas/restas). 0 si no se mencionó.'),
  cantidad_crema_operacion: z.enum(['sumar', 'restar', 'reemplazar', 'mantener']).describe('Que hacer con cantidad_crema. Mismas reglas que cantidad_agua_operacion.'),
  observaciones: z.string().nullable().describe('Sabores o detalles de preparación textuales. null si no se mencionó.'),
  metodo_pago: z.string().nullable().describe('"efectivo", "transferencia" o null.'),
  es_cancelacion: z.boolean().describe('El cliente pide cancelar/anular el pedido.'),
  es_confirmacion: z.boolean().describe('El cliente confirma los datos del resumen.'),
  es_confirmacion_cancelacion: z.boolean().describe('El cliente confirma que SÍ quiere cancelar (cuando estado=esperando_cancelacion).'),
  es_rechazo_cancelacion: z.boolean().describe('El cliente se arrepiente y NO quiere cancelar (cuando estado=esperando_cancelacion).'),
  es_modificacion_sin_datos: z.boolean().describe('El cliente quiere modificar pero no aporta NINGÚN dato nuevo.'),
  es_saludo: z.boolean().describe('El mensaje es únicamente un saludo, sin datos.'),
});

type PedidoIA = z.infer<typeof PedidoIASchema> & { datos_completos: boolean };

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
    return `
      ACTÚA COMO UNA API DE EXTRACCIÓN Y MODIFICACIÓN DE DATOS. NO ERES UN ASISTENTE CONVERSACIONAL. NO SALUDES, NO EXPLIQUES NADA.

      CONTEXTO: El cliente tiene un pedido activo en el sistema con el estado "${pedidoActivo.estado}". Tu objetivo es devolver el objeto JSON final con los datos combinados y actualizados.

      DATOS ACTUALES DEL PEDIDO EN LA BASE DE DATOS:
      - cantidad_crema: ${pedidoActivo.cantidad_crema}
      - cantidad_agua: ${pedidoActivo.cantidad_agua}
      - direccion: "${pedidoActivo.direccion}"
      - aclaracion: ${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'}
      - observaciones: ${pedidoActivo.observaciones ? `"${pedidoActivo.observaciones}"` : 'null'}
      - metodo_pago: "${pedidoActivo.metodo_pago}"

      1. DETECCIÓN DE INTENCIONES (Obligatorio):
      ${esperandoCancelacion ? `
      * EL PEDIDO ESTÁ EN PROCESO DE CANCELACIÓN *. El bot le preguntó al cliente si estaba seguro de cancelar. Analiza su respuesta:
      - "es_confirmacion_cancelacion": true SI Y SOLO SI el cliente confirma que SÍ quiere cancelar (ej: "sí", "dale", "borralo", "por favor", "exacto", "sí, cancelar").
      - "es_rechazo_cancelacion": true SI Y SOLO SI el cliente se arrepiente y dice que NO quiere cancelar (ej: "no", "no, pará", "me equivoqué", "dejalo así", "no lo canceles").
      - "es_cancelacion": false
      - "es_confirmacion": false
      ` : `
      - "es_cancelacion": true SI Y SOLO SI el cliente pide explícitamente cancelar, anular, dar de baja o dice que "ya no quiere el pedido" o "fue mentira".
      - "es_confirmacion": true SI Y SOLO SI el contexto actual es "borrador" y el cliente acepta los datos expuestos (ej: "sí", "dale", "está bien").
      - "es_confirmacion_cancelacion": false
      - "es_rechazo_cancelacion": false
      `}
      - "es_saludo": true si el mensaje es únicamente un saludo (ej: "hola") sin datos.
      - "es_modificacion_sin_datos": true si el cliente quiere cambiar algo PERO NO aporta NINGÚN dato. ¡IMPORTANTE!: Si el cliente menciona sabores, gustos (ej: "que sean de chocolate", "sin dulce de leche"), cantidades o direcciones, esto DEBE SER FALSE porque SÍ está aportando datos válidos para modificar.

      2. REGLAS DE ACTUALIZACIÓN DE DATOS (Combina el mensaje actual con los datos de arriba):
      - "direccion": ÚNICAMENTE nombre de calle y número (Ej: "Mitre 951"). Si el cliente solo menciona un departamento (ej: "depto 6"), un conjunto o una torre, PERO NO menciona la calle, mantén la dirección actual: "${pedidoActivo.direccion}".
      - "aclaracion": Detalles extra de la ubicación (departamento, piso, torre, conjunto, color de casa). Ej: "depto 6 del conjunto violeta", "la casa de 2 pisos", "donde el tacho gris", "con el porton verde".
        * MERGE INTELIGENTE: Si el cliente AGREGA un detalle nuevo que NO contradice el actual, CONCATENA ambos separados por coma. Ej: actual "la casa es verde" + mensaje "con marco naranja" → "la casa es verde, con marco naranja". Otro ej: actual "depto 6" + mensaje "piso 3" → "depto 6, piso 3".
        * Si el cliente CONTRADICE un detalle puntual del actual (ej: actual "casa marron, de 2 pisos" + mensaje "no, es verde"), REEMPLAZA solo la parte contradicha y conservá el resto → "casa verde, de 2 pisos".
        * Si el cliente no menciona aclaración alguna en este mensaje, mantén lo actual: ${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'}.
      - "metodo_pago": Si no menciona un cambio explícito, mantén el actual: "${pedidoActivo.metodo_pago}".
      - "observaciones": ¡ATENCIÓN AQUÍ! Este campo guarda GUSTOS, SABORES o DETALLES DE PREPARACIÓN. Si el cliente menciona qué sabores quiere o no quiere (ej: "los de crema de chocolate y los de agua sin frutilla"), extrae esa instrucción textualmente. Si simplemente menciona "de crema" o "de agua", o parecidos, no guardar aqui, ya que se refiere unicamente al tipo de helado, y no a sabores en si. NUNCA INVENTES sabores u observaciones que el cliente no haya dicho textualmente.
        * MERGE INTELIGENTE: Si el cliente AGREGA sabores/detalles que NO contradicen los actuales, CONCATENA con coma. Ej: actual "los de crema de chocolate" + mensaje "y los de agua de frutilla" → "los de crema de chocolate, los de agua de frutilla".
        * Si el cliente CONTRADICE (ej: actual "de chocolate" + mensaje "no, mejor de vainilla"), REEMPLAZA solo la parte contradicha y conservá el resto.
        * Si no menciona ningún sabor en este mensaje, mantén el valor actual de forma obligatoria: ${pedidoActivo.observaciones ? `"${pedidoActivo.observaciones}"` : 'null'}.
      - "cantidad_agua" / "cantidad_crema" y sus "_operacion": ¡NO HAGAS LA MATEMÁTICA! Solo identificá la intención y el valor literal del mensaje. Yo (el código) hago la cuenta sobre el valor actual.
        * "sumar": cliente pide AGREGAR al actual. Pistas: presencia de "más", "sumar", "agregar", "extra", "otro/s". Ej:
          - "sumale 50", "agregá 20", "y 5 más de agua", "5 más", "otros 10"
          - "que sean 25 más" (la palabra "más" indica delta, NO total) → operacion="sumar", valor=25
          El valor devuelto es el delta literal.
        * "restar": cliente pide QUITAR. Pistas: "menos", "quitar", "sacar", "restar". Ej:
          - "quitale 3", "sacale 2 de agua", "5 menos de crema", "menos 5"
          Valor = literal a restar.
        * "reemplazar": cliente pide un VALOR FIJO (SIN palabras como "más" o "menos"). Ej:
          - "que sean 50" (sin "más" ni "menos") → operacion="reemplazar", valor=50
          - "cambialo a 20", "ahora 30 de crema", "que sea 100"
          Valor = nuevo total literal.
        * "mantener": el cliente NO menciona ese tipo de helado en este mensaje. Valor = 0 (será ignorado).
        Ejemplos contrastivos importantes:
        - "que sean 25 más de agua" → cantidad_agua: 25, cantidad_agua_operacion: "sumar" (porque dijo "más")
        - "que sean 25 de agua" → cantidad_agua: 25, cantidad_agua_operacion: "reemplazar" (sin "más" ni "menos")
        - "que sean 5 menos de crema" → cantidad_crema: 5, cantidad_crema_operacion: "restar"
        - "quitale 2 de crema y sumale 10 de agua" → cantidad_crema: 2, cantidad_crema_operacion: "restar", cantidad_agua: 10, cantidad_agua_operacion: "sumar"
        - "sumale 5 de agua" → cantidad_agua: 5, cantidad_agua_operacion: "sumar", cantidad_crema: 0, cantidad_crema_operacion: "mantener"

      IMPORTANTE: Devolvé TODOS los campos del schema, incluso los que sean false o null. No omitas ninguno. Los campos que empiezan con "es_" (es_cancelacion, es_confirmacion, es_confirmacion_cancelacion, es_rechazo_cancelacion, es_modificacion_sin_datos, es_saludo) deben ser BOOLEANOS REALES (true o false sin comillas), NUNCA strings.
    `;
  }

  return `
    ACTÚA COMO UNA API DE EXTRACCIÓN DE DATOS. NO ERES UN ASISTENTE CONVERSACIONAL. NO SALUDES, NO EXPLIQUES NADA.

    CONTEXTO: El cliente no tiene pedidos activos. Extrae una nueva orden desde cero.

    1. DETECCIÓN DE INTENCIONES:
    - "es_cancelacion": false
    - "es_confirmacion": false
    - "es_confirmacion_cancelacion": false
    - "es_rechazo_cancelacion": false
    - "es_modificacion_sin_datos": false
    - "es_saludo": true si es 'UNICAMENTE un saludo, no aporta mas datos.

    2. REGLAS DE EXTRACCIÓN:
    - "direccion": ÚNICAMENTE nombre de calle y número (Ej: "Mitre 951"). Si el cliente solo menciona un departamento (ej: "depto 6"), un conjunto o una torre, PERO NO menciona la calle, pon null porque no es una dirección válida, eso corresponde a la aclaracion. Si NO menciona direccion ni retiro, pon null.
    - "aclaracion": Detalles extra de la dirección física (color de la casa, pisos, entre calles, timbre, departamento). Ejemplos: "la casa rosada de 2 pisos", "timbre 2B", "donde el porton gris" y asi. Si no se especifica, pon null.
    - "cantidad_agua" y "cantidad_crema": Cantidad en números, por defecto 0.
    - "cantidad_agua_operacion" y "cantidad_crema_operacion": SIEMPRE "reemplazar" en este contexto (es un pedido nuevo desde cero, no hay valor previo que sumar/restar/mantener).
    - "observaciones": Preferencias de sabores, gustos, o detalles de preparacion. Si el cliente menciona qué sabores quiere o no quiere (ej: "los de crema de chocolate y los de agua sin frutilla"), extrae esa instrucción textualmente y guárdala aquí. NUNCA INVENTES observaciones: si el cliente NO mencionó textualmente ningún sabor, gusto o detalle de preparación, devolvé null sin excepción.
    - "metodo_pago": "efectivo", "transferencia" o null. Puede referirse a cualquiera de los 2 metodos de formas distintas ("en billete", "cash", "mercado pago", "mp", etc.), de ellas obten alguna de estas 2 opciones validas.

    IMPORTANTE: Devolvé TODOS los campos del schema, incluso los que sean false o null. No omitas ninguno. Los campos que empiezan con "es_" (es_cancelacion, es_confirmacion, es_confirmacion_cancelacion, es_rechazo_cancelacion, es_modificacion_sin_datos, es_saludo) deben ser BOOLEANOS REALES (true o false sin comillas), NUNCA strings. Los flags es_cancelacion, es_confirmacion, es_confirmacion_cancelacion, es_rechazo_cancelacion y es_modificacion_sin_datos van siempre en false en este contexto (no hay pedido activo).
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
export async function procesarMensajesDeCliente(numeroCliente: string) {
  // 1. CLAIM ATÓMICO: marcamos los mensajes nuevos como procesados y traemos
  //    su contenido. Esto es lo que nos da la dedupliación entre wake-ups
  //    concurrentes: si otro worker ya los reclamó, este recibe 0 filas y sale.
  const { data: mensajesClaim, error: claimError } = await supabaseAdmin
    .from('mensajes_chat')
    .update({ procesado: true })
    .eq('telefono', numeroCliente)
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
    .neq('estado', 'cancelado')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

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
  let mensajesParaIA: { id: string; texto: string | null; created_at: string }[];

  if (pedidoActivo) {
    mensajesParaIA = [...mensajesClaim].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    console.log(`📚 Hay pedidoActivo (${pedidoActivo.estado}): pasamos solo los ${mensajesParaIA.length} mensajes nuevos del batch.`);
  } else {
    const hace15Minutos = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: historial } = await supabaseAdmin
      .from('mensajes_chat')
      .select('id, texto, created_at')
      .eq('telefono', numeroCliente)
      .gte('created_at', hace15Minutos)
      .order('created_at', { ascending: true })
      .limit(15);

    mensajesParaIA = historial ?? [];
    console.log(`📚 Sin pedidoActivo: traemos ${mensajesParaIA.length} mensajes recientes (últimos 15 min) para captar el pedido en armado.`);
  }

  if (mensajesParaIA.length === 0) {
    console.log(`⚠️ Sin mensajes para procesar para ${numeroCliente}. Algo raro pasó.`);
    return;
  }

  const historialParaIA = mensajesParaIA
    .map((m, index) => `Mensaje ${index + 1}: "${m.texto}"`)
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { object } = await generateObject({
        model: groq('openai/gpt-oss-20b'),
        system: SYSTEM_PROMPT,
        prompt: `Mensaje(s) del cliente: "${historialParaIA}"`,
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

      pedido = {
        ...object,
        cantidad_agua: cantidadAguaFinal,
        cantidad_crema: cantidadCremaFinal,
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
    await enviarMensajeWhatsApp(numeroCliente, "Disculpá, tuve un problema entendiendo tu mensaje. ¿Podés repetirlo? 🙏");
    return;
  }

  try {

    // OVERRIDE DE DIRECCIÓN HISTÓRICA
    if (!pedido.direccion && direccionGuardada) {
      console.log(`🛠️ OVERRIDE: El cliente no pasó dirección. Inyectando histórica: ${direccionGuardada}`);
      pedido.direccion = direccionGuardada;
      pedido.aclaracion = pedido.aclaracion ?? aclaracionGuardada;
    }

    pedido.datos_completos = Boolean(pedido.direccion && pedido.metodo_pago && (pedido.cantidad_agua > 0 || pedido.cantidad_crema > 0));

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

      if (pedido.es_modificacion_sin_datos && hayCambiosReales) {
        console.log("🛠️ OVERRIDE: La IA se equivocó. Se detectaron cambios reales en los datos, anulando el flag.");
        pedido.es_modificacion_sin_datos = false;
      }
    }

    // Override de Saludo Puro
    let trajoDatosUtiles = false;

    if (pedidoActivo && !pedidoEnviado) {
      trajoDatosUtiles = hayCambiosReales || pedido.es_cancelacion || pedido.es_confirmacion;
    } else {
      // Para anular el flag de saludo solo consideramos señales CONCRETAS
      // (numéricas o con formato esperado). Excluimos `observaciones` a
      // propósito: es texto libre y el modelo a veces lo inventa cuando el
      // cliente solo saluda, lo que llevaba a anular saludos legítimos.
      trajoDatosUtiles =
        pedido.cantidad_agua > 0 ||
        pedido.cantidad_crema > 0 ||
        pedido.direccion !== null ||
        pedido.metodo_pago !== null;
    }

    if (pedido.es_saludo && trajoDatosUtiles) {
      console.log("🛠️ OVERRIDE: El cliente saludó pero incluyó datos del pedido. Anulando flag de saludo.");
      pedido.es_saludo = false;
    }

    // 1. PRIORIDAD ABSOLUTA: CANCELACIÓN
    //
    // Todos los UPDATE de estos flujos van con guard atómico:
    //   .neq('estado', 'enviado').neq('enviado', true)
    // Esto evita una race condition: entre que leímos pedidoActivo y ahora,
    // el repartidor pudo haber tocado "Marcar como enviado". Si el UPDATE
    // afecta 0 filas, sabemos que se envió en la ventana y le avisamos al cliente.
    if (pedidoActivo && pedidoActivo.estado === 'esperando_cancelacion') {
      if (pedido.es_confirmacion_cancelacion) {
        const { data: cancelados } = await supabaseAdmin
          .from('pedidos')
          .update({ estado: 'cancelado' })
          .eq('id', pedidoActivo.id)
          .neq('estado', 'enviado')
          .neq('enviado', true)
          .select('id');

        if (cancelados && cancelados.length > 0) {
          await enviarMensajeWhatsApp(numeroCliente, "Listo, pedido cancelado definitivamente. Si volvés a tener ganas de helado, acá voy a estar. 👋");
          console.log(`✅ Pedido ${pedidoActivo.id} cancelado.`);
        } else {
          console.log(`⚠️ Race detectada: el pedido ${pedidoActivo.id} fue enviado entre el read y el UPDATE.`);
          await enviarMensajeWhatsApp(numeroCliente, "Uy, llegamos tarde. Tu pedido ya fue despachado por el repartidor y está en camino, por lo que no se pudo cancelar. 🛵");
        }
      } else if (pedido.es_rechazo_cancelacion) {
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
          await enviarMensajeWhatsApp(numeroCliente, "Mmm, algo cambió con tu pedido mientras tanto. Volveme a escribir y vemos cómo seguimos. 🙏");
        }
      } else {
        await enviarMensajeWhatsApp(numeroCliente, "Por favor, confirmame: ¿Querés cancelar el pedido? Respondé *SÍ* para cancelarlo o *NO* para mantenerlo activo.");
      }
      return;
    }

    if (pedido.es_cancelacion && pedidoActivo) {
      const { data: marcados } = await supabaseAdmin
        .from('pedidos')
        .update({ estado: 'esperando_cancelacion' })
        .eq('id', pedidoActivo.id)
        .neq('estado', 'enviado')
        .neq('enviado', true)
        .select('id');

      if (marcados && marcados.length > 0) {
        await enviarMensajeWhatsApp(numeroCliente, "⚠️ ¿Estás seguro de que querés cancelar tu pedido? Respondé *SÍ* para confirmar la cancelación o *NO* si querés conservarlo.");
        console.log(`⚠️ Pedido ${pedidoActivo.id} puesto en estado 'esperando_cancelacion'.`);
      } else {
        console.log(`❌ El cliente quiso cancelar pero el pedido ${pedidoActivo.id} ya fue enviado (race o estado previo).`);
        await enviarMensajeWhatsApp(numeroCliente, "Uy, te pido mil disculpas pero tu pedido ya fue despachado y está en camino, por lo que no podemos cancelarlo a esta altura. 🛵");
      }
      return;
    }

    // 2. SALUDO
    if (pedido.es_saludo) {
      if (yaExisteEnCocina) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Recordá que ya tenemos tu pedido en preparación. ¿Querés agregar o modificar algo, o te puedo ayudar con otra cosa?");
      } else if (tieneBorrador) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Tengo el resumen de tu pedido en pausa. ¿Me confirmás si los datos están bien con un *SÍ* o un *NO*?");
      } else if (esperandoCancelacion) {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Veo que tu pedido está a punto de ser cancelado. ¿Querés confirmar la cancelación con un *SÍ* o mantenerlo con un *NO*?");
      } else {
        await enviarMensajeWhatsApp(numeroCliente, "¡Hola! Qué gusto que nos escribas. 👋 ¿Qué te gustaría pedir hoy?");
      }
      console.log("👋 El cliente saludó. Respondiendo según el contexto...");
      return;
    }

    // 3. MODIFICACIÓN SIN DATOS
    if (pedido.es_modificacion_sin_datos && (tieneBorrador || yaExisteEnCocina)) {
      await enviarMensajeWhatsApp(numeroCliente, "Entendido. ¿Qué te gustaría modificar o agregar? Escribime los detalles así actualizo el pedido. 📝");
      console.log("⚠️ El cliente quiere modificar pero no dio datos nuevos.");
      return;
    }

    // 4. CONFIRMACIÓN (Solo si está en borrador)
    if (tieneBorrador) {
      if (pedido.es_confirmacion && !hayCambiosReales) {
        const { data: finalData } = await supabaseAdmin.from('pedidos').update({ estado: 'pendiente' }).eq('id', pedidoActivo.id).select('*').single();
        if (finalData) {
          await enviarMensajeWhatsApp(numeroCliente, `¡Espectacular! Pedido confirmado y enviado a la cocina. ¡Muchas gracias! 🍦`);
          console.log("✅ Pedido borrador confirmado por el cliente. Enviado a cocina.");
        }
      } else if (hayCambiosReales) {
        const { data: updatedData } = await supabaseAdmin.from('pedidos').update({
          cantidad_agua: pedido.cantidad_agua ?? pedidoActivo.cantidad_agua,
          cantidad_crema: pedido.cantidad_crema ?? pedidoActivo.cantidad_crema,
          direccion: pedido.direccion ?? pedidoActivo.direccion,
          aclaracion: pedido.aclaracion ?? pedidoActivo.aclaracion,
          observaciones: pedido.observaciones ?? pedidoActivo.observaciones,
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
          datosFaltantes.push("cuántos helados querés (y de qué tipo)");
        }
        if (!pedido.direccion) {
          datosFaltantes.push("a qué dirección te lo enviamos (o si pasás a retirar)");
        }
        if (!pedido.metodo_pago) {
          datosFaltantes.push("cómo preferís abonar (efectivo o transferencia)");
        }

        console.log("⚠️ Datos faltantes detectados:", datosFaltantes);

        let mensajeRespuesta = "";
        if (datosFaltantes.length === 3) {
          mensajeRespuesta = "¡Hola! Qué gusto que nos escribas. 👋 ¿Qué te gustaría pedir? (Recordá pasarnos cantidades, dirección de envío y método de pago).";
        } else {
          mensajeRespuesta = `¡Genial! Para terminar de armar tu pedido solo me faltaría saber: ${datosFaltantes.join(", ")}.`;
        }

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
          await enviarMensajeWhatsApp(numeroCliente, "¡Hola! 👋 Ya tenemos tu pedido en preparación. ¿Querés agregar o modificar algo, o te puedo ayudar con otra cosa?");
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
          await enviarResumenYPedirConfirmacion(numeroCliente, borradorDB, Boolean(yaExisteEnCocina));
        }
      }
    }
  } catch (flowError) {
    // Cualquier error inesperado en la lógica de flow post-IA cae acá.
    // El error del structured output ya se maneja arriba con su propio try/catch.
    console.error("❌ Error en el flow post-IA:", flowError);
  }
}

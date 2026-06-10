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
  cantidad_agua: z.number().describe('Cantidad de helados de agua. 0 si no se mencionó.'),
  cantidad_crema: z.number().describe('Cantidad de helados de crema. 0 si no se mencionó.'),
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
 * Procesa todos los mensajes pendientes de un cliente.
 *
 * Esta función se invoca desde el consumer de QStash (8 segundos después de
 * que llegó el último mensaje). Hace un "claim" atómico con UPDATE...RETURNING:
 * si dos wake-ups de QStash se solapan, solo uno se lleva los mensajes y
 * procesa; el otro recibe 0 filas y sale sin hacer nada.
 */
export async function procesarMensajesDeCliente(numeroCliente: string) {
  // 1. CLAIM ATÓMICO: marcamos los mensajes pendientes como procesados y nos
  //    los traemos. Esto es atómico a nivel Postgres — si otro wake-up
  //    paralelo intenta lo mismo, solo uno gana las filas.
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

  // Ordenamos del más viejo al más nuevo (el claim no garantiza orden)
  const ultimosMensajes = [...mensajesClaim].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // Tomamos los últimos 10 por las dudas (no saturar la IA)
  const mensajesParaIA = ultimosMensajes.slice(-10);

  const historialParaIA = mensajesParaIA
    .map((m, index) => `Mensaje ${index + 1}: "${m.texto}"`)
    .join("\n");

  console.log(`🤖 Texto final agrupado para la IA (${numeroCliente}):`, historialParaIA);

  // 2. Buscar pedido activo de hoy
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const { data: pedidoActivo } = await supabaseAdmin
    .from('pedidos')
    .select('*')
    .eq('telefono', numeroCliente)
    .gte('created_at', hoy.toISOString())
    .neq('estado', 'cancelado')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

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

  // 4. PROMPT DINÁMICO
  let SYSTEM_PROMPT = "";

  const tieneBorrador = pedidoActivo && pedidoActivo.estado === 'borrador';
  const yaExisteEnCocina = pedidoActivo && pedidoActivo.estado === 'pendiente' && !pedidoEnviado;
  const esperandoCancelacion = pedidoActivo && pedidoActivo.estado === 'esperando_cancelacion';

  console.log("📊 Evaluando contexto para construir el SYSTEM_PROMPT...");
  console.log(`- Tiene pedido en borrador? ${tieneBorrador}`);
  console.log(`- Ya existe en cocina? ${yaExisteEnCocina}`);
  console.log(`- Está esperando confirmación de cancelación? ${esperandoCancelacion}`);

  if (pedidoActivo && (tieneBorrador || yaExisteEnCocina || esperandoCancelacion)) {
    SYSTEM_PROMPT = `
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
      - "aclaracion": Detalles extra de la ubicación (departamento, piso, torre, conjunto, color de casa). Ej: "depto 6 del conjunto violeta", "la casa de 2 pisos", "donde el tacho gris", "con el porton verde". Si menciona esto, extraelo aquí. Si no, mantén lo actual: ${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'}.
      - "metodo_pago": Si no menciona un cambio explícito, mantén el actual: "${pedidoActivo.metodo_pago}".
      - "observaciones": ¡ATENCIÓN AQUÍ! Este campo guarda GUSTOS, SABORES o DETALLES DE PREPARACIÓN. Si el cliente menciona qué sabores quiere o no quiere (ej: "los de crema de chocolate y los de agua sin frutilla"), extrae esa instrucción textualmente y guárdala aquí. Si simplemente menciona "de crema" o "de agua", o parecidos, no guardar aqui, ya que se refiere unicamente al tipo de helado, y no a sabores en si. Si se refiere a "los de crema/agua que sean de X sabor", guardar info textual, es util. Si no menciona ningún sabor en este mensaje, mantén el valor actual de forma obligatoria: ${pedidoActivo.observaciones ? `"${pedidoActivo.observaciones}"` : 'null'}.
      - "cantidad_agua" y "cantidad_crema": Analiza con extrema precisión la semántica del mensaje:
        * Si pide SUMAR o AGREGAR (ej: "sumale 50", "agregá 20"): realiza la suma matemática del valor nuevo sobre el valor actual que te pasé en el contexto (Ej: si crema actual es 0 y pide sumar 50, el resultado es 50. Si agua actual es 70 y no se menciona, el resultado final DEBE seguir siendo 70).
        * Si pide CAMBIAR o REEMPLAZAR (ej: "que sean 50", "cambialo a 20"): coloca el nuevo valor ignorando el anterior.
        * Si no se menciona ese tipo de helado en el mensaje, MANTÉN el valor actual del contexto de forma obligatoria. NUNCA lo bajes a 0.

      OUTPUT EXPECTED (JSON crudo y válido):
      {
        "direccion": "string",
        "aclaracion": "string o null",
        "cantidad_agua": numero,
        "cantidad_crema": numero,
        "observaciones": "string o null",
        "metodo_pago": "string",
        "datos_completos": boolean,
        "es_cancelacion": boolean,
        "es_confirmacion": boolean,
        "es_confirmacion_cancelacion": boolean,
        "es_rechazo_cancelacion": boolean,
        "es_modificacion_sin_datos": boolean,
        "es_saludo": boolean
      }
    `;
  } else {
    SYSTEM_PROMPT = `
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
      - "cantidad_agua": Cantidad de helados en números, por defecto 0.
      - "cantidad_crema": Cantidad de helados en números, por defecto 0.
      - "observaciones": Preferencias de sabores, gustos, o detalles de preparacion. Si el cliente menciona qué sabores quiere o no quiere (ej: "los de crema de chocolate y los de agua sin frutilla"), extrae esa instrucción textualmente y guárdala aquí. Si no menciona nada por el estilo, null.
      - "metodo_pago": "efectivo", "transferencia" o null. Puede referirse a cualquiera de los 2 metodos de formas distintas ("en billete", "cash", "mercado pago", "mp", etc.), de ellas obten alguna de estas 2 opciones validas.

      OUTPUT EXPECTED (JSON crudo y válido):
      {
        "direccion": "string o null",
        "aclaracion": "string o null",
        "cantidad_agua": numero,
        "cantidad_crema": numero,
        "observaciones": "string o null",
        "metodo_pago": "string o null",
        "datos_completos": boolean,
        "es_cancelacion": false,
        "es_confirmacion": false,
        "es_modificacion_sin_datos": false,
        "es_saludo": boolean
      }
    `;
  }

  // 5. LLAMADA A GROQ con structured output validado por Zod.
  //    Si el modelo devuelve algo que no matchea el schema, el SDK reintenta
  //    automáticamente. Si falla N veces, tira un error que cae en el catch.
  let pedido: PedidoIA;
  try {
    const { object } = await generateObject({
      model: groq('openai/gpt-oss-20b'),
      system: SYSTEM_PROMPT,
      prompt: `Mensaje(s) del cliente: "${historialParaIA}"`,
      schema: PedidoIASchema,
      temperature: 0,
    });

    // datos_completos lo calculamos nosotros (no lo decide el modelo)
    pedido = {
      ...object,
      datos_completos: Boolean(
        object.direccion && object.metodo_pago && (object.cantidad_agua > 0 || object.cantidad_crema > 0)
      ),
    };

    console.log("✅ Objeto IA extraído:", pedido);
  } catch (iaError) {
    console.error("❌ Falló la extracción structured del modelo:", iaError);
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
      trajoDatosUtiles =
        pedido.cantidad_agua > 0 ||
        pedido.cantidad_crema > 0 ||
        pedido.direccion !== null ||
        pedido.metodo_pago !== null ||
        pedido.observaciones !== null;
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

import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';

// Este es un token secreto inventado por ti. Cópialo bien.
const VERIFY_TOKEN = "heladeria_token_secreto_123";

// 1. GET: Meta usa esto una sola vez para verificar que la URL es tuya
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WEBHOOK VERIFICADO POR META!');
    // Meta exige que devuelvas el challenge tal cual
    return new NextResponse(challenge, { status: 200 }); 
  }

  return NextResponse.json({ error: 'Token inválido' }, { status: 403 });
}

// Server-only Supabase client with service role to bypass RLS for webhook writes.
const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Inicializar cliente Groq (toma GROQ_API_KEY del entorno automáticamente)
const groq = createGroq();

// 2. POST: Aquí es donde llegarán todos los mensajes de texto
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Meta siempre envía un ping de verificación, hay que responder 200 rápido
    if (body.object !== 'whatsapp_business_account') {
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
    }

    const entry = body.entry?.[0];
    const message = entry?.changes?.[0]?.value?.messages?.[0];

    if (message && message.type === 'text') {
        let numeroCliente: string = message.from;
        if (numeroCliente.startsWith("549")) {
          numeroCliente = "54" + numeroCliente.slice(3);
        }
        const textoMensaje = message.text.body;

        console.log(`📩 Recibido de ${numeroCliente}: "${textoMensaje}"`);

        // 1. Guardar el mensaje actual en la BD temporal
        const { data: insertData, error: insertError } = await supabaseAdmin
          .from('mensajes_chat')
          .insert([{ telefono: numeroCliente, texto: textoMensaje }])
          .select('id')
          .single();

        if (insertError) {
          console.error("Error al guardar el mensaje:", insertError);
          return NextResponse.json({ status: 'error' }, { status: 200 });
        }

        const miMensajeId = insertData?.id;

        // 2. MAGIA: Esperamos 10 segundos (el cliente está escribiendo...)
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Calculamos la hora límite (Hace 1 hora)
        const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        // 3. Revisamos los mensajes de este número QUE SEAN RECIENTES
        const { data: ultimosMensajes } = await supabaseAdmin
          .from('mensajes_chat')
          .select('id, texto')
          .eq('telefono', numeroCliente)
          .gte('created_at', haceUnaHora) // <-- NUEVO FILTRO DE TIEMPO
          .order('created_at', { ascending: false })
          .limit(10); // Por las dudas, limitamos a 10 para no saturar a la IA

        // Si mi ID no es el último, significa que entró un mensaje MÁS NUEVO.
        // Abortamos esta función en silencio. El webhook del mensaje nuevo se hará cargo.
        if (ultimosMensajes && ultimosMensajes[0].id !== miMensajeId) {
          console.log("⏳ El cliente sigue escribiendo. Abortando este hilo.");
          return NextResponse.json({ status: 'ok' }, { status: 200 });
        }

        if (!ultimosMensajes) {
          console.error("No se pudieron obtener los mensajes del cliente.");
          return NextResponse.json({ status: 'error' }, { status: 200 });
        }

        // 4. Si llegamos acá, pasaron 10 segundos sin mensajes nuevos.
        // Unimos el historial de la última hora dándole formato de chat secuencial
        const historialParaIA = ultimosMensajes
          .reverse() // 1. Los ordenamos del más viejo al más nuevo
          .map((m, index) => `Mensaje ${index + 1}: "${m.texto}"`) // 2. Les ponemos la etiqueta
          .join("\n"); // 3. Los separamos con un salto de línea en vez de un punto

        console.log("🤖 Texto final agrupado para la IA:", historialParaIA);

        // Buscar si hay un pedido de hoy para este cliente todavia activo (no enviado)
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        const { data: pedidoActivo } = await supabaseAdmin
          .from('pedidos') // Reemplaza con tu nombre de tabla real
          .select('*')
          .eq('telefono', numeroCliente)
          .gte('created_at', hoy.toISOString())
          .neq('estado', 'cancelado') // Solo pedidos activos (no enviados)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        console.log("🔍 Pedido activo encontrado para el cliente:", pedidoActivo);

        // --- C. PROMPT DINÁMICO ---
      let SYSTEM_PROMPT = "";

      const tieneBorrador = pedidoActivo && pedidoActivo.estado === 'borrador';
      const yaExisteEnCocina = pedidoActivo && pedidoActivo.estado === 'pendiente' && pedidoActivo.enviado === false;

      console.log("📊 Evaluando contexto para construir el SYSTEM_PROMPT...");
      console.log(`- Tiene pedido en borrador? ${tieneBorrador}`);
      console.log(`- Ya existe en cocina? ${yaExisteEnCocina}`);

      SYSTEM_PROMPT = `
        ACTÚA COMO UNA API DE EXTRACCIÓN DE DATOS Y DETECCIÓN DE INTENCIONES. NO SALUDES, NO EXPLIQUES NADA.

        CONTEXTO ACTUAL:
        ${tieneBorrador ? `El sistema le mostró un resumen al cliente y espera confirmación.

        Datos en borrador:
          cantidad_crema: ${pedidoActivo.cantidad_crema}, 
          cantidad_agua: ${pedidoActivo.cantidad_agua}, 
          direccion: ${pedidoActivo.direccion},
          aclaracion: ${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'},
          observaciones: ${pedidoActivo.observaciones ? `"${pedidoActivo.observaciones}"` : 'null'},
          metodo_pago: "${pedidoActivo.metodo_pago}".` : ''},
          es_nuevo: false

        
        ${yaExisteEnCocina ? `El cliente tiene un pedido en cocina. Evalúa si quiere modificarlo, cancelarlo o agregar cosas.
        
        1. REGLAS DE EXTRACCIÓN / ACTUALIZACIÓN:
          - "direccion": Si el cliente no menciona una nueva dirección de envío, mantén de forma obligatoria la actual: "${pedidoActivo.direccion}".
          - "aclaracion": Si menciona referencias nuevas, extraelas. Si no dice nada nuevo sobre la ubicación, mantén la actual: ${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'}.
          - "cantidad_agua": Si no pide cantidades nuevas de agua, mantén la actual: ${pedidoActivo.cantidad_agua}.
          - "cantidad_crema": Si especifica cantidades o gustos nuevos, evalúa si modifican el total. Si no menciona cambios, mantén la cantidad actual: ${pedidoActivo.cantidad_crema}.
          - "observaciones": Aquí debes guardar los GUSTOS DE HELADO (Ej: "50 de frutilla y 50 de crema americana"). Si el mensaje menciona sabores, guardalos textualmente reemplazando lo anterior. Si no menciona sabores, mantén lo actual: ${pedidoActivo.observaciones ? `"${pedidoActivo.observaciones}"` : 'null'}.
          - "metodo_pago": Si no menciona un cambio explícito de medio de pago, mantén el actual: "${pedidoActivo.metodo_pago}".` : ''}.
          - "es_nuevo": false

        ${!tieneBorrador && !yaExisteEnCocina ? `El cliente no tiene pedidos activos. Trátalo como una nueva consulta. Marcar es_nuevo: true` : ''}

        1. DETECCIÓN DE INTENCIONES (Obligatorio):
        - "es_cancelacion": true SI Y SOLO SI el cliente pide explícitamente cancelar, anular, borrar o dice que ya no quiere el pedido. Considere el resto de los mensajes, porque puede estar pidiendo cambios pero no cancelación. Si pide cancelar, y luego una modificacion, esta modificando, es_cancelacion debe ser false
        - "es_confirmacion": true SI Y SOLO SI el contexto es un borrador y el cliente acepta los datos (ej: "sí", "dale", "perfecto", "ok", "mandalo").
        - "es_rechazo_sin_datos": true SI Y SOLO SI el contexto es un borrador y el cliente dice que la información está mal (ej: "no", "incorrecto", "está mal") PERO NO aporta los datos nuevos en ese mismo mensaje. EJ: Si dice "no, era a otra calle", esto es true (porque no aporto datos nuevos); si dice "no, era a Belgrano 124" es true, rechazo y hay datos nuevos.

        2. REGLAS DE EXTRACCIÓN DE DATOS:
        - "direccion": Calle y número (o "retira"). Si no hay, mantener la de contexto o null.
        - "aclaracion": Referencias. Si no hay, null.
        - "cantidad_agua": Cantidad en números.
        - "cantidad_crema": Cantidad en números.
        - "observaciones": Gustos de helado elegidos o cualquier detalle extra que el cliente mencione sobre su pedido. Si no hay, null.
        - "metodo_pago": "efectivo" o "transferencia" o null.

        3. EVALUACIÓN DE COMPLETITUD:
        - "datos_completos": true si y solo si tienes direccion, metodo_pago y (cantidad_agua > 0 || cantidad_crema > 0). Si "es_confirmacion", "es_cancelacion" o "es_rechazo_sin_datos" son true, esto también debe ser true para no pedir datos extra.

        SALIDA ESPERADA (Únicamente JSON crudo válido):
        {
          "direccion": "string o null",
          "aclaracion": "string o null",
          "cantidad_agua": numero,
          "cantidad_crema": numero,
          "observaciones": "string o null",
          "metodo_pago": "efectivo" o "transferencia" o null,
          "datos_completos": boolean,
          "es_cancelacion": boolean,
          "es_confirmacion": boolean,
          "es_rechazo_sin_datos": boolean,
          "es_nuevo": boolean
        }
      `;

        // 5. ACÁ LLAMAS A GROQ usando 'historialParaIA' y el SYSTEM_PROMPT separado
        const { text } = await generateText({
          model: groq('llama-3.1-8b-instant'),
          system: SYSTEM_PROMPT,
          prompt: `Mensaje(s) del cliente: "${historialParaIA}"`,
          temperature: 0,
        });

      try {
        // 1. Buscamos dónde empieza y termina el objeto JSON
        const inicioJson = text.indexOf('{');
        const finJson = text.lastIndexOf('}');

        if (inicioJson === -1 || finJson === -1) {
          throw new Error("No se encontraron las llaves del JSON en la respuesta.");
        }

        // 2. Recortamos exactamente ese pedazo de texto
        const jsonLimpio = text.substring(inicioJson, finJson + 1);

        // 3. Ahora sí, parseamos el texto limpio
        const pedido = JSON.parse(jsonLimpio);

        pedido.datos_completos = Boolean(pedido.direccion && pedido.metodo_pago && (pedido.cantidad_agua > 0 || pedido.cantidad_crema > 0));

        console.log("✅ JSON Extraído:", pedido);

        // 1. PRIORIDAD ABSOLUTA: INTENTO DE CANCELACIÓN
        if (pedido.es_cancelacion && pedidoActivo) {
          // Chequeamos las reglas de negocio: ¿Ya se envió?
          if ((pedidoActivo.estado === 'enviado' || pedidoActivo.enviado === true) && pedido.es_nuevo === true) {
            await enviarMensajeWhatsApp(numeroCliente, "Uy, te pido mil disculpas pero tu pedido ya fue despachado y está en camino, por lo que no podemos cancelarlo a esta altura. 🛵");

            console.log("❌ El cliente quiso cancelar pero el pedido ya fue enviado. Informado al cliente que no se puede cancelar.");
            console.log("🧹 Limpiando mensajes del cliente para evitar confusiones en el próximo pedido.");
            await supabaseAdmin.from('mensajes_chat').delete().eq('telefono', numeroCliente);
          } else {
            // Cancelamos directo sin preguntar
            await supabaseAdmin.from('pedidos').update({ estado: 'cancelado' }).eq('id', pedidoActivo.id);
            await enviarMensajeWhatsApp(numeroCliente, "¡Dale! No hay problema. Tu pedido fue cancelado en el sistema. Si más adelante tenés ganas de helado, escribime. 👋");
            console.log("❌ Pedido cancelado por el cliente.");
            console.log("🧹 Limpiando mensajes del cliente para empezar de cero en el próximo pedido.");
            await supabaseAdmin.from('mensajes_chat').delete().eq('telefono', numeroCliente);
          }
          return NextResponse.json({ status: 'ok' }, { status: 200 }); // Cortamos la ejecución acá
        }

        // 2. LÓGICA DE CONFIRMACIÓN (Solo si está en borrador)
        if (pedidoActivo && pedidoActivo.estado === 'borrador') {

          if (pedido.es_confirmacion) {
            const { data: finalData } = await supabaseAdmin.from('pedidos').update({ estado: 'pendiente' }).eq('id', pedidoActivo.id).select('*').single();
            if (finalData) {
              await enviarMensajeWhatsApp(numeroCliente, `¡Espectacular! Pedido confirmado y enviado a la cocina. ¡Muchas gracias! 🍦`);

              console.log("✅ Pedido borrador confirmado por el cliente. Enviado a cocina.");
              console.log("🧹 Limpiando mensajes del cliente para el próximo pedido.");
              await supabaseAdmin.from('mensajes_chat').delete().eq('telefono', numeroCliente);
            }
          } 
          else if (pedido.es_rechazo_sin_datos) {
            await enviarMensajeWhatsApp(numeroCliente, "Entendido. ¿Qué dato está incorrecto o qué te gustaría modificar? Escribime las correcciones así actualizo el pedido. 📝");
            
            console.log("⚠️ El cliente rechazó el resumen pero no dio datos nuevos. Pidiendo aclaración...");
            await supabaseAdmin.from('mensajes_chat').delete().eq('telefono', numeroCliente);

          } else {
            // Si no confirma ni cancela, asumimos que está modificando el borrador
            const { data: updatedData } = await supabaseAdmin.from('pedidos').update({
              cantidad_agua: pedido.cantidad_agua ?? pedidoActivo.cantidad_agua, 
              cantidad_crema: pedido.cantidad_crema ?? pedidoActivo.cantidad_crema,
              direccion: pedido.direccion ?? pedidoActivo.direccion, 
              aclaracion: pedido.aclaracion ?? pedidoActivo.aclaracion,
              observaciones: pedido.observaciones ?? pedidoActivo.observaciones, 
              metodo_pago: pedido.metodo_pago ?? pedidoActivo.metodo_pago,
              estado: 'borrador' // Volvemos a ponerlo en borrador para que el cliente confirme los cambios
            }).eq('id', pedidoActivo.id).select('*').single();

            console.log("🔄 Pedido en borrador modificado por el cliente. Datos actualizados en DB:", updatedData);
            
            if (updatedData) await enviarResumenYPedirConfirmacion(numeroCliente, updatedData, true);
          }
        }

        // 3. FLUJO NORMAL: Evaluar si faltan datos o si ya está todo para confirmar o modificar
        else {
          if (pedido.datos_completos === false) {
            // 1. Array para guardar qué cosas nos faltan
            const datosFaltantes = [];

            // 2. Evaluamos qué variables vinieron vacías o en 0
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

            // 3. Armamos la respuesta estandarizada
            let mensajeRespuesta = "";

            // Si le faltan los 3 datos (ej: el cliente solo dijo "Hola")
            if (datosFaltantes.length === 3) {
              mensajeRespuesta = "¡Hola! Qué gusto que nos escribas. 👋 ¿Qué te gustaría pedir? (Recordá pasarnos cantidades, dirección de envío y método de pago).";
            } 
            // Si le faltan 1 o 2 datos específicos
            else {
              mensajeRespuesta = `¡Genial! Para terminar de armar tu pedido solo me faltaría saber: ${datosFaltantes.join(", ")}.`;
            }

            // 4. Enviamos NUESTRA respuesta hardcodeada, no la de la IA
            await enviarMensajeWhatsApp(numeroCliente, mensajeRespuesta);
          } 
          // Si están todos los datos, confirmamos (y luego agregaremos el código de Supabase)
          else if (pedido.datos_completos === true) { 
            let borradorDB = null;

            // ES MODIFICACION DE UN PEDIDO QUE YA ESTÁ EN COCINA PERO NO FUE ENVIADO
            if (pedido.es_nuevo === false && pedidoActivo && pedidoActivo.estado !== 'estado' && pedidoActivo.enviado === false) {
              console.log("🔄 El cliente quiere modificar su pedido activo. Actualizando datos...");

              // ACTUALIZAR PEDIDO EXISTENTE
              const { data: updateData, error: updateError } = await supabaseAdmin
                .from('pedidos')
                .update({
                  cantidad_agua: pedido.cantidad_agua,
                  cantidad_crema: pedido.cantidad_crema,
                  direccion: pedido.direccion,
                  aclaracion: pedido.aclaracion,
                  observaciones: pedido.observaciones,
                  metodo_pago: pedido.metodo_pago,
                  estado: 'borrador' // Volvemos a ponerlo en borrador para que el cliente confirme los cambios
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
              // CREAR PEDIDO NUEVO
              const { data: insertData, error: insertError } = await supabaseAdmin
                .from('pedidos')
                .insert([{
                  telefono: numeroCliente,
                  direccion: pedido.direccion,
                  aclaracion: pedido.aclaracion,
                  cantidad_agua: pedido.cantidad_agua,
                  cantidad_crema: pedido.cantidad_crema,
                  observaciones: pedido.observaciones,
                  metodo_pago: pedido.metodo_pago,
                  estado: 'borrador' // Ajustá al estado por defecto que uses
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

            // Si la operación en la base de datos fue exitosa, armamos el resumen
            if (borradorDB) {
              // Construimos las secciones del mensaje según la disponibilidad de campos opcionales
              // const detalleHelado = [
              //   pedidoFinalDB.cantidad_crema > 0 ? `• Crema: ${pedidoFinalDB.cantidad_crema}` : '',
              //   pedidoFinalDB.cantidad_agua > 0 ? `• Agua: ${pedidoFinalDB.cantidad_agua}` : '',
              //   pedidoFinalDB.observaciones ? `  _Detalle: ${pedidoFinalDB.observaciones}_` : ''
              // ].filter(Boolean).join('\n');

              // const detalleEnvio = pedidoFinalDB.direccion === 'retira' 
              //   ? '• Retira por la sucursal' 
              //   : `• Envío a: ${pedidoFinalDB.direccion}${pedidoFinalDB.aclaracion ? ` (${pedidoFinalDB.aclaracion})` : ''}`;

              // const mensajeExito = [
              //   pedido.es_modificacion ? "¡Perfecto! Ya actualizamos tu pedido en el sistema. 📝" : "¡Perfecto! Tu pedido ya fue registrado con éxito. 🍦",
              //   "\n*Resumen del Pedido:*",
              //   detalleHelado,
              //   detalleEnvio,
              //   `• Pago: ${pedidoFinalDB.metodo_pago}`,
              //   `• *Total: $${pedidoFinalDB.precio_total}*`,
              //   "\nLo empezamos a preparar y te avisamos cualquier novedad."
              // ].join('\n');

              // // Enviamos el mensaje estructurado al cliente
              // await enviarMensajeWhatsApp(numeroCliente, mensajeExito);

              await enviarResumenYPedirConfirmacion(numeroCliente, borradorDB, pedido.es_modificacion);

              // Borramos el historial temporal de este cliente
              // const { error: deleteError } = await supabaseAdmin
              //   .from('mensajes_chat')
              //   .delete()
              //   .eq('telefono', numeroCliente);
                
              // if (deleteError) {
              //   console.error("❌ No se pudo limpiar el historial:", deleteError);
              // } else {
              //   console.log("🧹 Historial limpiado exitosamente para:", numeroCliente);
              // }
            }
          }  
        }

        
      } catch (parseError) {
        console.error("❌ Falló la extracción del JSON. Texto original:", text);
      }
    }

    // Meta requiere siempre un 200 rápido, sino reintenta el webhook
    return NextResponse.json({ status: 'ok' }, { status: 200 });

  } catch (error) {
    console.error('❌ Error en webhook:', error);
    // Igual devolvés 200 para que Meta no te bloquee el webhook
    return NextResponse.json({ status: 'error_interno' }, { status: 200 });
  }

}

async function enviarResumenYPedirConfirmacion(numeroCliente: string, pedidoDB: any, esModificacion: boolean) {
  const detalleHelado = [
    pedidoDB.cantidad_crema > 0 ? `• Crema: ${pedidoDB.cantidad_crema}` : '',
    pedidoDB.cantidad_agua > 0 ? `• Agua: ${pedidoDB.cantidad_agua}` : '',
    pedidoDB.observaciones ? `  _Sabores: ${pedidoDB.observaciones}_` : ''
  ].filter(Boolean).join('\n');

  const detalleEnvio = pedidoDB.direccion === 'retira' ? '• Retira en sucursal' : `• Envío a: ${pedidoDB.direccion}${pedidoDB.aclaracion ? ` (${pedidoDB.aclaracion})` : ''}`;

  const mensaje = [
    esModificacion ? "*¡Pedido modificado!* Revisá que esté todo bien:" : "*¡Excelente!* Analicé tu pedido y este es el resumen:",
    "\n" + detalleHelado,
    detalleEnvio,
    `• Pago: ${pedidoDB.metodo_pago}`,
    `• *Total a pagar: $${pedidoDB.precio_total}*`,
    "\n¿La información es correcta? Respondé *SÍ* para confirmar el pedido o *NO* para corregir algo."
  ].join('\n');

  await enviarMensajeWhatsApp(numeroCliente, mensaje);

  console.log("📩 Resumen enviado al cliente para confirmación. Esperando respuesta...");

  console.log("🧹 Limpiando mensajes del cliente para evitar confusiones mientras espera la confirmación.");
  await supabaseAdmin.from('mensajes_chat').delete().eq('telefono', numeroCliente);
}

async function enviarMensajeWhatsApp(numeroDestino: string, texto: string) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;

  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: numeroDestino,
        type: "text",
        text: { body: texto }
      })
    });

    if (!response.ok) {
      console.error("Error al enviar WhatsApp:", await response.text());
    }
  } catch (error) {
    console.error("Fallo la conexión con Meta:", error);
  }
}
import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { createClient } from '@supabase/supabase-js';

const VERIFY_TOKEN = "heladeria_token_secreto_123";
const groq = createGroq();
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('hub.mode') === 'subscribe' && searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
    return new NextResponse(searchParams.get('hub.challenge'), { status: 200 }); 
  }
  return NextResponse.json({ error: 'Token inválido' }, { status: 403 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.object !== 'whatsapp_business_account') return NextResponse.json({ status: 'ignored' }, { status: 200 });

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message?.type === 'text') {
      let numeroCliente: string = message.from;
      const textoMensaje: string = message.text.body;

      if (numeroCliente.startsWith("549")) numeroCliente = "54" + numeroCliente.slice(3);

      // --- A. DEBOUNCE DE MENSAJES (Espera de 4 segundos) ---
      const { data: insertData } = await supabase.from('mensajes_chat').insert([{ telefono: numeroCliente, texto: textoMensaje }]).select('id').single();
      await new Promise(resolve => setTimeout(resolve, 4000));

      const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: ultimosMensajes } = await supabase.from('mensajes_chat').select('id, texto').eq('telefono', numeroCliente).gte('created_at', haceUnaHora).order('created_at', { ascending: false }).limit(10);

      if (ultimosMensajes && ultimosMensajes[0].id !== insertData?.id) return NextResponse.json({ status: 'ok' }, { status: 200 });

      const historialParaIA = ultimosMensajes.map(m => m.texto).reverse().join(" . ");

      // --- B. BÚSQUEDA DE PEDIDO ACTIVO EN LA JORNADA ---
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      const { data: pedidoActivo } = await supabase.from('pedidos').select('*').eq('telefono_cliente', numeroCliente).gte('created_at', hoy.toISOString()).order('created_at', { ascending: false }).limit(1) .single();

      // --- C. PROMPT DINÁMICO SEGÚN EL ESTADO DEL PEDIDO ---
      let SYSTEM_PROMPT = "";

      if (pedidoActivo && pedidoActivo.estado === 'borrador') {
        // CASO INTERMEDIO: El bot ya mostró el resumen y está esperando un SÍ o un NO
        SYSTEM_PROMPT = `
          ACTÚA COMO UN ANALIZADOR DE CONFIRMACIONES. NO SALUDES NI EXPLIQUES NADA.
          El cliente está viendo el resumen de su pedido y el sistema espera su confirmación.
          Datos actuales del borrador: Crema: ${pedidoActivo.cantidad_crema}kg, Agua: ${pedidoActivo.cantidad_agua}kg, Direccion: ${pedidoActivo.direccion}, Pago: ${pedidoActivo.metodo_pago}.

          Analizá su mensaje de respuesta:
          1. Si CONFIRMA (dice "sí", "ok", "dale", "perfecto", "confirmar", "está bien", "es correcto"): pon "accion_confirmacion": "aceptar".
          2. Si CANCELA (dice "no", "cancelalo", "ya no lo quiero", "borralo"): pon "accion_confirmacion": "cancelar".
          3. Si quiere MODIFICAR algo (ej: "no, cambiale el pago", "agregá un kilo más", "era a otra calle"): pon "accion_confirmacion": "modificar" Y EXTRAE los nuevos datos combinándolos con el borrador.

          SALIDA: Devuelve SOLO el JSON crudo:
          {
            "direccion": "${pedidoActivo.direccion}",
            "aclaracion": ${pedidoActivo.aclaracion ? `"${pedidoActivo.aclaracion}"` : 'null'},
            "cantidad_agua": ${pedidoActivo.cantidad_agua},
            "cantidad_crema": ${pedidoActivo.cantidad_crema},
            "observaciones": ${pedidoActivo.observaciones ? `"${pedidoActivo.observaciones}"` : 'null'},
            "metodo_pago": "${pedidoActivo.metodo_pago}",
            "datos_completos": true,
            "accion_confirmacion": "aceptar" o "cancelar" o "modificar"
          }
        `;
      } else {
        // CASO NORMAL: Pedido nuevo o modificación de uno que ya estaba pendiente en cocina
        const yaExisteEnCocina = pedidoActivo && pedidoActivo.estado === 'pendiente' && !pedidoActivo.enviado && !pedidoActivo.wpp_enviado;
        
        SYSTEM_PROMPT = `
          ACTÚA COMO UNA API DE EXTRACCIÓN DE DATOS. NO SALUDES, NO EXPLIQUES NADA.
          ${yaExisteEnCocina ? `El cliente quiere editar un pedido que ya envió a cocina con estos datos: Crema: ${pedidoActivo.cantidad_crema}, Agua: ${pedidoActivo.cantidad_agua}, Dir: ${pedidoActivo.direccion}. Modifica los datos sobre esa base.` : 'Trátalo como un pedido nuevo.'}

          1. REGLAS:
          - "direccion": Calle y número (o "retira"). Si no hay, null.
          - "aclaracion": Referencias de ubicación. Si no hay, null.
          - "cantidad_agua"/"cantidad_crema": Cantidades en números (por defecto 0).
          - "observaciones": Sabores de helado elegidos. Si no hay, null.
          - "metodo_pago": "efectivo", "transferencia" o null.

          2. EVALUACIÓN:
          - "datos_completos": true si y solo si tienes dirección, método_pago y alguna cantidad > 0.

          SALIDA: Devuelve SOLO el JSON crudo:
          {
            "direccion": "string o null",
            "aclaracion": "string o null",
            "cantidad_agua": numero,
            "cantidad_crema": numero,
            "observaciones": "string o null",
            "metodo_pago": "efectivo" o "transferencia" o null,
            "datos_completos": boolean,
            "accion_confirmacion": null
          }
        `;
      }

      // --- D. EJECUCIÓN DE IA ---
      const { text } = await generateText({ model: groq('llama-3.1-8b-instant'), system: SYSTEM_PROMPT, prompt: `Mensajes: "${historialParaIA}"` });

      // --- E. PARSEO Y LOGICA DE NEGOCIO ---
      try {
        const inicioJson = text.indexOf('{'); const finJson = text.lastIndexOf('}');
        if (inicioJson === -1 || finJson === -1) throw new Error("JSON no encontrado");
        const pedido = JSON.parse(text.substring(inicioJson, finJson + 1));

        // 1. EVALUAR SI ESTAMOS EN EL FLUJO DE CONFIRMACIÓN
        if (pedidoActivo && pedidoActivo.estado === 'borrador') {
          if (pedido.accion_confirmacion === 'aceptar') {
            const { data: finalData } = await supabase.from('pedidos').update({ estado: 'pendiente' }).eq('id', pedidoActivo.id).select('*').single();
            if (finalData) {
              await enviarMensajeWhatsApp(numeroCliente, `¡Espectacular! Pedido confirmado y enviado a la cocina. Código de seguimiento: *#${finalData.id}*. ¡Muchas gracias! 🍦`);
              await supabase.from('mensajes_chat').delete().eq('telefono', numeroCliente);
            }
          } 
          
          else if (pedido.accion_confirmacion === 'cancelar') {
            await supabase.from('pedidos').delete().eq('id', pedidoActivo.id);
            await enviarMensajeWhatsApp(numeroCliente, "Dale, no hay problema. Cancelé el borrador del pedido. Si volvés a tener ganas de helado, avisame. 🌟");
            await supabase.from('mensajes_chat').delete().eq('telefono', numeroCliente);
          } 
          
          else if (pedido.accion_confirmacion === 'modificar') {
            const { data: updatedData } = await supabase.from('pedidos').update({
              cantidad_agua: pedido.cantidad_agua, cantidad_crema: pedido.cantidad_crema,
              direccion: pedido.direccion, aclaracion: pedido.aclaracion,
              observaciones: pedido.observaciones, metodo_pago: pedido.metodo_pago
            }).eq('id', pedidoActivo.id).select('*').single();
            
            if (updatedData) await enviarResumenYPedirConfirmacion(numeroCliente, updatedData, true);
          }
        } 
        
        // 2. FLUJO NORMAL (CREACIÓN O RE-APERTURA DE PEDIDO DESDE COCINA)
        else {
          if (pedido.datos_completos === true) {
            let borradorDB = null;

            if (pedidoActivo && pedidoActivo.estado === 'pendiente' && !pedidoActivo.enviado && !pedidoActivo.wpp_enviado) {
              // Si ya estaba en cocina y lo modifica, lo volvemos a pasar a 'borrador' para que confirme el cambio de precio
              const { data: modData } = await supabase.from('pedidos').update({
                cantidad_agua: pedido.cantidad_agua, cantidad_crema: pedido.cantidad_crema,
                direccion: pedido.direccion, aclaracion: pedido.aclaracion,
                observaciones: pedido.observaciones, metodo_pago: pedido.metodo_pago,
                estado: 'borrador' 
              }).eq('id', pedidoActivo.id).select('*').single();
              borradorDB = modData;
            } else {
              // Nuevo Pedido: se crea directamente como 'borrador'
              const { data: newData } = await supabase.from('pedidos').insert([{
                telefono_cliente: numeroCliente, direccion: pedido.direccion, aclaracion: pedido.aclaracion,
                cantidad_agua: pedido.cantidad_agua, cantidad_crema: pedido.cantidad_crema,
                observaciones: pedido.observaciones, metodo_pago: pedido.metodo_pago,
                estado: 'borrador'
              }]).select('*').single();
              borradorDB = newData;
            }

            if (borradorDB) await enviarResumenYPedirConfirmacion(numeroCliente, borradorDB, !!pedidoActivo);
          } 
          
          else {
            // Lógica determinista de datos faltantes
            const faltantes = [];
            if (pedido.cantidad_agua === 0 && pedido.cantidad_crema === 0) faltantes.push("cuántos helados querés");
            if (!pedido.direccion) faltantes.push("la dirección de envío");
            if (!pedido.metodo_pago) faltantes.push("el medio de pago");

            const msg = faltantes.length === 3 
              ? "¡Hola! ¿Qué te gustaría pedir hoy? 🍦" 
              : `¡Buenísimo! Ya tomé nota. Solo me estaría faltando saber: ${faltantes.join(", ")}.`;
            await enviarMensajeWhatsApp(numeroCliente, msg);
          }
        }

      } catch (parseError) {
        console.error("❌ Error de parseo:", text);
      }
    }
    return NextResponse.json({ status: 'ok' }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ status: 'error' }, { status: 200 });
  }
}

// --- F. FUNCIONES AUXILIARES ---
async function enviarResumenYPedirConfirmacion(numeroCliente: string, pedidoDB: any, esModificacion: boolean) {
  const detalleHelado = [
    pedidoDB.cantidad_crema > 0 ? `• Crema: ${pedidoDB.cantidad_crema} kg` : '',
    pedidoDB.cantidad_agua > 0 ? `• Agua: ${pedidoDB.cantidad_agua} kg` : '',
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
}

async function enviarMensajeWhatsApp(numeroDestino: string, texto: string) {
  try {
    await fetch(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: "whatsapp", to: numeroDestino, type: "text", text: { body: texto } })
    });
  } catch (e) { console.error(e); }
}
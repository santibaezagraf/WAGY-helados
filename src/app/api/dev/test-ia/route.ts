import { NextResponse } from 'next/server';
import { generateObject } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import {
  PedidoIASchema,
  buildSystemPrompt,
  aplicarOperacionCantidad,
  aplicarOperacionAclaracion,
  aplicarOperacionObs,
  leerSlots,
  reconstruirObservaciones,
  pareceDireccion,
  type ObsSlots,
  type PedidoActivoContext,
} from '@/lib/bot/procesar';

/**
 * Endpoint de DESARROLLO. Sirve para verificar end-to-end (sin Meta ni QStash)
 * que el modelo extrae bien las intenciones y los datos del pedido.
 *
 * SE BLOQUEA en producción (process.env.NODE_ENV === 'production').
 *
 * Body:
 *   {
 *     "mensaje": "sumale 5 de agua",         // requerido
 *     "pedidoActivo": {                      // opcional. Si está, usa el prompt
 *       "estado": "borrador",                // de modificación. Si no, el de pedido nuevo.
 *       "cantidad_agua": 70,
 *       "cantidad_crema": 10,
 *       "direccion": "Mitre 951",
 *       "aclaracion": "casa verde",
 *       "observaciones": null,
 *       "metodo_pago": "efectivo"
 *     }
 *   }
 *
 * Ejemplo PowerShell (pedido nuevo):
 *   Invoke-RestMethod -Method Post `
 *     -Body '{"mensaje":"hola, quiero 10 de crema en Mitre 951 efectivo"}' `
 *     -ContentType 'application/json' `
 *     http://localhost:3000/api/dev/test-ia | ConvertTo-Json -Depth 5
 *
 * Ejemplo PowerShell (modificación con pedido en borrador):
 *   $body = @{
 *     mensaje = "que sean 25 más de agua"
 *     pedidoActivo = @{
 *       estado = "borrador"
 *       cantidad_agua = 70
 *       cantidad_crema = 10
 *       direccion = "Mitre 951"
 *       aclaracion = "casa verde"
 *       observaciones = $null
 *       metodo_pago = "efectivo"
 *     }
 *   } | ConvertTo-Json
 *   Invoke-RestMethod -Method Post -Body $body -ContentType 'application/json' `
 *     http://localhost:3000/api/dev/test-ia | ConvertTo-Json -Depth 5
 */
const groq = createGroq();

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 403 });
  }

  const body = await request.json();
  const { mensaje, pedidoActivo } = body as {
    mensaje?: string;
    pedidoActivo?: PedidoActivoContext;
  };

  if (!mensaje || typeof mensaje !== 'string') {
    return NextResponse.json({ error: 'falta "mensaje" en el body' }, { status: 400 });
  }

  const systemPrompt = buildSystemPrompt(pedidoActivo ?? null);

  const start = Date.now();
  try {
    const { object, usage } = await generateObject({
      model: groq('openai/gpt-oss-20b'),
      system: systemPrompt,
      prompt: `Mensaje(s) del cliente: "${mensaje}"`,
      schema: PedidoIASchema,
      temperature: 0,
    });

    // Aplicamos las operaciones de cantidad como lo hace el flujo real,
    // para que el resultado refleje lo que la DB terminaría guardando.
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

    const aclaracionActual = pedidoActivo?.aclaracion ?? null;
    const aclaracionFinal = aplicarOperacionAclaracion(
      object.aclaracion_operacion,
      object.aclaracion,
      aclaracionActual,
    );

    const slotsActuales = leerSlots(pedidoActivo ?? null);
    const slotsFinales: ObsSlots = {
      agua: aplicarOperacionObs(object.obs_agua_operacion, object.obs_agua, slotsActuales.agua),
      crema: aplicarOperacionObs(object.obs_crema_operacion, object.obs_crema, slotsActuales.crema),
      general: aplicarOperacionObs(object.obs_general_operacion, object.obs_general, slotsActuales.general),
    };
    const observacionesFinal = reconstruirObservaciones(slotsFinales);

    // #7: validación determinista de la dirección, igual que el flujo real.
    const direccionValida = pareceDireccion(object.direccion);
    const direccionFinal = direccionValida ? object.direccion : null;

    return NextResponse.json({
      ok: true,
      latencyMs: Date.now() - start,
      contexto: pedidoActivo
        ? { modo: 'modificacion', estado: pedidoActivo.estado, cantidades_actuales: { agua: cantidadAguaActual, crema: cantidadCremaActual } }
        : { modo: 'pedido_nuevo' },
      usage,
      raw_ia: object,
      computado: {
        direccion: direccionFinal,
        direccion_descartada: object.direccion && !direccionValida ? object.direccion : null,
        cantidad_agua: cantidadAguaFinal,
        cantidad_crema: cantidadCremaFinal,
        operacion_agua: `${cantidadAguaActual} ${object.cantidad_agua_operacion} ${object.cantidad_agua} = ${cantidadAguaFinal}`,
        operacion_crema: `${cantidadCremaActual} ${object.cantidad_crema_operacion} ${object.cantidad_crema} = ${cantidadCremaFinal}`,
        aclaracion: aclaracionFinal,
        operacion_aclaracion: `"${aclaracionActual ?? ''}" ${object.aclaracion_operacion} "${object.aclaracion ?? ''}" = "${aclaracionFinal ?? ''}"`,
        observaciones: observacionesFinal,
        observaciones_detalle: slotsFinales,
        slots_observaciones: `${JSON.stringify(slotsActuales)} -> ${JSON.stringify(slotsFinales)}`,
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      latencyMs: Date.now() - start,
      error: String(error),
      hint: 'Si dice "tools not supported" o el modelo no banca structured outputs, probá cambiar a openai/gpt-oss-120b o moonshotai/kimi-k2-instruct.',
    }, { status: 200 });
  }
}

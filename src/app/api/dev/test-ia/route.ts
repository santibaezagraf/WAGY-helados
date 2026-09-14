import { NextResponse } from 'next/server';
import { generateObject } from 'ai';
import {
  PedidoIASchema,
  buildSystemPrompt,
  aplicarOperacionCantidad,
  resolverAclaracion,
  aplicarOperacionObs,
  leerSlots,
  reconstruirObservaciones,
  pareceDireccion,
  type ObsSlots,
  type PedidoActivoContext,
} from '@/lib/bot/procesar';
import { crearModeloLLM } from '@/lib/bot/proveedor-llm';
import { MODELOS_EXTRACCION, PROVEEDOR_LLM } from '@/lib/bot/modelos';

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
// Modelo PRIMARIO de la cadena de extracción del PROVEEDOR ACTIVO (toggle
// LLM_PROVIDER en .env.local): Groq gpt-oss-20b por default, gemini-3.6-flash con
// LLM_PROVIDER=google. Acá NO hacemos fallback de cadena a propósito —igual que el
// nightly— para que un 429/error del primario surja en vez de enmascararse: el
// punto del eval es medir el modelo que corre en producción, no la red de fallback.
const MODELO_PRIMARIO = MODELOS_EXTRACCION[0];

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 403 });
  }

  const body = await request.json();
  const { mensaje, pedidoActivo, hayPedidoCanceladoReciente } = body as {
    mensaje?: string;
    pedidoActivo?: PedidoActivoContext;
    // Habilita la intención "reactivar" en el prompt de pedido nuevo, igual que
    // el flujo real cuando el cliente canceló hace poco. Solo aplica sin pedidoActivo.
    hayPedidoCanceladoReciente?: boolean;
  };

  if (!mensaje || typeof mensaje !== 'string') {
    return NextResponse.json({ error: 'falta "mensaje" en el body' }, { status: 400 });
  }

  const systemPrompt = buildSystemPrompt(pedidoActivo ?? null, {
    hayPedidoCanceladoReciente: Boolean(hayPedidoCanceladoReciente),
  });

  const start = Date.now();
  try {
    const { object, usage } = await generateObject({
      model: crearModeloLLM(MODELO_PRIMARIO),
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
    const aclaracionFinal = resolverAclaracion(
      object.aclaracion_operacion,
      object.aclaracion,
      aclaracionActual,
      object.direccion,
      pedidoActivo?.direccion ?? null,
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
      proveedor: PROVEEDOR_LLM,
      modelo: MODELO_PRIMARIO,
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
      proveedor: PROVEEDOR_LLM,
      modelo: MODELO_PRIMARIO,
      error: String(error),
      hint: `Falló ${PROVEEDOR_LLM}/${MODELO_PRIMARIO}. Si es 429 es cuota (esperá o cambiá EVAL_DELAY_MS); si es 503 en Google el modelo está sobrecargado (reintentá); si dice "tools not supported" el modelo no banca structured output.`,
    }, { status: 200 });
  }
}

import { NextResponse } from 'next/server';
import { construirContextoNegocio, responderConsultaNegocio } from '@/lib/bot/consultas-negocio';
import { obtenerListaPreciosPublica } from '@/lib/precios-publico';
import type { PedidoActivoContext } from '@/lib/bot/procesar';

/**
 * Endpoint de DESARROLLO. Prueba la RESPUESTA LIBRE ACOTADA a consultas de
 * negocio (módulo consultas-negocio) sin Meta ni QStash: arma el mismo contexto
 * curado que el flujo real y llama al modelo.
 *
 * SE BLOQUEA en producción (process.env.NODE_ENV === 'production').
 *
 * Body:
 *   {
 *     "pregunta": "¿tenés de agua o de crema?",   // requerido
 *     "pedidoActivo": {                            // opcional. Si está, se incluye
 *       "estado": "borrador",                      // en el contexto (para "¿cuánto
 *       "cantidad_agua": 0,                        // es mi total?").
 *       "cantidad_crema": 4,
 *       "direccion": "Mitre 951",
 *       "aclaracion": null,
 *       "observaciones": null,
 *       "metodo_pago": "transferencia",
 *       "precio_total": 1600
 *     }
 *   }
 *
 * Ejemplo PowerShell:
 *   Invoke-RestMethod -Method Post `
 *     -Body '{"pregunta":"¿tenés de agua o de crema?"}' `
 *     -ContentType 'application/json' `
 *     http://localhost:3000/api/dev/responder-negocio | ConvertTo-Json -Depth 5
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 403 });
  }

  const body = await request.json();
  const { pregunta, pedidoActivo } = body as {
    pregunta?: string;
    pedidoActivo?: PedidoActivoContext;
  };

  if (!pregunta || typeof pregunta !== 'string') {
    return NextResponse.json({ error: 'Falta "pregunta" (string).' }, { status: 400 });
  }

  const lista = await obtenerListaPreciosPublica();
  const contexto = construirContextoNegocio(pedidoActivo ?? null, lista);
  const resultado = await responderConsultaNegocio(pregunta, contexto);

  return NextResponse.json({ pregunta, contexto, resultado });
}

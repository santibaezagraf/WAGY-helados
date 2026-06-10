import { NextResponse } from 'next/server';
import { generateObject } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { PedidoIASchema } from '@/lib/bot/procesar';

/**
 * Endpoint de DESARROLLO. Solo sirve para verificar que generateObject + Zod
 * funcionan con el modelo de Groq.
 *
 * SE BLOQUEA en producción (process.env.NODE_ENV === 'production').
 *
 * Uso (PowerShell):
 *   Invoke-RestMethod -Method Post `
 *     -Body '{"mensaje":"hola, quiero 10 helados de crema y 5 de agua, mi direccion es Mitre 951, pago en efectivo"}' `
 *     -ContentType 'application/json' `
 *     http://localhost:3000/api/dev/test-ia
 */
const groq = createGroq();

const SYSTEM_PROMPT_SIMPLE = `
ACTÚA COMO UNA API DE EXTRACCIÓN DE DATOS. NO ERES UN ASISTENTE CONVERSACIONAL. NO SALUDES, NO EXPLIQUES NADA.

CONTEXTO: El cliente no tiene pedidos activos. Extrae una nueva orden desde cero.

REGLAS:
- "direccion": ÚNICAMENTE nombre de calle y número (Ej: "Mitre 951"). null si no se menciona.
- "aclaracion": Detalles extra de la dirección. null si no aplica.
- "cantidad_agua" y "cantidad_crema": Números. 0 por defecto.
- "observaciones": Sabores o detalles textuales. null si no aplica.
- "metodo_pago": "efectivo", "transferencia" o null.
- "es_saludo": true si solo saluda sin aportar datos.
- Todos los otros campos (es_cancelacion, es_confirmacion, es_confirmacion_cancelacion, es_rechazo_cancelacion, es_modificacion_sin_datos): false.
`;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 403 });
  }

  const { mensaje, system } = await request.json();

  if (!mensaje || typeof mensaje !== 'string') {
    return NextResponse.json({ error: 'falta "mensaje" en el body' }, { status: 400 });
  }

  const start = Date.now();
  try {
    const { object, usage } = await generateObject({
      model: groq('openai/gpt-oss-20b'),
      system: system || SYSTEM_PROMPT_SIMPLE,
      prompt: `Mensaje(s) del cliente: "${mensaje}"`,
      schema: PedidoIASchema,
      temperature: 0,
    });

    return NextResponse.json({
      ok: true,
      latencyMs: Date.now() - start,
      usage,
      object,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      latencyMs: Date.now() - start,
      error: String(error),
      hint: 'Si dice "tools not supported" o similar, llama-3.1-8b-instant no banca generateObject. Probá con llama-3.3-70b-versatile o pasale `mode: "json"` a generateObject.',
    }, { status: 200 });
  }
}

import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';

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

// Inicializar cliente Groq (toma GROQ_API_KEY del entorno automáticamente)
const groq = createGroq();

const esquemaPedido = z.object({
  direccion: z.string().nullable().describe('Dirección de entrega del pedido'),
  cantidad_agua: z.number().default(0).describe('Cantidad de helados de agua'),
  cantidad_crema: z.number().default(0).describe('Cantidad de helados de crema'),
  metodo_pago: z
    .enum(['efectivo', 'transferencia'])
    .nullable()
    .describe('Método de pago elegido por el cliente (solo efectivo o transferencia, sino null)'),
  datos_completos: z
    .boolean()
    .describe('true solo si dirección, cantidades (con que haya cantidad_agua > 0 o cantidad_crema > 0 ya se considera que están las cantidades) y método de pago están presentes'),
  pregunta_faltante: z
    .string()
    .nullable()
    .describe('si datos_completos es false, formula una pregunta al cliente en base a lo que falta (EJ: “¿En qué dirección te lo enviamos?” o “¿Cómo abonás? (efectivo o transferencia)”). Si datos_completos es true, pon null.'),
});

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

    if (message?.type === 'text') {
      const textoMensaje: string = message.text.body;
      const numeroCliente: string = message.from;

      console.log(`📨 Mensaje de ${numeroCliente}: "${textoMensaje}"`);

      // ✅ ACÁ: generateObject con Groq
      const { text } = await generateText({
          model: groq('llama-3.1-8b-instant'), // Rápido, gratis y sin errores de json_schema
          prompt: `
            Eres el asistente de una heladería familiar. Analizá el siguiente mensaje de un cliente y extraé la información del pedido.
            
            REGLA ESTRICTA: Tu respuesta debe ser ÚNICA Y EXCLUSIVAMENTE un objeto JSON válido con esta estructura exacta. No agregues comillas invertidas, ni formato markdown, ni saludos, ni texto adicional. SOLO el JSON crudo:
            {
              "direccion": "string o null",
              "cantidad_agua": numero,
              "cantidad_crema": numero,
              "metodo_pago": "efectivo" o "transferencia" o null,
              "datos_completos": boolean,
              "pregunta_faltante": "string o null"
            }

            Mensaje del cliente: "${textoMensaje}"
          `
      });

      try {
          // 3. Transformamos el texto plano de la IA en un objeto real de código
          const pedido = JSON.parse(text.trim());
          
          console.log("✅ Pedido extraído y parseado exitosamente:");
          console.log(pedido);
          
          // Acá ya podés usar pedido.direccion, pedido.cantidad_agua, etc.
          // Y evaluar si (pedido.datos_completos === false) para pedirle lo que falta por WhatsApp
          
      } catch (parseError) {
        console.error("La IA devolvió texto que no pudo convertirse a JSON:", text);
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
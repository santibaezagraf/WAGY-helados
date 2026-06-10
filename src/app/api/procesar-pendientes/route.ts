import { NextResponse } from 'next/server';
import { verifySignatureAppRouter } from '@upstash/qstash/nextjs';
import { procesarMensajesDeCliente } from '@/lib/bot/procesar';

/**
 * Endpoint que QStash invoca 8 segundos después de cada mensaje recibido.
 *
 * Está protegido por la firma de QStash (verifySignatureAppRouter): si llega
 * un request sin la firma válida, devuelve 401. Esto evita que cualquiera
 * pueda dispararlo desde afuera.
 *
 * Las signing keys vienen de las env vars:
 *   - QSTASH_CURRENT_SIGNING_KEY
 *   - QSTASH_NEXT_SIGNING_KEY
 *
 * (Las dos son necesarias por la rotación periódica que hace Upstash.)
 */
async function handler(request: Request) {
  try {
    const { telefono } = await request.json();

    if (!telefono || typeof telefono !== 'string') {
      console.error("❌ Wake-up sin telefono válido:", telefono);
      return NextResponse.json({ error: 'telefono requerido' }, { status: 400 });
    }

    console.log(`⏰ Wake-up de QStash recibido para ${telefono}`);
    await procesarMensajesDeCliente(telefono);

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error("❌ Error en /api/procesar-pendientes:", error);
    // Devolvemos 500 a propósito: QStash va a reintentar automáticamente,
    // y el claim atómico previene duplicación.
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export const POST = verifySignatureAppRouter(handler);

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { procesarMensajesDeCliente } from '@/lib/bot/procesar';
import { ejecutarBoton, parsearBotonId, RESPUESTAS_RAPIDAS, type BotonAccion } from '@/lib/bot/botones';
import { drenarSalidaTest, type SalidaCapturada } from '@/lib/whatsapp';

/**
 * Endpoint de DESARROLLO — "driver" del bot para el harness de testeo
 * conversacional (scripts/probar-bot.mjs). Mete un evento entrante en el
 * pipeline REAL (mismo prompt, misma extracción, misma máquina de estados,
 * misma DB) y devuelve lo que el bot respondió + el estado del pedido, SIN
 * mandar nada a Meta.
 *
 * DOBLE GUARDA:
 *   1. Se bloquea en producción (NODE_ENV === 'production').
 *   2. Exige BOT_TEST_MODE === '1'. Ese mismo flag hace que postAMeta
 *      (whatsapp.ts) NO toque la red, así que encenderlo habilita este driver
 *      y corta los envíos reales a la vez.
 *
 * AISLAMIENTO: solo opera sobre teléfonos de prueba (prefijo BOT_TEST_PREFIX,
 * default "54000"). Nunca toca filas de un cliente real.
 *
 * Cómo se saltea el debounce: procesarMensajesDeCliente difiere si el último
 * mensaje pendiente tiene < 5s (DEFER_THRESHOLD_MS). Insertamos la fila del
 * cliente con created_at atrasado ~10s para que el claim proceda de una, sin
 * tocar procesar.ts.
 *
 * Acciones (body.accion):
 *   - enviarTexto  { telefono, texto | textos[] }  → un mensaje (o varios = mensaje partido)
 *   - tocarBoton   { telefono, accion?, pedidoId?, botonId? } → click de botón inline
 *   - estado       { telefono }                    → pedido activo + últimos mensajes
 *   - reset        { telefono }                    → borra filas de ese teléfono de test
 */

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Cuántos ms atrasamos el created_at de la fila del cliente para evitar el
// defer (DEFER_THRESHOLD_MS = 5000). 10s da margen de sobra.
const ATRASO_CREATED_AT_MS = 10_000;

const PREFIJO_TEST = process.env.BOT_TEST_PREFIX || '54000';

// Igual que en el webhook: Meta manda "549..." y guardamos sin el 9.
function normalizarNumero(numero: string): string {
  if (numero.startsWith('549')) return '54' + numero.slice(3);
  return numero;
}

type RespuestaBot =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'botones'; texto: string; opciones: { id: string; title: string }[] };

// Convierte los bodies crudos capturados por postAMeta en respuestas legibles.
// Ignora los status de read/typing (no llevan `to`, ni siquiera se bufferean).
function parsearSalida(salida: SalidaCapturada[]): RespuestaBot[] {
  const respuestas: RespuestaBot[] = [];
  for (const s of salida) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = s.body as any;
    if (b?.type === 'text') {
      respuestas.push({ tipo: 'texto', texto: b.text?.body ?? '' });
    } else if (b?.type === 'interactive') {
      const opciones = (b.interactive?.action?.buttons ?? []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (x: any) => ({ id: x.reply?.id ?? '', title: x.reply?.title ?? '' }),
      );
      respuestas.push({ tipo: 'botones', texto: b.interactive?.body?.text ?? '', opciones });
    }
  }
  return respuestas;
}

async function leerPedido(telefono: string) {
  const { data } = await supabaseAdmin
    .from('pedidos')
    .select('*')
    .eq('telefono', telefono)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function leerMensajes(telefono: string, limite = 30) {
  const { data } = await supabaseAdmin
    .from('mensajes_chat')
    .select('id, rol, texto, tipo, procesado, descartado, created_at')
    .eq('telefono', telefono)
    .order('created_at', { ascending: true })
    .limit(limite);
  return data ?? [];
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 403 });
  }
  if (process.env.BOT_TEST_MODE !== '1') {
    return NextResponse.json(
      { error: 'BOT_TEST_MODE debe estar en "1" para usar este endpoint (garantiza que no se manden WhatsApp reales)' },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const { accion } = body as { accion?: string };
  const telefonoCrudo = (body as { telefono?: string }).telefono;

  if (!telefonoCrudo || typeof telefonoCrudo !== 'string') {
    return NextResponse.json({ error: 'falta "telefono"' }, { status: 400 });
  }
  const telefono = normalizarNumero(telefonoCrudo);

  // Aislamiento: solo teléfonos de test. Blinda contra borrar/escribir datos reales.
  if (!telefono.startsWith(PREFIJO_TEST)) {
    return NextResponse.json(
      { error: `el teléfono debe empezar con el prefijo de test "${PREFIJO_TEST}" (recibido "${telefono}")` },
      { status: 400 },
    );
  }

  try {
    switch (accion) {
      case 'reset': {
        await supabaseAdmin.from('mensajes_chat').delete().eq('telefono', telefono);
        await supabaseAdmin.from('pedidos').delete().eq('telefono', telefono);
        await supabaseAdmin.from('atencion_humana').delete().eq('telefono', telefono);
        drenarSalidaTest(telefono);
        return NextResponse.json({ ok: true, accion: 'reset', telefono });
      }

      case 'estado': {
        const [pedido, mensajes] = await Promise.all([leerPedido(telefono), leerMensajes(telefono)]);
        return NextResponse.json({ ok: true, telefono, pedido, mensajes });
      }

      case 'enviarTexto': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = (body as any);
        const textos: string[] = Array.isArray(raw.textos)
          ? raw.textos.map((t: unknown) => String(t))
          : [String(raw.texto ?? '')];
        if (textos.every((t) => t.trim() === '')) {
          return NextResponse.json({ error: 'falta "texto" o "textos"' }, { status: 400 });
        }
        const respuestas = await inyectarTextoYProcesar(telefono, textos);
        const pedido = await leerPedido(telefono);
        return NextResponse.json({ ok: true, telefono, respuestas, pedido });
      }

      case 'tocarBoton': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = (body as any);
        const botonId: string | undefined = raw.botonId;

        // Botón de respuesta rápida (falta un solo dato): el click ES el dato.
        // Se mapea a su texto canónico y va por el pipeline de texto, igual que
        // el webhook. Solo aplica si vino botonId.
        if (botonId && RESPUESTAS_RAPIDAS[botonId]) {
          const respuestas = await inyectarTextoYProcesar(telefono, [RESPUESTAS_RAPIDAS[botonId]]);
          const pedido = await leerPedido(telefono);
          return NextResponse.json({ ok: true, telefono, respuestas, pedido, via: 'respuesta_rapida' });
        }

        let accionBoton: BotonAccion;
        let pedidoId: number;
        if (botonId) {
          const parsed = parsearBotonId(botonId);
          if (!parsed) {
            return NextResponse.json({ error: `botonId no reconocido: "${botonId}"` }, { status: 400 });
          }
          accionBoton = parsed.accion;
          pedidoId = parsed.pedidoId;
        } else {
          // `botonAccion` (no `accion`): `accion` ya es el discriminador del endpoint.
          accionBoton = raw.botonAccion as BotonAccion;
          pedidoId = Number(raw.pedidoId);
          if (!accionBoton || !Number.isFinite(pedidoId) || pedidoId <= 0) {
            return NextResponse.json({ error: 'tocarBoton necesita { botonAccion, pedidoId } o { botonId }' }, { status: 400 });
          }
        }

        drenarSalidaTest(telefono);
        await ejecutarBoton(telefono, accionBoton, pedidoId);
        const respuestas = parsearSalida(drenarSalidaTest(telefono));
        const pedido = await leerPedido(telefono);
        return NextResponse.json({ ok: true, telefono, respuestas, pedido });
      }

      default:
        return NextResponse.json({ error: `acción desconocida: "${accion}"` }, { status: 400 });
    }
  } catch (error) {
    console.error('❌ Error en /api/dev/simular-conversacion:', error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 200 });
  }
}

/**
 * Inserta la(s) fila(s) del cliente (backdated) y corre el bot real, devolviendo
 * las respuestas parseadas. Compartido por enviarTexto y las respuestas rápidas.
 */
async function inyectarTextoYProcesar(telefono: string, textos: string[]): Promise<RespuestaBot[]> {
  const ahora = Date.now();
  const filas = textos
    .filter((t) => t.trim() !== '')
    .map((texto, i) => ({
      telefono,
      texto,
      rol: 'cliente',
      procesado: false,
      // wa_message_id único y sintético (respeta el índice único idempotente).
      wa_message_id: `test-${telefono}-${ahora}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      // Atrasado para superar el defer; +i preserva el orden dentro del batch.
      created_at: new Date(ahora - ATRASO_CREATED_AT_MS + i).toISOString(),
    }));

  drenarSalidaTest(telefono); // descarta cualquier salida stale de un turno previo
  const { error } = await supabaseAdmin.from('mensajes_chat').insert(filas);
  if (error) throw new Error(`insert mensajes_chat: ${error.message}`);

  await procesarMensajesDeCliente(telefono);

  return parsearSalida(drenarSalidaTest(telefono));
}

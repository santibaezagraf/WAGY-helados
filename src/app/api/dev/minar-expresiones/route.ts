import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import {
  normalizarTextoShortCircuit,
  CONFIRMACIONES,
  NEGACIONES,
  SALUDOS,
  mencionaRetiro,
  mencionaRechazoCancelacion,
  mencionaMetodoPagoNoSoportado,
  mencionaCantidadEnUnidadNoSoportada,
} from '@/lib/bot/procesar';

/**
 * Endpoint de DESARROLLO para minar expresiones frecuentes de los clientes y
 * proponer ampliaciones a los sets del short-circuit (CONFIRMACIONES / NEGACIONES
 * / SALUDOS).
 *
 * SE BLOQUEA en producción (NODE_ENV === 'production').
 *
 * Idea (ver la charla sobre "aprender" los sets): el LLM ya generaliza a
 * expresiones nuevas; los sets son solo una optimización para cortar antes del
 * LLM en los casos triviales. Entonces lo útil NO es entrenar un modelo, sino
 * descubrir qué formas CORTAS y FRECUENTES caen hoy a través de TODAS las redes
 * deterministas (y llegan al LLM), para sumarlas al set con revisión humana —
 * una entrada mala en CONFIRMACIONES auto-confirmaría pedidos que el cliente
 * rechaza.
 *
 * Redes deterministas de texto que el sistema ya tiene (y que este endpoint usa
 * para NO proponer lo ya cubierto):
 *   - Sets exact-match del short-circuit: CONFIRMACIONES / NEGACIONES / SALUDOS
 *   - mencionaRetiro (paso a retirar / lo busco / paso por el local)
 *   - mencionaRechazoCancelacion (no lo cancelo / dejalo / mantenelo)
 *   - mencionaMetodoPagoNoSoportado (tarjeta / débito / crédito / posnet / rapipago)
 *   - mencionaCantidadEnUnidadNoSoportada (kilo / gramo / pote / porción / bola)
 *   (pareceDireccion queda fuera porque exige un número, y las formas con dígitos
 *    ya se descartan como "dato del pedido").
 *
 * Qué hace: toma los mensajes de clientes, los normaliza igual que el
 * short-circuit, descarta los que ya cubre alguna red y los que son datos del
 * pedido (tienen números), y devuelve las formas cortas más repetidas que hoy
 * caen al LLM.
 *
 * Params (query string):
 *   dias=90          ventana hacia atrás (default 90)
 *   maxPalabras=4    descarta mensajes con más de N palabras (el short-circuit
 *                    solo matchea mensajes cortos). Default 4.
 *   minCount=2       frecuencia mínima para listar un candidato. Default 2.
 *   limit=50         máximo de candidatos a devolver. Default 50.
 */

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const YA_CUBIERTO_SHORT_CIRCUIT = new Set<string>([...CONFIRMACIONES, ...NEGACIONES, ...SALUDOS]);

// Redes por regex sobre el texto crudo. Devuelve el nombre de la primera que
// matchea, o null. Sirve para no proponer como candidato algo que ya se maneja.
function cubiertaPorRedRegex(forma: string): string | null {
  if (mencionaRetiro(forma)) return 'mencionaRetiro';
  if (mencionaRechazoCancelacion(forma)) return 'mencionaRechazoCancelacion';
  if (mencionaMetodoPagoNoSoportado(forma)) return 'mencionaMetodoPagoNoSoportado';
  if (mencionaCantidadEnUnidadNoSoportada(forma)) return 'mencionaCantidadEnUnidadNoSoportada';
  return null;
}

// Hint de a qué set podría ir un candidato. Conservador: solo sugiere cuando hay
// una pista clara; si no, deja "revisar" para que lo decida el humano.
function sugerirSet(forma: string): string {
  const palabras = forma.split(' ');
  if (/\b(hola|ola|buenas|buen|hello|hi|hey|ey)\b/.test(forma)) return 'SALUDOS';
  if (palabras[0] === 'no' || /\bnop|nope|nah\b/.test(forma)) return 'NEGACIONES';
  return 'revisar';
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev only' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const dias = Math.max(1, parseInt(params.get('dias') || '90', 10));
  const maxPalabras = Math.max(1, parseInt(params.get('maxPalabras') || '4', 10));
  const minCount = Math.max(1, parseInt(params.get('minCount') || '2', 10));
  const limit = Math.max(1, parseInt(params.get('limit') || '50', 10));

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

  // Traemos todos los mensajes de clientes en la ventana. Paginamos porque
  // Supabase corta en 1000 por request.
  const mensajes: string[] = [];
  const PAGINA = 1000;
  for (let offset = 0; ; offset += PAGINA) {
    const { data, error } = await supabaseAdmin
      .from('mensajes_chat')
      .select('texto')
      .eq('rol', 'cliente')
      .gte('created_at', desde)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGINA - 1);

    if (error) {
      console.error('❌ Error consultando mensajes_chat:', error);
      return NextResponse.json({ error: 'Error interno', detalle: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    for (const m of data) if (m.texto) mensajes.push(m.texto);
    if (data.length < PAGINA) break;
  }

  // Normalizamos y contamos frecuencias de las formas candidatas. Vamos llevando
  // aparte cuántas descartamos por estar YA cubiertas por una red regex (para
  // transparencia: muestra que esas redes están trabajando).
  const conteo = new Map<string, number>();
  const excluidasPorRed: Record<string, number> = {};
  for (const texto of mensajes) {
    const n = normalizarTextoShortCircuit(texto);
    if (!n) continue;
    if (/\d/.test(n)) continue;                          // tiene números => dato del pedido, no expresión
    if (n.split(' ').length > maxPalabras) continue;     // demasiado largo para short-circuit
    if (YA_CUBIERTO_SHORT_CIRCUIT.has(n)) continue;      // ya lo corta el short-circuit

    const red = cubiertaPorRedRegex(n);
    if (red) {                                           // ya lo maneja una red regex
      excluidasPorRed[red] = (excluidasPorRed[red] ?? 0) + 1;
      continue;
    }

    conteo.set(n, (conteo.get(n) ?? 0) + 1);
  }

  const candidatos = [...conteo.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([forma, count]) => ({ forma, count, sugerencia: sugerirSet(forma) }));

  return NextResponse.json({
    ok: true,
    parametros: { dias, maxPalabras, minCount, limit },
    totalMensajesCliente: mensajes.length,
    formasUnicasCandidatas: conteo.size,
    excluidasPorRed,
    candidatos,
  });
}

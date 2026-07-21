import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { getRateLimitResetAt } from './atencion-humana';

// Cliente service-role (igual que el resto del pipeline del bot): server-only,
// bypassa RLS.
const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Rate-limit anti-DoS por número. El debounce + claim atómico ya colapsan una
// ráfaga corta en UN solo batch (1 llamada al LLM), así que el vector real es un
// flood SOSTENIDO (un mensaje cada X segundos durante mucho rato), que dispara
// una llamada por batch y quema el presupuesto de tokens de Groq. Por eso lo
// medimos en ventana LARGA (mensajes/hora), no ráfaga: una conversación real usa
// ~10-15 mensajes en toda la charla, así que 40/hora deja margen de sobra para el
// cliente más indeciso y aun así corta un flood en minutos.
export const RATE_LIMIT_VENTANA_MS = 60 * 60 * 1000; // 1 hora
export const RATE_LIMIT_MAX = 40;

/**
 * Pura y testeable: ¿la cantidad de mensajes del cliente en la ventana alcanza o
 * supera el tope? (>= porque contamos ANTES de insertar el mensaje actual, así
 * que `cantidadEnVentana` son los mensajes previos: al llegar al tope, el
 * siguiente ya se frena.)
 */
export function superaRateLimit(
  cantidadEnVentana: number,
  limite: number = RATE_LIMIT_MAX,
): boolean {
  return cantidadEnVentana >= limite;
}

/**
 * Pura y testeable: desde qué instante (ms) contar mensajes. Es el más reciente
 * entre el inicio de la ventana deslizante y el watermark de reset manual — así
 * un "resetear" (watermark = now) hace que el conteo ignore todo lo anterior y el
 * número deje de estar limitado al instante.
 */
export function calcularDesdeRateLimitMs(
  ahoraMs: number,
  resetAt: string | null,
  ventanaMs: number = RATE_LIMIT_VENTANA_MS,
): number {
  const inicioVentana = ahoraMs - ventanaMs;
  const resetMs = resetAt ? new Date(resetAt).getTime() : 0;
  return Math.max(inicioVentana, resetMs);
}

/**
 * I/O: cuenta los mensajes rol='cliente' de este teléfono dentro de la ventana y
 * decide si está rate-limiteado.
 *
 * Fail-OPEN a propósito (a diferencia de los gates de auth, que son fail-closed):
 * si el conteo falla por un problema nuestro, preferimos atender a un cliente
 * real antes que bloquearlo. El DoS es un riesgo acotado; perder un pedido
 * legítimo por un glitch de conteo, no. Además un error acá suele significar que
 * la DB está caída, en cuyo caso el bot no responde igual.
 */
export async function estaRateLimiteado(telefono: string): Promise<boolean> {
  // El watermark de reset (si el staff reseteó a mano) corre el inicio del
  // conteo hacia adelante, así el número se "desbloquea" sin esperar la ventana.
  const resetAt = await getRateLimitResetAt(telefono);
  const desde = new Date(calcularDesdeRateLimitMs(Date.now(), resetAt)).toISOString();
  const { count, error } = await supabaseAdmin
    .from('mensajes_chat')
    .select('id', { count: 'exact', head: true })
    .eq('telefono', telefono)
    .eq('rol', 'cliente')
    .gte('created_at', desde);

  if (error) {
    console.error('⚠️ Error contando mensajes para rate-limit (fail-open):', error);
    return false;
  }

  return superaRateLimit(count ?? 0);
}

import { createClient } from '@supabase/supabase-js';
import type { TipoUsoModelo } from '@/lib/bot/modelos';

// Cliente service-role (igual que el resto del pipeline del bot): server-only,
// bypassa RLS. SIN tipar con Database a propósito: `alertas_modelo`/`uso_modelo`
// son tablas nuevas que todavía no están en src/types/supabase.ts (no corrimos
// update-types), misma decisión que atencion-humana.ts. El dashboard las lee con
// service-role también (server action), así que no hace falta regenerar tipos.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Pura y testeable: dado el índice del modelo que se agotó (429) y la cadena de
 * modelos, devuelve el nombre del SIGUIENTE modelo (el fallback que se va a usar)
 * o `null` si era el último de la cadena — en ese caso toda la cadena quedó sin
 * cuota y el cliente se queda sin respuesta ese turno (la alerta más grave).
 */
export function siguienteModelo(
  idxAgotado: number,
  modelos: readonly string[],
): string | null {
  return modelos[idxAgotado + 1] ?? null;
}

/**
 * I/O: registra un salto de fallback de modelo para que el dashboard lo muestre.
 *
 * Fail-OPEN a propósito (como el rate-limit, y a diferencia de los gates de auth):
 * esto es telemetría de ops, NO parte del flujo del pedido. Si el insert falla no
 * debe romper ni frenar la respuesta al cliente (que además ya está en un camino
 * degradado por el 429), así que tragamos el error y solo lo logueamos. No se
 * `await`ea de forma bloqueante en el hot path — el llamador la dispara y sigue.
 */
export async function registrarAlertaFallback(
  modeloAgotado: string,
  modeloFallback: string | null,
  telefono: string | null,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('alertas_modelo').insert({
      modelo_agotado: modeloAgotado,
      modelo_fallback: modeloFallback,
      telefono,
    });
    if (error) {
      console.error('⚠️ No se pudo registrar la alerta de fallback (se ignora):', error.message);
    }
  } catch (e) {
    console.error('⚠️ Excepción registrando alerta de fallback (se ignora):', e);
  }
}

/** Forma del `usage` que devuelve el AI SDK (v6). Los campos pueden faltar. */
export type UsoTokens = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/**
 * I/O: registra el consumo de tokens de UNA llamada LLM exitosa, para que la
 * página de estado de modelos muestre cuánto se lleva usado del TPD diario.
 *
 * Fail-OPEN y fire-and-forget (misma filosofía que `registrarAlertaFallback`):
 * es telemetría de ops, no parte del flujo del pedido. El llamador la dispara con
 * `void` y sigue; un fallo acá jamás debe frenar ni romper la respuesta al cliente.
 * Solo se llama en el camino de éxito (un 429 no trae `usage`).
 */
export async function registrarUsoModelo(
  modelo: string,
  tipo: TipoUsoModelo,
  usage: UsoTokens | null | undefined,
  telefono: string | null,
): Promise<void> {
  try {
    const input = Math.max(0, Math.round(usage?.inputTokens ?? 0));
    const output = Math.max(0, Math.round(usage?.outputTokens ?? 0));
    // Si el SDK no reporta total, lo derivamos de input+output.
    const total = Math.max(0, Math.round(usage?.totalTokens ?? input + output));
    const { error } = await supabaseAdmin.from('uso_modelo').insert({
      modelo,
      tipo,
      tokens_input: input,
      tokens_output: output,
      tokens_total: total,
      telefono,
    });
    if (error) {
      console.error('⚠️ No se pudo registrar el uso de modelo (se ignora):', error.message);
    }
  } catch (e) {
    console.error('⚠️ Excepción registrando uso de modelo (se ignora):', e);
  }
}

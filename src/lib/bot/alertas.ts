import { createClient } from '@supabase/supabase-js';

// Cliente service-role (igual que el resto del pipeline del bot): server-only,
// bypassa RLS. SIN tipar con Database a propósito: `alertas_modelo` es una tabla
// nueva que todavía no está en src/types/supabase.ts (no corrimos update-types),
// misma decisión que atencion-humana.ts. El dashboard la lee con service-role
// también (server action), así que no hace falta regenerar tipos para compilar.
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

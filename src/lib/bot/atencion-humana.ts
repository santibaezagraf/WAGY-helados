// Toma humana: pausa del bot por teléfono.
//
// Mientras un operador maneja la conversación manualmente desde el dashboard,
// el bot NO debe auto-responder. Esta es la fuente de verdad de ese estado:
//  - el webhook (manejarTexto) consulta `atencionHumanaActiva` antes de agendar
//    el wake-up en QStash → si está activa, guarda el mensaje del cliente como
//    procesado=true (visible en el chat, invisible para el bot) y no agenda nada.
//  - `procesarMensajesDeCliente` la re-chequea como defensa por si quedó un
//    wake-up agendado de antes de iniciar la toma.
//
// Auto-expira a las VENTANA_TOMA_MS desde el último toque: si un operador se
// olvida de "devolver al bot", la conversación vuelve sola al bot pasado ese
// plazo, sin necesidad de un contador ni un cron (mismo patrón de ventana por
// tiempo que usa resumen_pendiente).

import { createClient } from '@supabase/supabase-js';

// Cliente service-role SIN el genérico <Database>: la tabla `atencion_humana`
// puede no estar todavía en los tipos generados (update-types se corre después
// de aplicar la migración). Es una tabla chica de uso interno; no tiparla acá
// evita acoplar el build a la regeneración de tipos.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Ventana de auto-expiración de una toma humana olvidada (12h).
export const VENTANA_TOMA_MS = 12 * 60 * 60 * 1000;

/** True si hay una toma humana activa y vigente (no expirada) para el teléfono. */
export async function atencionHumanaActiva(telefono: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('atencion_humana')
    .select('activa, updated_at')
    .eq('telefono', telefono)
    .maybeSingle();

  if (error) {
    // Ante un fallo de lectura no pausamos el bot: preferimos que conteste de
    // más antes que dejar al cliente sin respuesta por un error de infra.
    console.error(`⚠️ No se pudo leer atencion_humana para ${telefono}:`, error.message);
    return false;
  }

  if (!data || !data.activa) return false;

  const venceMs = new Date(data.updated_at).getTime() + VENTANA_TOMA_MS;
  return Date.now() < venceMs;
}

/** Activa (o renueva) la toma humana para el teléfono. */
export async function activarAtencionHumana(telefono: string): Promise<void> {
  // Al tomar la conversación, el aviso de "requiere intervención" ya se cumplió:
  // lo limpiamos en el mismo upsert.
  const { error } = await supabaseAdmin
    .from('atencion_humana')
    .upsert(
      { telefono, activa: true, updated_at: new Date().toISOString(), requiere_atencion: false, requiere_atencion_at: null },
      { onConflict: 'telefono' },
    );

  if (error) console.error(`⚠️ No se pudo activar atencion_humana para ${telefono}:`, error.message);
}

/**
 * Marca que un teléfono recibió algo que el bot no puede resolver (un media,
 * una ubicación) y que requiere que una persona intervenga desde el dashboard.
 * Lo levanta el webhook cuando NO hay toma humana activa.
 */
export async function marcarRequiereAtencion(telefono: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('atencion_humana')
    .upsert(
      { telefono, requiere_atencion: true, requiere_atencion_at: new Date().toISOString() },
      { onConflict: 'telefono' },
    );

  if (error) console.error(`⚠️ No se pudo marcar requiere_atencion para ${telefono}:`, error.message);
}

/** Limpia el aviso (el operador ya lo vio). No crea fila si no existía. */
export async function limpiarRequiereAtencion(telefono: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('atencion_humana')
    .update({ requiere_atencion: false, requiere_atencion_at: null })
    .eq('telefono', telefono);

  if (error) console.error(`⚠️ No se pudo limpiar requiere_atencion para ${telefono}:`, error.message);
}

/** Teléfonos que esperan intervención humana (para el badge y el contador del dashboard). */
export async function telefonosRequierenAtencion(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('atencion_humana')
    .select('telefono')
    .eq('requiere_atencion', true);

  if (error) {
    console.error('⚠️ No se pudo leer los teléfonos con requiere_atencion:', error.message);
    return [];
  }
  return (data ?? []).map((r: { telefono: string }) => r.telefono);
}

/** Desactiva la toma humana (devolver la conversación al bot). */
export async function desactivarAtencionHumana(telefono: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('atencion_humana')
    .upsert({ telefono, activa: false, updated_at: new Date().toISOString() }, { onConflict: 'telefono' });

  if (error) console.error(`⚠️ No se pudo desactivar atencion_humana para ${telefono}:`, error.message);
}

/** Estado crudo (para el banner del modal): activa y vigente. */
export async function estadoAtencion(telefono: string): Promise<{ activa: boolean }> {
  return { activa: await atencionHumanaActiva(telefono) };
}

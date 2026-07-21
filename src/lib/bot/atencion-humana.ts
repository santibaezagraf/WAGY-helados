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
// Auto-expira a las VENTANA_TOMA_MS desde la ÚLTIMA ACTIVIDAD (no solo desde el
// último toque del operador): tanto el envío del operador como los mensajes
// entrantes del cliente refrescan `updated_at` vía `tocarAtencionHumana`. Sin
// eso, con una ventana de 8h una conversación activa podría "expirar" mientras
// el cliente sigue escribiendo y el bot volvería a responder en el medio. El
// cierre del modal ya NO devuelve al bot: la toma solo termina con el botón
// explícito "Devolver al bot", con el envío del resumen manual, o por este
// timeout de inactividad.

import { createClient } from '@supabase/supabase-js';

// Cliente service-role SIN el genérico <Database>: la tabla `atencion_humana`
// puede no estar todavía en los tipos generados (update-types se corre después
// de aplicar la migración). Es una tabla chica de uso interno; no tiparla acá
// evita acoplar el build a la regeneración de tipos.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Ventana de auto-expiración de una toma humana olvidada (8h desde la última
// actividad: cualquier mensaje del cliente o del operador refresca `updated_at`
// vía tocarAtencionHumana).
export const VENTANA_TOMA_MS = 8 * 60 * 60 * 1000;

// Ventana del gate por mensajes: si el último mensaje saliente de un OPERADOR
// (rol='operador') tiene menos que esto, la conversación se considera "en manos
// humanas" aunque la toma no esté activa (ej: falló el upsert de activación).
export const VENTANA_MENSAJE_OPERADOR_MS = 6 * 60 * 60 * 1000;

/**
 * Decisión pura del gate por mensajes (testeable sin DB): ¿debe callarse el
 * bot porque un operador habló hace poco?
 *
 *  - Sin mensaje de operador en la ventana → no.
 *  - Con mensaje reciente, PERO el operador devolvió la conversación al bot
 *    DESPUÉS de ese mensaje (fila atencion_humana con activa=false y
 *    updated_at posterior) → no: la devolución explícita gana.
 *  - En cualquier otro caso → sí (aunque la fila diga activa=true expirada o
 *    directamente no exista: el mensaje es la evidencia).
 */
export function debeSilenciarBotPorOperador(
  ultimoMensajeOperadorAt: string | null,
  atencion: { activa: boolean; updated_at: string } | null,
  ahoraMs: number,
): boolean {
  if (!ultimoMensajeOperadorAt) return false;

  const mensajeMs = new Date(ultimoMensajeOperadorAt).getTime();
  if (ahoraMs - mensajeMs > VENTANA_MENSAJE_OPERADOR_MS) return false;

  const devolvioAlBotDespues =
    atencion != null &&
    !atencion.activa &&
    new Date(atencion.updated_at).getTime() >= mensajeMs;

  return !devolvioAlBotDespues;
}

/**
 * Gate por mensajes: true si el último mensaje saliente hacia este cliente lo
 * mandó un OPERADOR hace menos de VENTANA_MENSAJE_OPERADOR_MS y no hubo una
 * devolución explícita al bot después. Es la red de seguridad de la toma
 * humana: deriva el estado de los mensajes mismos, así que cubre el caso en
 * que `activarAtencionHumana` falló y la conversación quedó sin flag.
 * Se ignoran mensajes descartados (conversaciones ya cerradas).
 */
export async function intervencionHumanaReciente(telefono: string): Promise<boolean> {
  const desde = new Date(Date.now() - VENTANA_MENSAJE_OPERADOR_MS).toISOString();

  const { data: ultimoOperador, error } = await supabaseAdmin
    .from('mensajes_chat')
    .select('created_at')
    .eq('telefono', telefono)
    .eq('rol', 'operador')
    .eq('descartado', false)
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Mismo criterio que atencionHumanaActiva: ante un fallo de lectura no
    // silenciamos al bot.
    console.error(`⚠️ No se pudo leer el último mensaje de operador para ${telefono}:`, error.message);
    return false;
  }
  if (!ultimoOperador) return false;

  const { data: atencion } = await supabaseAdmin
    .from('atencion_humana')
    .select('activa, updated_at')
    .eq('telefono', telefono)
    .maybeSingle();

  return debeSilenciarBotPorOperador(
    ultimoOperador.created_at as string,
    (atencion as { activa: boolean; updated_at: string } | null) ?? null,
    Date.now(),
  );
}

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

/**
 * Refresca `updated_at` de una toma humana YA activa, sin cambiar el flag.
 * Lo llama el webhook cuando entra un mensaje del cliente con toma activa: así
 * la ventana de auto-expiración (VENTANA_TOMA_MS) se mide desde la última
 * actividad real de la conversación, no desde el último envío del operador.
 * Si la fila no existe (nunca hubo toma) o `activa=false`, no hace nada.
 */
export async function tocarAtencionHumana(telefono: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('atencion_humana')
    .update({ updated_at: new Date().toISOString() })
    .eq('telefono', telefono)
    .eq('activa', true);

  if (error) console.error(`⚠️ No se pudo tocar atencion_humana para ${telefono}:`, error.message);
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

/**
 * Teléfonos con toma humana ACTIVA y vigente (no expirada). Alimenta el estado
 * inicial del componente de notificaciones en el dashboard: sin este set, el
 * cliente no sabría qué mensajes entrantes disparan el toast "hay actividad
 * mientras vos estás afuera del chat".
 */
export async function telefonosConTomaActiva(): Promise<string[]> {
  const desde = new Date(Date.now() - VENTANA_TOMA_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('atencion_humana')
    .select('telefono')
    .eq('activa', true)
    .gte('updated_at', desde);

  if (error) {
    console.error('⚠️ No se pudo leer los teléfonos con toma activa:', error.message);
    return [];
  }
  return (data ?? []).map((r: { telefono: string }) => r.telefono);
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

// ── Moderación manual: bloqueo persistente + reset del rate-limit ───────────
//
// Ambos se guardan en atencion_humana (mismas columnas por teléfono). Se
// disparan a mano desde el modal de chat vía server actions; el webhook los lee.

/**
 * True si el staff bloqueó manualmente este teléfono. Fail-OPEN ante un error de
 * lectura (o si la columna todavía no está migrada): preferimos NO bloquear —
 * mismo criterio que el resto del módulo, un fallo nuestro no debe dejar mudo al
 * bot para un cliente legítimo.
 */
export async function estaBloqueado(telefono: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('atencion_humana')
    .select('bloqueado')
    .eq('telefono', telefono)
    .maybeSingle();

  if (error) {
    console.error(`⚠️ No se pudo leer bloqueado para ${telefono}:`, error.message);
    return false;
  }
  return Boolean((data as { bloqueado?: boolean } | null)?.bloqueado);
}

/** Bloquea manualmente un teléfono (persistente hasta desbloquear). */
export async function bloquearNumero(telefono: string): Promise<void> {
  // upsert con onConflict → solo toca la columna `bloqueado`; no pisa activa /
  // updated_at (no queremos alterar la ventana de expiración de una toma).
  const { error } = await supabaseAdmin
    .from('atencion_humana')
    .upsert({ telefono, bloqueado: true }, { onConflict: 'telefono' });

  if (error) console.error(`⚠️ No se pudo bloquear ${telefono}:`, error.message);
}

/** Quita el bloqueo manual (el bot vuelve a responderle). */
export async function desbloquearNumero(telefono: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('atencion_humana')
    .upsert({ telefono, bloqueado: false }, { onConflict: 'telefono' });

  if (error) console.error(`⚠️ No se pudo desbloquear ${telefono}:`, error.message);
}

/**
 * Resetea el rate-limit anti-DoS de un teléfono: pone el watermark en now(), así
 * el conteo por hora solo mira mensajes POSTERIORES → el número deja de estar
 * limitado de inmediato, sin esperar a que la ventana de 1h se vacíe sola.
 */
export async function resetearRateLimit(telefono: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('atencion_humana')
    .upsert({ telefono, rate_limit_reset_at: new Date().toISOString() }, { onConflict: 'telefono' });

  if (error) console.error(`⚠️ No se pudo resetear el rate-limit de ${telefono}:`, error.message);
}

/** Watermark de reset del rate-limit (null si nunca se reseteó / error de lectura). */
export async function getRateLimitResetAt(telefono: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('atencion_humana')
    .select('rate_limit_reset_at')
    .eq('telefono', telefono)
    .maybeSingle();

  if (error) {
    console.error(`⚠️ No se pudo leer rate_limit_reset_at para ${telefono}:`, error.message);
    return null;
  }
  return (data as { rate_limit_reset_at?: string | null } | null)?.rate_limit_reset_at ?? null;
}

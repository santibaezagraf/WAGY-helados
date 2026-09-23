import { createClient } from '@supabase/supabase-js'
import type { Sesion } from '@/lib/auth-rol'
import type { AccionActividad } from '@/lib/actividad-texto'

/**
 * Registro de actividad de los usuarios del dashboard: es lo que alimenta el
 * ranking, el heatmap y el historial de /perfil.
 *
 * Cliente service-role SIN tipar con Database a propósito. Misma decisión que
 * alertas.ts / atencion-humana.ts: mientras la migración de roles no esté
 * aplicada en TODAS las bases, un `update-types` corrido contra una que no la
 * tenga borraría `actividad_usuario` de los tipos y rompería el build. Sin el
 * genérico compila igual, y la tabla se lee y escribe siempre con service-role.
 */
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type DatosActividad = {
  /** Pedidos afectados. En una acción masiva, cuántos. Default 1. */
  cantidad?: number
  /** Pedido puntual, cuando la acción es sobre uno solo. */
  pedidoId?: number
  /** Contexto para armar el texto del historial (ver armarTextoActividad). */
  detalle?: Record<string, unknown>
}

/**
 * Registra una acción del usuario.
 *
 * Fail-OPEN a propósito, igual que registrarAlertaFallback: esto es telemetría,
 * no parte del flujo de trabajo. Si el insert falla, la acción del usuario (que
 * YA se ejecutó) no se debe romper ni demorar — se traga el error y se loguea.
 *
 * Por el mismo motivo NO se `await`ea de forma bloqueante desde el hot path: el
 * llamador la dispara y sigue.
 */
export function registrarActividad(
  sesion: Sesion,
  accion: AccionActividad,
  datos: DatosActividad = {},
): void {
  void (async () => {
    try {
      const { error } = await supabaseAdmin.from('actividad_usuario').insert({
        usuario_id: sesion.userId,
        usuario_nombre: sesion.nombre,
        accion,
        cantidad: datos.cantidad ?? 1,
        pedido_id: datos.pedidoId ?? null,
        detalle: datos.detalle ?? null,
      })
      if (error) {
        console.error('⚠️ No se pudo registrar la actividad (se ignora):', error.message)
      }
    } catch (e) {
      console.error('⚠️ Excepción registrando actividad (se ignora):', e)
    }
  })()
}

/**
 * Lógica PURA de la gestión de borradores silenciosos (recordatorio +
 * auto-rechazo). El endpoint /api/gestionar-borradores hace las queries y los
 * envíos; la decisión de qué hacer con cada borrador vive acá para poder
 * testearla sin DB ni red (mismo patrón que conversaciones-utils.ts).
 */

// Minutos de silencio del cliente antes de mandar el "¿seguís ahí?". Mismo
// umbral que usaba la vieja auto-confirmación.
export const RECORDATORIO_SILENCIO_MIN = 20;
// Horas sin confirmar tras las cuales el borrador se cancela solo.
export const AUTO_RECHAZO_HORAS = 6;
// Solo avisamos la cancelación de borradores razonablemente recientes: a un
// zombie de días no tiene sentido escribirle (y Meta rechaza fuera de la
// ventana de 24h igual). El pedido se cancela en DB de todos modos.
export const AVISO_CANCELACION_HORAS = 12;

/**
 * Un borrador está completo cuando tiene dirección, pago y alguna cantidad.
 * Los borradores parciales usan '' de placeholder en las columnas NOT NULL
 * que faltan (ver CLAUDE.md > estado borrador), por eso alcanza la falsy-ness.
 */
export function esBorradorCompleto(p: {
  direccion: string;
  metodo_pago: string;
  cantidad_agua: number;
  cantidad_crema: number;
}): boolean {
  return Boolean(p.direccion && p.metodo_pago && (p.cantidad_agua > 0 || p.cantidad_crema > 0));
}

export type DecisionBorrador =
  | { accion: 'recordar' }
  | { accion: 'rechazar'; avisarCliente: boolean }
  | { accion: 'nada' };

/**
 * Decide qué hacer con un borrador en un tick del cron:
 *
 * - 'rechazar' si superó AUTO_RECHAZO_HORAS (avisarCliente solo si es
 *   razonablemente reciente). Aplica también a borradores parciales: es la
 *   limpieza de los abandonados.
 * - 'recordar' si es COMPLETO (a un parcial no tiene sentido ofrecerle
 *   "confirmar" — el bot ya le pidió lo que falta), no se le recordó antes y
 *   el cliente lleva >= RECORDATORIO_SILENCIO_MIN callado.
 * - 'nada' en cualquier otro caso. Con mensajes sin procesar (wake-up de
 *   QStash en vuelo) siempre es 'nada': ese flow decide, no le pisamos el
 *   resultado.
 */
export function decidirAccionBorrador(params: {
  msDesdeCreacion: number;
  esCompleto: boolean;
  recordatorioEnviado: boolean;
  clienteActivoReciente: boolean;
  hayMensajesEnVuelo: boolean;
}): DecisionBorrador {
  if (params.hayMensajesEnVuelo) return { accion: 'nada' };

  if (params.msDesdeCreacion >= AUTO_RECHAZO_HORAS * 60 * 60 * 1000) {
    return {
      accion: 'rechazar',
      avisarCliente: params.msDesdeCreacion < AVISO_CANCELACION_HORAS * 60 * 60 * 1000,
    };
  }

  if (params.esCompleto && !params.recordatorioEnviado && !params.clienteActivoReciente) {
    return { accion: 'recordar' };
  }

  return { accion: 'nada' };
}

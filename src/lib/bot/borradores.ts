/**
 * Lógica PURA de la gestión de borradores silenciosos (recordatorio +
 * auto-rechazo). El endpoint /api/gestionar-borradores hace las queries y los
 * envíos; la decisión de qué hacer con cada borrador vive acá para poder
 * testearla sin DB ni red (mismo patrón que conversaciones-utils.ts).
 */

// Minutos de silencio del cliente antes de mandar el "¿seguís ahí?" de un
// borrador COMPLETO (con los botones confirmar/modificar). Mismo umbral que
// usaba la vieja auto-confirmación.
export const RECORDATORIO_SILENCIO_MIN = 20;
// Minutos de silencio antes de re-pedir el dato faltante de un borrador PARCIAL
// (re-manda los botones de pago / el pedido de dirección, no "confirmar"). Más
// largo que el completo: el parcial exige que el cliente ESCRIBA, no solo toque
// un botón, así que conviene ser menos insistente.
export const RECORDATORIO_PARCIAL_SILENCIO_MIN = 60;
// Horas sin confirmar tras las cuales el borrador se cancela solo.
export const AUTO_RECHAZO_HORAS = 6;
// Solo avisamos la cancelación de borradores razonablemente recientes: a un
// zombie de días no tiene sentido escribirle (y Meta rechaza fuera de la
// ventana de 24h igual). El pedido se cancela en DB de todos modos.
export const AVISO_CANCELACION_HORAS = 12;
// Horas de silencio del cliente tras el "¿estás seguro que querés cancelar?"
// antes de respetar el pedido de cancelación y cancelar solos. La última
// voluntad expresada fue cancelar: es peor entregarle un pedido que el cliente
// creía cancelado que no entregarle uno cuya última indicación fue darlo de baja.
export const CANCELACION_SILENCIO_HORAS = 1;

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
  | { accion: 'recordar_parcial' }
  | { accion: 'rechazar'; avisarCliente: boolean }
  | { accion: 'nada' };

/**
 * Decide qué hacer con un borrador en un tick del cron:
 *
 * - 'rechazar' si el CLIENTE lleva >= AUTO_RECHAZO_HORAS callado (avisarCliente
 *   solo si el silencio es razonablemente corto — fuera de la ventana de 24h
 *   desde su último mensaje Meta rechaza el envío igual). Aplica también a
 *   borradores parciales: es la limpieza de los abandonados.
 *   OJO: se mide contra el SILENCIO, no contra la edad del borrador. Un pedido
 *   'pendiente' viejo que el cliente acaba de modificar vuelve a 'borrador'
 *   conservando su created_at original — medir por edad lo auto-rechazaba a los
 *   minutos, con el cliente activo y por responder el resumen.
 * - 'recordar' si es COMPLETO, no se le recordó antes y el cliente lleva
 *   >= RECORDATORIO_SILENCIO_MIN callado → "¿seguís ahí?" con confirmar/modificar.
 * - 'recordar_parcial' si es PARCIAL, no se le recordó antes y el cliente lleva
 *   >= RECORDATORIO_PARCIAL_SILENCIO_MIN callado → re-pide el dato faltante (a un
 *   parcial no tiene sentido ofrecerle "confirmar"; el bot re-manda lo que falta).
 * - 'nada' en cualquier otro caso. Con mensajes sin procesar (wake-up de
 *   QStash en vuelo) siempre es 'nada': ese flow decide, no le pisamos el
 *   resultado.
 *
 * Ambos recordatorios son one-shot (gateados por `recordatorioEnviado`, que solo
 * se re-arma cuando se manda un resumen nuevo, es decir cuando el borrador se
 * completa). `msSilencioCliente` es el tiempo desde el último mensaje del
 * cliente; si no hay ninguno (raro — un borrador siempre nace de un mensaje),
 * la edad del borrador acota el silencio por arriba y se usa de fallback.
 */
export function decidirAccionBorrador(params: {
  msDesdeCreacion: number;
  esCompleto: boolean;
  recordatorioEnviado: boolean;
  msSilencioCliente: number | null;
  hayMensajesEnVuelo: boolean;
}): DecisionBorrador {
  if (params.hayMensajesEnVuelo) return { accion: 'nada' };

  const silencio = params.msSilencioCliente ?? params.msDesdeCreacion;

  if (silencio >= AUTO_RECHAZO_HORAS * 60 * 60 * 1000) {
    return {
      accion: 'rechazar',
      avisarCliente: silencio < AVISO_CANCELACION_HORAS * 60 * 60 * 1000,
    };
  }

  if (params.recordatorioEnviado) return { accion: 'nada' };

  if (params.esCompleto) {
    if (silencio >= RECORDATORIO_SILENCIO_MIN * 60 * 1000) return { accion: 'recordar' };
  } else {
    if (silencio >= RECORDATORIO_PARCIAL_SILENCIO_MIN * 60 * 1000) return { accion: 'recordar_parcial' };
  }

  return { accion: 'nada' };
}

export type DecisionEsperandoCancelacion =
  | { accion: 'cancelar'; avisarCliente: boolean }
  | { accion: 'nada' };

/**
 * Decide qué hacer con un pedido colgado en 'esperando_cancelacion' (el bot
 * preguntó "¿estás seguro?" y el cliente nunca contestó):
 *
 * - 'cancelar' si el cliente lleva >= CANCELACION_SILENCIO_HORAS callado. Se
 *   RESPETA el pedido de cancelación aunque no se haya confirmado — la última
 *   indicación del cliente fue cancelar. `avisarCliente` solo si el silencio
 *   es razonablemente corto (misma ventana que los borradores; fuera de las
 *   24h Meta rechaza el envío igual).
 * - 'nada' si el cliente escribió hace poco (el flow normal va a resolver) o
 *   hay mensajes sin procesar (wake-up de QStash en vuelo: ese flow decide).
 */
export function decidirAccionEsperandoCancelacion(params: {
  msSilencioCliente: number;
  hayMensajesEnVuelo: boolean;
}): DecisionEsperandoCancelacion {
  if (params.hayMensajesEnVuelo) return { accion: 'nada' };

  if (params.msSilencioCliente >= CANCELACION_SILENCIO_HORAS * 60 * 60 * 1000) {
    return {
      accion: 'cancelar',
      avisarCliente: params.msSilencioCliente < AVISO_CANCELACION_HORAS * 60 * 60 * 1000,
    };
  }

  return { accion: 'nada' };
}

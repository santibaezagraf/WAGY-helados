import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { enviarMensajeWhatsApp, enviarResumenYPedirConfirmacion, mensajeConfirmacion } from '@/lib/whatsapp';
import { estaDespachado, marcarHistorialDescartado } from '@/lib/bot/procesar';

const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Acciones ejecutadas como respuesta a un click de botón.
 *
 * El webhook detecta `interactive.button_reply` y dispatchea acá, evitando
 * todo el pipeline de QStash + Groq porque la intención del cliente está
 * inequívocamente codificada en el button_id. Cada acción hace un UPDATE
 * atómico con guard sobre el estado esperado: si el pedido ya cambió de
 * estado entre el envío del botón y el click (auto-confirm del cron, race
 * con el repartidor, etc.), el UPDATE afecta 0 filas y mandamos un fallback.
 */

export type BotonAccion =
  | 'confirmar_borrador'
  | 'modificar_borrador'
  | 'confirmar_cancelacion'
  | 'rechazar_cancelacion';

/**
 * Botones de "respuesta rápida" que manda el bot cuando falta un solo dato
 * (ver procesar.ts > pedirDatosFaltantes). No codifican un pedidoId: el
 * webhook convierte el click en un mensaje de texto canónico que sigue el
 * pipeline normal (QStash + LLM), que es quien sabe fusionarlo con el pedido
 * en armado. Vive acá (y no en el route) para poder testear que sus ids nunca
 * colisionen con los que parsea parsearBotonId.
 */
export const RESPUESTAS_RAPIDAS: Record<string, string> = {
  resp_pago_efectivo: 'efectivo',
  resp_pago_transferencia: 'transferencia',
  resp_retira: 'paso a retirar',
};

/**
 * Parsea un button_id con formato "<accion>_<pedidoId>". Devuelve null si
 * el id no matchea ninguna de las acciones conocidas (no es un botón nuestro
 * o es de una versión vieja).
 */
export function parsearBotonId(buttonId: string): { accion: BotonAccion; pedidoId: number } | null {
  const acciones: BotonAccion[] = [
    'confirmar_borrador',
    'modificar_borrador',
    'confirmar_cancelacion',
    'rechazar_cancelacion',
  ];

  for (const accion of acciones) {
    const prefijo = `${accion}_`;
    if (buttonId.startsWith(prefijo)) {
      const pedidoId = Number(buttonId.slice(prefijo.length));
      if (Number.isFinite(pedidoId) && pedidoId > 0) {
        return { accion, pedidoId };
      }
    }
  }

  return null;
}

export async function ejecutarBoton(
  numeroCliente: string,
  accion: BotonAccion,
  pedidoId: number,
) {
  console.log(`🔘 Ejecutando acción de botón "${accion}" para pedido ${pedidoId} (cliente ${numeroCliente}).`);

  switch (accion) {
    case 'confirmar_borrador':
      return confirmarBorrador(numeroCliente, pedidoId);
    case 'modificar_borrador':
      return modificarBorrador(numeroCliente, pedidoId);
    case 'confirmar_cancelacion':
      return confirmarCancelacion(numeroCliente, pedidoId);
    case 'rechazar_cancelacion':
      return rechazarCancelacion(numeroCliente, pedidoId);
  }
}

/**
 * Busca el borrador COMPLETO más reciente del cliente (los mismos guards de
 * completitud que exige confirmarBorrador). Se usa como red de seguridad cuando
 * el click apunta a un pedido que ya no es confirmable: si el cliente tiene otro
 * borrador esperando confirmación (resumen superado, botón viejo del scroll, o
 * dos filas por una carrera), lo devolvemos para reenviarle ESE resumen en vez
 * de dejarlo en un mensaje sin salida. Devuelve la fila completa o null.
 */
async function buscarBorradorCompletoActivo(numeroCliente: string) {
  const { data } = await supabaseAdmin
    .from('pedidos')
    .select('*')
    .eq('telefono', numeroCliente)
    .eq('estado', 'borrador')
    .neq('enviado', true)
    .neq('direccion', '')
    .neq('metodo_pago', '')
    .or('cantidad_agua.gt.0,cantidad_crema.gt.0')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function confirmarBorrador(numeroCliente: string, pedidoId: number) {
  // Guard de completitud: un borrador parcial (armado a medias) usa '' de
  // placeholder en direccion/metodo_pago y puede tener cantidad 0. No se puede
  // mandar a cocina así — el UPDATE lo exige con .neq('','')/.or(cantidad>0),
  // de modo que un borrador incompleto afecta 0 filas y cae al fallback, que
  // le pide al cliente completar en vez de confirmar por error.
  const { data } = await supabaseAdmin
    .from('pedidos')
    .update({ estado: 'pendiente' })
    .eq('id', pedidoId)
    .eq('telefono', numeroCliente) // seguridad: solo el dueño puede confirmar
    .eq('estado', 'borrador')
    .neq('enviado', true)
    .neq('direccion', '')
    .neq('metodo_pago', '')
    .or('cantidad_agua.gt.0,cantidad_crema.gt.0')
    .select('id, direccion, metodo_pago')
    .maybeSingle();

  if (data) {
    await enviarMensajeWhatsApp(numeroCliente, mensajeConfirmacion(data.direccion, data.metodo_pago));
    await marcarHistorialDescartado(numeroCliente);
    console.log(`✅ Pedido ${pedidoId} confirmado por botón.`);
    return;
  }

  // 0 filas: el pedido del botón ya no es confirmable (lo cambió el cron, se
  // modificó por texto, o el resumen clickeado quedó superado y su id ya no es
  // el borrador vigente). Antes de dar un mensaje sin salida, chequeamos si el
  // cliente tiene OTRO borrador completo esperando confirmación y le reenviamos
  // ese resumen: los botones nuevos apuntan al id correcto, así el próximo click
  // sí confirma el pedido vigente (se auto-corrige en un turno).
  const borradorActual = await buscarBorradorCompletoActivo(numeroCliente);
  if (borradorActual) {
    console.log(`↩️ Botón "confirmar_borrador" sobre pedido ${pedidoId} no confirmable; reenvío el resumen del borrador vigente ${borradorActual.id}.`);
    await enviarResumenYPedirConfirmacion(numeroCliente, borradorActual, true);
    return;
  }

  // No hay ningún borrador vigente: el pedido realmente ya se resolvió.
  await enviarMensajeWhatsApp(numeroCliente, "Este pedido ya no está esperando confirmación. Si necesitás algo, escribime 🙏");
  console.log(`⚠️ Botón "confirmar_borrador" sobre pedido ${pedidoId}: no hay borrador vigente para confirmar.`);
}

/**
 * ¿El cliente tiene ALGÚN borrador activo (aunque sea parcial)? A diferencia de
 * buscarBorradorCompletoActivo, no exige completitud: para "modificar" alcanza
 * con que haya un borrador en pie — el cambio puede ser, justamente, completar
 * lo que falta.
 */
async function tieneBorradorActivo(numeroCliente: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('pedidos')
    .select('id')
    .eq('telefono', numeroCliente)
    .eq('estado', 'borrador')
    .neq('enviado', true)
    .limit(1);
  return Boolean(data && data.length > 0);
}

async function modificarBorrador(numeroCliente: string, pedidoId: number) {
  // No tocamos DB: solo invitamos al cliente a escribir qué quiere cambiar.
  // El próximo mensaje de texto lo va a procesar el flow normal sobre el
  // borrador que sigue en pie.
  const { data: pedido } = await supabaseAdmin
    .from('pedidos')
    .select('estado')
    .eq('id', pedidoId)
    .eq('telefono', numeroCliente)
    .maybeSingle();

  // Igual que confirmarBorrador: si el id del botón ya no es un borrador (resumen
  // superado / botón viejo del scroll), pero el cliente TIENE otro borrador
  // vigente, igual lo invitamos a cambiarlo — el flow normal opera sobre el
  // borrador activo, no sobre el id del botón.
  const hayBorradorVigente =
    pedido?.estado === 'borrador' || (await tieneBorradorActivo(numeroCliente));

  if (hayBorradorVigente) {
    await enviarMensajeWhatsApp(numeroCliente, "Dale, ¿qué querés cambiar? 📝");
  } else {
    await enviarMensajeWhatsApp(numeroCliente, "Este pedido ya no está esperando confirmación. Si necesitás algo, escribime 🙏");
  }
}

/**
 * Estado real de un pedido, para responder con la verdad cuando un UPDATE de
 * botón afectó 0 filas. Antes el fallback asumía la causa ("ya está en camino"),
 * pero 0 filas también pasa cuando el pedido YA se canceló (auto-rechazo o
 * cancelación colgada del cron) — y decirle "está en camino" a un cliente cuyo
 * pedido está cancelado es el viejo bug del despacho fantasma, versión mensaje.
 */
async function leerEstadoPedido(numeroCliente: string, pedidoId: number) {
  const { data } = await supabaseAdmin
    .from('pedidos')
    .select('estado, enviado')
    .eq('id', pedidoId)
    .eq('telefono', numeroCliente)
    .maybeSingle();
  return data;
}

async function confirmarCancelacion(numeroCliente: string, pedidoId: number) {
  const { data } = await supabaseAdmin
    .from('pedidos')
    .update({ estado: 'cancelado' })
    .eq('id', pedidoId)
    .eq('telefono', numeroCliente)
    .eq('estado', 'esperando_cancelacion')
    .neq('enviado', true)
    .select('id')
    .maybeSingle();

  if (data) {
    await enviarMensajeWhatsApp(numeroCliente, "Pedido cancelado. Cuando quieras helado, acá estoy 👋");
    await marcarHistorialDescartado(numeroCliente);
    console.log(`✅ Pedido ${pedidoId} cancelado por botón.`);
    return;
  }

  // 0 filas: leemos el estado real y contestamos acorde en vez de adivinar.
  const pedido = await leerEstadoPedido(numeroCliente, pedidoId);
  console.log(`⚠️ Botón "confirmar_cancelacion" sobre pedido ${pedidoId} que ya no está en esperando_cancelacion (estado real: ${pedido?.estado ?? 'no encontrado'}, enviado: ${pedido?.enviado ?? '-'}).`);

  if (pedido?.estado === 'cancelado') {
    await enviarMensajeWhatsApp(numeroCliente, "Tu pedido ya estaba cancelado ✅ Si querés pedir de nuevo, escribime 🍦");
  } else if (pedido && estaDespachado(pedido)) {
    await enviarMensajeWhatsApp(numeroCliente, "Uy, llegamos tarde. Tu pedido ya está en camino y no se pudo cancelar 🛵");
  } else if (pedido) {
    // Sigue vivo (borrador/pendiente): la cancelación se resolvió por otro lado
    // o el botón era de un mensaje viejo. Le damos la salida para re-intentar.
    await enviarMensajeWhatsApp(numeroCliente, "Tu pedido sigue en pie 👍 Si querés cancelarlo, escribime *cancelar*.");
  } else {
    await enviarMensajeWhatsApp(numeroCliente, "Algo cambió con tu pedido. Escribime de nuevo y seguimos 🙏");
  }
}

async function rechazarCancelacion(numeroCliente: string, pedidoId: number) {
  const { data } = await supabaseAdmin
    .from('pedidos')
    .update({ estado: 'borrador' })
    .eq('id', pedidoId)
    .eq('telefono', numeroCliente)
    .eq('estado', 'esperando_cancelacion')
    .select('*')
    .maybeSingle();

  if (data) {
    await enviarResumenYPedirConfirmacion(numeroCliente, data, false);
    console.log(`✅ Cancelación rechazada por botón. Pedido ${pedidoId} vuelve a borrador.`);
    return;
  }

  // 0 filas: mismo criterio que confirmarCancelacion — responder con el estado real.
  const pedido = await leerEstadoPedido(numeroCliente, pedidoId);
  console.log(`⚠️ Botón "rechazar_cancelacion" sobre pedido ${pedidoId} que ya no está en esperando_cancelacion (estado real: ${pedido?.estado ?? 'no encontrado'}, enviado: ${pedido?.enviado ?? '-'}).`);

  if (pedido?.estado === 'cancelado') {
    // El cliente quería MANTENERLO pero ya se canceló (cron de cancelación
    // colgada, o un "sí" previo). Se lo decimos claro y le damos la salida.
    await enviarMensajeWhatsApp(numeroCliente, "Uy, tu pedido ya se canceló 😕 Si lo seguís queriendo, escribime y lo armamos de nuevo 🍦");
  } else if (pedido && estaDespachado(pedido)) {
    await enviarMensajeWhatsApp(numeroCliente, "¡Todo bien! Tu pedido sigue en pie y ya está en camino 🛵");
  } else if (pedido) {
    // Ya está en borrador/pendiente: la cancelación ya se había resuelto
    // (doble click, o se rechazó por texto). Confirmamos que sigue vivo.
    await enviarMensajeWhatsApp(numeroCliente, "¡Todo bien! Tu pedido sigue en pie 👍");
  } else {
    await enviarMensajeWhatsApp(numeroCliente, "Algo cambió con tu pedido. Escribime de nuevo y seguimos 🙏");
  }
}

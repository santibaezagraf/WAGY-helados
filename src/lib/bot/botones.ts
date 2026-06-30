import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';
import { enviarMensajeWhatsApp, enviarResumenYPedirConfirmacion } from '@/lib/whatsapp';
import { marcarHistorialDescartado } from '@/lib/bot/procesar';

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

async function confirmarBorrador(numeroCliente: string, pedidoId: number) {
  const { data } = await supabaseAdmin
    .from('pedidos')
    .update({ estado: 'pendiente' })
    .eq('id', pedidoId)
    .eq('telefono', numeroCliente) // seguridad: solo el dueño puede confirmar
    .eq('estado', 'borrador')
    .neq('enviado', true)
    .select('id')
    .maybeSingle();

  if (data) {
    await enviarMensajeWhatsApp(numeroCliente, "¡Confirmado! Va a la cocina 🍦 ¡Gracias!");
    await marcarHistorialDescartado(numeroCliente);
    console.log(`✅ Pedido ${pedidoId} confirmado por botón.`);
  } else {
    // El borrador ya no existe en ese estado: lo autoconfirmó el cron,
    // se cambió por texto, o el cliente está clickeando un botón viejo.
    await enviarMensajeWhatsApp(numeroCliente, "Este pedido ya no está esperando confirmación. Si necesitás algo, escribime 🙏");
    console.log(`⚠️ Botón "confirmar_borrador" sobre pedido ${pedidoId} que ya no está en borrador.`);
  }
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

  if (pedido?.estado === 'borrador') {
    await enviarMensajeWhatsApp(numeroCliente, "Dale, ¿qué querés cambiar? 📝");
  } else {
    await enviarMensajeWhatsApp(numeroCliente, "Este pedido ya no está esperando confirmación. Si necesitás algo, escribime 🙏");
  }
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
  } else {
    // Race: el pedido se envió mientras tanto, o ya se canceló por otro lado.
    await enviarMensajeWhatsApp(numeroCliente, "Uy, llegamos tarde. Tu pedido ya está en camino y no se pudo cancelar 🛵");
    console.log(`⚠️ Botón "confirmar_cancelacion" sobre pedido ${pedidoId} que ya no está en esperando_cancelacion.`);
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
  } else {
    await enviarMensajeWhatsApp(numeroCliente, "Algo cambió con tu pedido. Escribime de nuevo y seguimos 🙏");
    console.log(`⚠️ Botón "rechazar_cancelacion" sobre pedido ${pedidoId} que ya no está en esperando_cancelacion.`);
  }
}

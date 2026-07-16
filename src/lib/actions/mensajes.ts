'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { Database } from '@/types/supabase'
import { Pedido } from '@/types/pedidos'
import { createClient as createUserClient } from '@/lib/supabase-server'
import { enviarMensajeManual, enviarResumenYPedirConfirmacion } from '@/lib/whatsapp'
import { PEDIDOS_TAG } from '@/lib/data/pedidos-listado'
import {
  activarAtencionHumana,
  desactivarAtencionHumana,
  estadoAtencion,
  limpiarRequiereAtencion,
  telefonosRequierenAtencion,
} from '@/lib/bot/atencion-humana'
import { construirConversaciones, type Conversacion } from '@/lib/conversaciones-utils'

// Bucket privado de los archivos del chat. Se sirven solo vía URL firmada.
const MEDIA_BUCKET = 'whatsapp-media'
// Vigencia de la URL firmada (1h): alcanza para ver/escuchar/descargar en el
// momento; al recargar el modal se regeneran.
const URL_FIRMADA_SEG = 60 * 60

// Cliente service-role (igual que el listado y el bot): lee/escribe mensajes_chat
// bypasseando RLS. La página ya valida la sesión, pero las server actions son
// invocables por su cuenta, así que cada una exige usuario autenticado abajo.
const supabaseAdmin = createServiceClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export type MensajeChat = {
  id: string
  rol: string
  texto: string | null
  created_at: string
  // Campos de media (tipo distinto de 'text'). media_url ya viene firmada.
  tipo: string
  media_url: string | null
  media_mime: string | null
  media_caption: string | null
  media_filename: string | null
  media_lat: number | null
  media_lng: number | null
}

/** Genera una URL firmada para un archivo del bucket privado (null si falla). */
async function firmarPath(path: string | null): Promise<string | null> {
  if (!path) return null
  const { data, error } = await supabaseAdmin.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(path, URL_FIRMADA_SEG)
  if (error) {
    console.error('⚠️ No se pudo firmar el media:', error.message)
    return null
  }
  return data.signedUrl
}

// Solo cargamos el historial reciente: traer TODO el intercambio con un número
// no escala y no aporta (una conversación de hace días no es accionable, y fuera
// de la ventana de 24h de Meta ni siquiera se le puede escribir). 24h coincide
// con esa ventana de mensajería libre.
const HORAS_HISTORIAL = 24

/** Aborta si no hay usuario autenticado (estas actions usan service-role). */
async function exigirUsuario() {
  const supabase = await createUserClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')
}

/** Historial reciente del chat de un teléfono (últimas HORAS_HISTORIAL), cronológico. */
export async function getHistorialChat(telefono: string): Promise<MensajeChat[]> {
  await exigirUsuario()

  const desde = new Date(Date.now() - HORAS_HISTORIAL * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('mensajes_chat')
    .select('id, rol, texto, created_at, tipo, media_path, media_mime, media_caption, media_filename, media_lat, media_lng')
    .eq('telefono', telefono)
    .gte('created_at', desde)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Error al traer el historial: ${error.message}`)

  // Firmamos los paths de media en paralelo.
  return Promise.all(
    (data ?? []).map(async (m) => ({
      id: m.id,
      rol: m.rol,
      texto: m.texto,
      created_at: m.created_at,
      tipo: m.tipo ?? 'text',
      media_url: await firmarPath(m.media_path),
      media_mime: m.media_mime,
      media_caption: m.media_caption,
      media_filename: m.media_filename,
      media_lat: m.media_lat,
      media_lng: m.media_lng,
    })),
  )
}

/**
 * Firma el path de un media que llegó por Realtime (el payload trae media_path
 * pero no una URL accesible desde el browser). Lo usa el modal para resolver la
 * URL de las filas nuevas sin recargar todo el historial.
 */
export async function firmarMedia(path: string): Promise<string | null> {
  await exigirUsuario()
  return firmarPath(path)
}

/** Lista de teléfonos que esperan intervención humana (badge + contador del registro). */
export async function getTelefonosRequierenAtencion(): Promise<string[]> {
  await exigirUsuario()
  return telefonosRequierenAtencion()
}

/**
 * Conversaciones recientes (cualquier teléfono con actividad en las últimas
 * HORAS_HISTORIAL), ordenadas por recencia y deduplicadas. Es el directorio que
 * alimenta el menú de chats del header: a diferencia del flag requiere_atencion,
 * NO desaparece al abrir el chat, así que un cliente sin pedido sigue accesible.
 * Marca cuáles esperan intervención humana para resaltarlos.
 *
 * El dedupe/marcado vive en `construirConversaciones` ([conversaciones-utils.ts]);
 * acá solo traemos las filas ya ordenadas por recencia.
 */
export async function getConversacionesRecientes(): Promise<Conversacion[]> {
  await exigirUsuario()

  const desde = new Date(Date.now() - HORAS_HISTORIAL * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('mensajes_chat')
    .select('telefono, created_at')
    .gte('created_at', desde)
    .not('telefono', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    console.error('⚠️ No se pudo traer conversaciones recientes:', error.message)
    return []
  }

  return construirConversaciones(data ?? [], await telefonosRequierenAtencion())
}

/** El operador abrió el chat → limpiamos el aviso de "requiere atención". */
export async function marcarAtendido(telefono: string): Promise<void> {
  await exigirUsuario()
  await limpiarRequiereAtencion(telefono)
}

/**
 * Envía un mensaje manual del operador al cliente y, si Meta lo aceptó, activa
 * la toma humana (el bot deja de auto-responder a ese cliente).
 *
 * Devuelve { ok }: si ok=false el envío falló (típicamente fuera de la ventana
 * de 24h de Meta) y el modal avisa al operador.
 */
export async function enviarMensajeManualAccion(
  telefono: string,
  texto: string,
): Promise<{ ok: boolean; mensaje: MensajeChat | null }> {
  await exigirUsuario()

  const limpio = texto.trim()
  if (!limpio) return { ok: false, mensaje: null }

  const { ok, mensaje } = await enviarMensajeManual(telefono, limpio)
  if (ok) await activarAtencionHumana(telefono)
  // El mensaje del operador siempre es texto: completamos los campos de media
  // en null para que calce con MensajeChat.
  const mensajeChat: MensajeChat | null = mensaje
    ? {
        id: mensaje.id,
        rol: mensaje.rol,
        texto: mensaje.texto,
        created_at: mensaje.created_at,
        tipo: 'text',
        media_url: null,
        media_mime: null,
        media_caption: null,
        media_filename: null,
        media_lat: null,
        media_lng: null,
      }
    : null
  return { ok, mensaje: mensajeChat }
}

/** Estado de la toma humana para el banner del modal. */
export async function getEstadoAtencion(telefono: string): Promise<{ activa: boolean }> {
  await exigirUsuario()
  return estadoAtencion(telefono)
}

/** Devolver la conversación al bot (fin de la toma humana). */
export async function finalizarAtencion(telefono: string): Promise<void> {
  await exigirUsuario()
  await desactivarAtencionHumana(telefono)
}

/**
 * Pedido "vigente" del teléfono para el panel del chat modal: el más reciente
 * en armado o en cocina. Misma ventana y filtros que el lookup de pedidoActivo
 * del bot (12h, estados intervenibles, enviado=false), así el panel muestra
 * exactamente el pedido sobre el que el bot va a actuar — editar/mandar el
 * resumen de otro pedido generaría botones apuntando a una orden que el bot
 * no reconoce como activa.
 */
export async function getPedidoActivoChat(telefono: string): Promise<Pedido | null> {
  await exigirUsuario()

  const hace12Horas = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabaseAdmin
    .from('pedidos')
    .select('*')
    .eq('telefono', telefono)
    .gte('created_at', hace12Horas)
    .in('estado', ['borrador', 'pendiente', 'esperando_cancelacion'])
    .eq('enviado', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('⚠️ No se pudo traer el pedido activo del chat:', error.message)
    return null
  }
  return data
}

/**
 * Envía manualmente el resumen del pedido con los botones de confirmación
 * (Sí, confirmar / No, modificar) y le devuelve el control del chat al bot.
 *
 * Caso de uso: el operador corrigió datos que la extracción de la IA falló, o
 * cargó un precio especial (promo / caso fuera de la lista) desde el modal de
 * edición — el precio manual sobrevive a updates posteriores del bot porque el
 * trigger procesar_pedido_final solo re-lista los montos cuando CAMBIAN las
 * cantidades. Después de eso el flujo vuelve a ser el normal: el cliente
 * confirma con el botón, o pide cambios y los sigue manejando el bot.
 *
 * El UPDATE lleva los mismos guards que usa el bot: solo estados intervenibles,
 * nunca un despachado (enviado=true), solo el pedido del teléfono del chat, y
 * completitud (un resumen de un borrador parcial mostraría campos vacíos).
 * Pase lo que pase con el estado previo, el pedido queda en 'borrador': el
 * resumen ofrece "confirmar", y el botón de confirmar solo actúa sobre borradores.
 */
export async function enviarResumenManualAccion(
  pedidoId: number,
  telefono: string,
): Promise<{ ok: boolean; motivo?: string }> {
  await exigirUsuario()

  const { data: fila, error } = await supabaseAdmin
    .from('pedidos')
    .update({ estado: 'borrador' })
    .eq('id', pedidoId)
    .eq('telefono', telefono)
    .in('estado', ['borrador', 'pendiente', 'esperando_cancelacion'])
    .neq('enviado', true)
    .neq('direccion', '')
    .neq('metodo_pago', '')
    .or('cantidad_agua.gt.0,cantidad_crema.gt.0')
    .select('*')
    .maybeSingle()

  if (error) {
    console.error('⚠️ No se pudo preparar el pedido para el resumen manual:', error.message)
    return { ok: false, motivo: 'Error al actualizar el pedido.' }
  }
  if (!fila) {
    // 0 filas = algún guard falló: pedido despachado/cancelado en el medio,
    // de otro teléfono, o incompleto.
    return {
      ok: false,
      motivo: 'El pedido ya no se puede confirmar (¿está incompleto, despachado o cancelado?). Recargá el chat.',
    }
  }

  const enviado = await enviarResumenYPedirConfirmacion(telefono, fila, true)
  if (!enviado) {
    // enviarResumenYPedirConfirmacion ya dejó resumen_pendiente=true (el cron
    // /api/reenviar-resumenes reintenta), pero el operador tiene que saber que
    // el cliente todavía no vio nada.
    return {
      ok: false,
      motivo: 'No se pudo enviar el resumen (¿ventana de 24 h vencida?). Queda marcado para reintento automático.',
    }
  }

  // Resumen afuera → el bot retoma la conversación. La desactivación explícita
  // (activa=false con updated_at nuevo) también satisface el gate por mensajes:
  // sin esto, el último saliente de operador <6h dejaría al bot mudo justo
  // cuando el cliente responde al resumen.
  await desactivarAtencionHumana(telefono)

  // El estado pudo cambiar (pendiente → borrador): refrescamos el listado.
  revalidatePath('/')
  updateTag(PEDIDOS_TAG)
  return { ok: true }
}

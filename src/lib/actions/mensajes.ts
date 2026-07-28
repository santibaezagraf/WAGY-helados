'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { Database } from '@/types/supabase'
import { Pedido } from '@/types/pedidos'
import { createClient as createUserClient } from '@/lib/supabase-server'
import { enviarMensajeManual, enviarResumenYPedirConfirmacion, marcarLeidoWhatsapp } from '@/lib/whatsapp'
import { PEDIDOS_TAG } from '@/lib/data/pedidos-listado'
import {
  activarAtencionHumana,
  bloquearNumero,
  desactivarAtencionHumana,
  desbloquearNumero,
  estadoAtencion,
  estaBloqueado,
  limpiarRequiereAtencion,
  resetearRateLimit,
  telefonosConTomaActiva,
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

// Cliente service-role SIN el genérico <Database>: para leer la vista
// `conversaciones_inbox`, que no está en los tipos generados (mismo criterio que
// conversaciones.ts / atencion-humana.ts).
const supabaseAdminSinTipar = createServiceClient(
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

// Ventana del MENÚ de conversaciones del header (dropdown de acceso rápido):
// distinto del historial del chat. 24h coincide con la ventana de mensajería
// libre de Meta y mantiene el menú corto; el inbox completo (/conversaciones)
// cubre 30 días.
const HORAS_HISTORIAL = 24

// Tamaño de página del historial del chat: traemos esta cantidad al abrir y otra
// tanda por cada "cargar más" al scrollear hacia arriba. Antes traíamos 500 de
// una sola vez — innecesario para el uso normal (se ve lo reciente) y caro para
// un número con mucho volumen. La paginación por cursor (created_at) trae lo
// viejo solo si el operador sube a buscarlo.
const PAGINA_HISTORIAL = 50

/** Aborta si no hay usuario autenticado (estas actions usan service-role). */
async function exigirUsuario() {
  const supabase = await createUserClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')
}

export type HistorialPagina = {
  /** Mensajes en orden cronológico (ascendente). */
  mensajes: MensajeChat[]
  /** true si la página se llenó → probablemente haya más mensajes viejos. */
  hayMas: boolean
}

// Núcleo paginado SIN auth (lo comparten getDatosChat y getMensajesAntiguos):
// trae hasta `limite` mensajes ANTERIORES a `antesDeISO` (o los más nuevos si no
// se pasa cursor), ordenados desc y luego dados vuelta a cronológico. `hayMas` es
// true si la página se llenó (heurística: casi seguro hay más viejos).
async function traerHistorialPagina(
  telefono: string,
  antesDeISO?: string,
  limite = PAGINA_HISTORIAL,
): Promise<HistorialPagina> {
  let query = supabaseAdmin
    .from('mensajes_chat')
    .select('id, rol, texto, created_at, tipo, media_path, media_mime, media_caption, media_filename, media_lat, media_lng')
    .eq('telefono', telefono)
    .order('created_at', { ascending: false })
    .limit(limite)
  if (antesDeISO) query = query.lt('created_at', antesDeISO)

  const { data, error } = await query
  if (error) throw new Error(`Error al traer el historial: ${error.message}`)

  const filas = data ?? []
  const hayMas = filas.length === limite
  // Firmamos los paths de media en paralelo (las filas de texto tienen
  // media_path=null → firmarPath corta sin I/O). `.reverse()` deja el orden
  // cronológico (ascendente) que espera el chat.
  const mensajes = await Promise.all(
    filas.reverse().map(async (m) => ({
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
  return { mensajes, hayMas }
}

/**
 * Mensajes ANTERIORES a un cursor (para el "cargar más" al scrollear hacia
 * arriba en el chat). Cronológico, con `hayMas` para saber si seguir ofreciendo.
 */
export async function getMensajesAntiguos(
  telefono: string,
  antesDeISO: string,
): Promise<HistorialPagina> {
  await exigirUsuario()
  return traerHistorialPagina(telefono, antesDeISO)
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
 * Lista de teléfonos con TOMA HUMANA ACTIVA y vigente. Estado inicial del
 * componente de notificaciones del header: sirve para decidir si un mensaje
 * entrante que llega por Realtime tiene que disparar un toast (mensaje del
 * cliente con un operador manejando la conversación, chat cerrado).
 */
export async function getTelefonosConTomaActiva(): Promise<string[]> {
  await exigirUsuario()
  return telefonosConTomaActiva()
}

/**
 * Conversaciones recientes (cualquier teléfono con actividad en las últimas
 * HORAS_HISTORIAL), ordenadas por recencia y deduplicadas. Es el directorio que
 * alimenta el menú de chats del header: a diferencia del flag requiere_atencion,
 * NO desaparece al abrir el chat, así que un cliente sin pedido sigue accesible.
 * Marca cuáles esperan intervención humana para resaltarlos.
 *
 * Fuente unificada con el inbox: lee la MISMA vista `conversaciones_inbox`
 * (dedupe por teléfono + flag `requiere_atencion` resueltos en SQL), acotada a
 * 24h. Reemplaza el viejo scan de 500 filas + dedupe en JS + consulta aparte de
 * requiere_atencion (3 operaciones → 1). Si la vista todavía no está creada en la
 * base (migración sin aplicar), cae al método anterior para no romper el header.
 */
export async function getConversacionesRecientes(): Promise<Conversacion[]> {
  await exigirUsuario()

  const desde = new Date(Date.now() - HORAS_HISTORIAL * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdminSinTipar
    .from('conversaciones_inbox')
    .select('telefono, requiere_atencion')
    .gte('ultimo_at', desde)
    .order('ultimo_at', { ascending: false })
    .limit(500)

  if (!error) {
    return (data ?? []).map((r: { telefono: string; requiere_atencion: boolean }) => ({
      telefono: r.telefono,
      requiereAtencion: r.requiere_atencion,
    }))
  }

  // Fallback (vista inexistente / error): método anterior sobre mensajes_chat.
  console.warn('⚠️ conversaciones_inbox no disponible, uso fallback:', error.message)
  const { data: crudas, error: errFallback } = await supabaseAdmin
    .from('mensajes_chat')
    .select('telefono, created_at')
    .gte('created_at', desde)
    .not('telefono', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500)

  if (errFallback) {
    console.error('⚠️ No se pudo traer conversaciones recientes:', errFallback.message)
    return []
  }

  return construirConversaciones(crudas ?? [], await telefonosRequierenAtencion())
}

/**
 * El operador abrió el chat: limpiamos el aviso de "requiere atención" y le
 * mandamos a Meta el read-receipt del último mensaje del cliente (así el
 * cliente ve las tildes azules, como en WhatsApp normal). El read receipt corre
 * en paralelo/fire-and-forget: si Meta falla no debe frenar el abrir del chat.
 * Meta trata "leído" como acumulativo (marca todos los anteriores del hilo), así
 * que con el más reciente que tenga wa_message_id alcanza.
 */
export async function marcarAtendido(telefono: string): Promise<void> {
  await exigirUsuario()
  await limpiarRequiereAtencion(telefono)
  // No await: fire-and-forget con log del error. No debe bloquear el abrir.
  void marcarLeidoUltimoDelCliente(telefono).catch((e) => {
    console.error(`⚠️ No se pudo mandar read-receipt para ${telefono}:`, e)
  })
}

// Busca el wa_message_id del último mensaje del cliente y le manda read-receipt
// a Meta. Sin auth (lo usa `marcarAtendido`, que ya autenticó).
async function marcarLeidoUltimoDelCliente(telefono: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('mensajes_chat')
    .select('wa_message_id')
    .eq('telefono', telefono)
    .eq('rol', 'cliente')
    .not('wa_message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data?.wa_message_id) return
  await marcarLeidoWhatsapp(data.wa_message_id)
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

/** Devolver la conversación al bot (fin de la toma humana). */
export async function finalizarAtencion(telefono: string): Promise<void> {
  await exigirUsuario()
  await desactivarAtencionHumana(telefono)
}

// ── Moderación manual del número (desde el chat) ────────────────────────────

/** Bloquea manualmente el número: el bot lo ignora por completo hasta desbloquear. */
export async function bloquearNumeroAccion(telefono: string): Promise<void> {
  await exigirUsuario()
  await bloquearNumero(telefono)
}

/** Quita el bloqueo manual (el bot vuelve a responderle). */
export async function desbloquearNumeroAccion(telefono: string): Promise<void> {
  await exigirUsuario()
  await desbloquearNumero(telefono)
}

/**
 * Resetea el rate-limit anti-DoS del número: un cliente legítimo que quedó
 * frenado por mandar muchos mensajes vuelve a poder escribirle al bot al
 * instante, sin esperar a que la ventana de 1h se vacíe sola.
 */
export async function resetearRateLimitAccion(telefono: string): Promise<void> {
  await exigirUsuario()
  await resetearRateLimit(telefono)
}

/**
 * Pedido "vigente" del teléfono para el panel del chat modal: el más reciente
 * en armado o en cocina. Misma ventana y filtros que el lookup de pedidoActivo
 * del bot (12h, estados intervenibles, enviado=false), así el panel muestra
 * exactamente el pedido sobre el que el bot va a actuar — editar/mandar el
 * resumen de otro pedido generaría botones apuntando a una orden que el bot
 * no reconoce como activa.
 */
// Núcleo del lookup SIN auth: lo comparten getPedidoActivoChat y getDatosChat.
async function traerPedidoActivo(telefono: string): Promise<Pedido | null> {
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

export async function getPedidoActivoChat(telefono: string): Promise<Pedido | null> {
  await exigirUsuario()
  return traerPedidoActivo(telefono)
}

/**
 * Estado inicial COMPLETO del chat en UNA sola llamada: historial + toma humana
 * + pedido vigente + bloqueo. Antes el panel disparaba 4 actions en paralelo y
 * cada una revalidaba la sesión (`auth.getUser()` → 4 round-trips a Supabase
 * Auth). Acá autenticamos una vez y hacemos las 4 lecturas en paralelo → 1 solo
 * round-trip desde el browser y 1 solo chequeo de sesión.
 */
export async function getDatosChat(telefono: string): Promise<{
  historial: MensajeChat[]
  hayMasHistorial: boolean
  atencionActiva: boolean
  pedido: Pedido | null
  bloqueado: boolean
}> {
  await exigirUsuario()
  const [historial, estado, pedido, bloqueado] = await Promise.all([
    traerHistorialPagina(telefono),
    estadoAtencion(telefono),
    traerPedidoActivo(telefono),
    estaBloqueado(telefono),
  ])
  return {
    historial: historial.mensajes,
    hayMasHistorial: historial.hayMas,
    atencionActiva: estado.activa,
    pedido,
    bloqueado,
  }
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

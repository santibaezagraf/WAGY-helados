// Lógica pura del directorio de conversaciones del header. Vive separada de
// la server action (mensajes.ts es 'use server', no puede exportar funciones
// sync) para poder testearla sin red ni Supabase.

export type Conversacion = {
  telefono: string
  requiereAtencion: boolean
}

// Tipos de mensaje que el bot no resuelve y que hacen que su fila entrante
// marque la conversación como pendiente. Debe coincidir con la lógica del
// webhook (que dispara `marcarRequiereAtencion` para media/ubicación).
// NOTA: `audio` NO va acá — el bot ahora transcribe las notas de voz y las
// procesa como texto (fila entra con procesado=false). Si la transcripción
// falla, el webhook cae al path de siempre (procesado=true + avisa a un
// humano) y el pendiente queda marcado por la rama `procesado === true` de
// abajo y por el listener de `atencion_humana.requiere_atencion` en el
// header. Marcar todo audio acá encendía el badge apenas llegaba la nota,
// antes de que el bot tuviera oportunidad de resolverla solo.
const TIPOS_REQUIEREN_HUMANO = new Set(['image', 'video', 'document', 'sticker', 'location'])

/**
 * Un mensaje entrante marca la conversación como pendiente cuando:
 *  - es un media/ubicación de un cliente (el bot no lo entiende), o
 *  - es texto (o audio transcripto) de un cliente pero llegó con
 *    `procesado=true`: el webhook lo silenció (toma humana activa, gate por
 *    mensaje de operador reciente, o rate-limit), así que hay algo del
 *    cliente sin leer por el staff.
 * Pura y compartida entre el header (dropdown) y el inbox (/conversaciones)
 * para que ambos marquen el amber al mismo instante.
 */
export function marcaPendiente(fila: {
  rol?: string | null
  tipo?: string | null
  procesado?: boolean | null
}): boolean {
  if (fila.rol !== 'cliente') return false
  if (fila.tipo && TIPOS_REQUIEREN_HUMANO.has(fila.tipo)) return true
  return fila.procesado === true
}

/**
 * A partir de filas de mensajes_chat YA ordenadas por recencia (descendente),
 * arma la lista de conversaciones: dedupe preservando el orden (la primera
 * aparición de un teléfono es la más reciente) y marca cuáles esperan
 * intervención humana. Ignora filas sin teléfono.
 */
export function construirConversaciones(
  filasPorRecencia: { telefono: string | null }[],
  pendientes: Iterable<string>,
): Conversacion[] {
  const setPendientes = new Set(pendientes)
  const vistos = new Set<string>()
  const out: Conversacion[] = []
  for (const fila of filasPorRecencia) {
    const tel = fila.telefono
    if (tel && !vistos.has(tel)) {
      vistos.add(tel)
      out.push({ telefono: tel, requiereAtencion: setPendientes.has(tel) })
    }
  }
  return out
}

// Etiquetas de los tipos de media para el preview (mismo criterio que el toast
// de notificaciones-entrantes: mostramos "Foto"/"Ubicación"/… en vez del binario).
const ETIQUETAS_MEDIA: Record<string, string> = {
  image: 'Foto',
  audio: 'Mensaje de voz',
  video: 'Video',
  document: 'Documento',
  sticker: 'Sticker',
  location: 'Ubicación',
}

/**
 * Preview de una línea del último mensaje de una conversación, para el inbox.
 * Pura y testeable. Reglas:
 *  - texto → el propio texto (recortado a `maxLargo` con elipsis).
 *  - media → etiqueta del tipo (+ caption si hay).
 *  - un mensaje saliente (bot/operador) lleva prefijo "Vos: " para distinguir de
 *    quién fue la última palabra en la lista.
 *  - vacío → "(sin texto)".
 */
export function armarPreviewMensaje(
  fila: {
    tipo?: string | null
    texto?: string | null
    media_caption?: string | null
    rol?: string | null
  },
  maxLargo = 60,
): string {
  const tipo = fila.tipo ?? 'text'
  let cuerpo: string
  if (tipo === 'text') {
    cuerpo = (fila.texto ?? '').trim() || '(sin texto)'
  } else {
    const base = ETIQUETAS_MEDIA[tipo] ?? 'Adjunto'
    const caption = fila.media_caption?.trim()
    cuerpo = caption ? `${base}: ${caption}` : base
  }
  if (cuerpo.length > maxLargo) cuerpo = cuerpo.slice(0, maxLargo - 1).trimEnd() + '…'
  // bot y operador son salientes: los agrupamos bajo "Vos:".
  const esSaliente = fila.rol === 'bot' || fila.rol === 'operador'
  return esSaliente ? `Vos: ${cuerpo}` : cuerpo
}

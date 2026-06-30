// Lógica pura del directorio de conversaciones del header. Vive separada de
// la server action (mensajes.ts es 'use server', no puede exportar funciones
// sync) para poder testearla sin red ni Supabase.

export type Conversacion = {
  telefono: string
  requiereAtencion: boolean
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

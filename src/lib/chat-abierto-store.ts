"use client"

// Store client-side minimalista compartido entre el ChatModal y el componente
// de notificaciones. Usamos un módulo con listeners en lugar de un React Context
// porque el ChatModal se monta en dos lugares independientes (Header para chats
// sin pedido, DataTable para chats de un pedido), y forzarlos a compartir un
// provider haría rediseñar el árbol para nada.
//
// Rastrea dos cosas:
//  - qué teléfono tiene el chat modal abierto en este momento (para NO disparar
//    un toast por un mensaje del chat que el operador ya está mirando).
//  - qué teléfonos tienen TOMA HUMANA ACTIVA. El componente de notificaciones
//    se hidrata desde el servidor y se mantiene al día por Realtime sobre
//    `atencion_humana`, pero además el ChatModal empuja localmente cuando el
//    operador dispara una acción que activa/desactiva la toma: así el toast
//    funciona en el acto sin depender del round-trip Realtime.

let telefonoAbierto: string | null = null
const tomaActiva = new Set<string>()
const listenersAbierto = new Set<() => void>()
const listenersToma = new Set<() => void>()

export function setChatAbierto(tel: string | null): void {
  if (telefonoAbierto === tel) return
  telefonoAbierto = tel
  listenersAbierto.forEach((l) => l())
}

export function getChatAbierto(): string | null {
  return telefonoAbierto
}

export function onChangeChatAbierto(cb: () => void): () => void {
  listenersAbierto.add(cb)
  return () => {
    listenersAbierto.delete(cb)
  }
}

export function setTomaActiva(tel: string, activa: boolean): void {
  const antes = tomaActiva.has(tel)
  if (activa) tomaActiva.add(tel)
  else tomaActiva.delete(tel)
  if (antes !== activa) listenersToma.forEach((l) => l())
}

export function hidratarTomaActiva(tels: Iterable<string>): void {
  let cambio = false
  for (const t of tels) {
    if (!tomaActiva.has(t)) {
      tomaActiva.add(t)
      cambio = true
    }
  }
  if (cambio) listenersToma.forEach((l) => l())
}

export function tieneTomaActiva(tel: string): boolean {
  return tomaActiva.has(tel)
}

export function onChangeTomaActiva(cb: () => void): () => void {
  listenersToma.add(cb)
  return () => {
    listenersToma.delete(cb)
  }
}

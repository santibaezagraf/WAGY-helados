/**
 * Mantiene el flag booleano `mensaje_enviado` coherente con `estado` en
 * cualquier UPDATE que toque el estado de un pedido:
 *  - estado='enviado'   → mensaje_enviado=true
 *  - estado='cancelado' → mensaje_enviado=false (sino una cancelación de un
 *                         pedido marcado previamente como mensaje_enviado deja
 *                         el flag pegado y el bot lo trata como "pedido
 *                         despachado reciente" para respuestas contextuales —
 *                         ver estaDespachado).
 *  - otros estados      → no tocamos el flag (lo gestiona el dashboard a mano).
 *
 * (`mensaje_enviado` se llamaba `enviado` a secas — se renombró porque
 * confundía con `estado='enviado'`: son dos señales distintas que conviven en
 * el mismo pedido. Migración 20260922130000.)
 *
 * Compartido entre las acciones del dashboard (actions/pedidos.ts) y los
 * flujos de cancelación del bot/cron (botones.ts, procesar.ts,
 * gestionar-borradores/route.ts) para que ningún camino de cancelación pueda
 * dejar un `mensaje_enviado=true` colgado sobre un pedido `cancelado`.
 *
 * AUDITORÍA: como este helper es el ÚNICO lugar por donde pasan todos los
 * caminos que mueven el estado, también es donde se sella quién despachó el
 * pedido — así ningún camino nuevo se puede olvidar de registrarlo. `nombre` es
 * opcional porque el bot y el cron también lo usan y ahí no hay usuario: en ese
 * caso el sello queda sin nombre (pero igual se limpia al cancelar).
 */
export function patchConEnviadoCoherente(
  estado: string,
  nombre?: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { estado };
  if (estado === 'enviado') {
    patch.mensaje_enviado = true;
    patch.enviado_at = new Date().toISOString();
    if (nombre) patch.enviado_por_nombre = nombre;
  }
  if (estado === 'cancelado') {
    patch.mensaje_enviado = false;
    // Un cancelado no salió: el sello de despacho deja de ser cierto.
    patch.enviado_at = null;
    patch.enviado_por_nombre = null;
  }
  return patch;
}

/**
 * Patch del flag `mensaje_enviado` suelto (sin tocar `estado`), sellando la
 * auditoría. Lo usan las acciones "marcar como enviado" del dashboard,
 * incluida la de copiar el mensaje al cadete — que es la señal TEMPRANA de
 * despacho.
 */
export function patchEnviado(enviado: boolean, nombre?: string): Record<string, unknown> {
  if (!enviado) {
    return { mensaje_enviado: false, enviado_at: null, enviado_por_nombre: null };
  }
  return {
    mensaje_enviado: true,
    enviado_at: new Date().toISOString(),
    enviado_por_nombre: nombre ?? null,
  };
}

/**
 * Mantiene el flag booleano `enviado` coherente con `estado` en cualquier
 * UPDATE que toque el estado de un pedido:
 *  - estado='enviado'   → enviado=true
 *  - estado='cancelado' → enviado=false (sino una cancelación de un pedido
 *                         marcado previamente como enviado deja el flag pegado
 *                         y el bot lo trata como "pedido despachado reciente"
 *                         para respuestas contextuales — ver estaDespachado).
 *  - otros estados      → no tocamos el flag (lo gestiona el dashboard a mano).
 *
 * Compartido entre las acciones del dashboard (actions/pedidos.ts) y los
 * flujos de cancelación del bot/cron (botones.ts, procesar.ts,
 * gestionar-borradores/route.ts) para que ningún camino de cancelación pueda
 * dejar un `enviado=true` colgado sobre un pedido `cancelado`.
 */
export function patchConEnviadoCoherente(estado: string): Record<string, unknown> {
  const patch: Record<string, unknown> = { estado };
  if (estado === 'enviado') patch.enviado = true;
  if (estado === 'cancelado') patch.enviado = false;
  return patch;
}

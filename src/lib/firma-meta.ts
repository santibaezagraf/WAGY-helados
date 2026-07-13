import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verificación de la firma de los webhooks de Meta (WhatsApp Cloud API).
 *
 * Meta firma CADA entrega del webhook con HMAC-SHA256 del body crudo usando el
 * App Secret de la app, y la manda en el header `X-Hub-Signature-256` con el
 * formato "sha256=<hex>". Sin esta verificación, cualquiera que descubra la URL
 * puede inyectar mensajes falsos haciéndose pasar por un cliente (crear/cancelar
 * pedidos ajenos, forjar clicks de botones, hacer que el bot le escriba a
 * números arbitrarios).
 *
 * IMPORTANTE: la firma es sobre los BYTES CRUDOS del request. El caller tiene
 * que verificar contra `request.text()` ANTES de hacer JSON.parse — firmar el
 * objeto re-serializado no da el mismo hash.
 */
export function verificarFirmaMeta(
  rawBody: string,
  firmaHeader: string | null,
  appSecret: string,
): boolean {
  if (!firmaHeader || !firmaHeader.startsWith('sha256=')) return false;

  const esperadaHex = createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex');
  const recibidaHex = firmaHeader.slice('sha256='.length);

  // Comparación en tiempo constante. timingSafeEqual exige buffers del mismo
  // largo, así que el chequeo de longitud va antes (y una firma de otro largo
  // es inválida de por sí).
  const esperada = Buffer.from(esperadaHex, 'utf8');
  const recibida = Buffer.from(recibidaHex, 'utf8');
  if (esperada.length !== recibida.length) return false;

  return timingSafeEqual(esperada, recibida);
}

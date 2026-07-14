import { timingSafeEqual } from 'crypto';

/**
 * Autorización de los endpoints internos disparados por infraestructura, no por
 * usuarios: los pg_cron de Supabase (`/api/reenviar-resumenes`,
 * `/api/gestionar-borradores`).
 * Decisiones (ver review de seguridad):
 *  - Secreto DEDICADO `CRON_SECRET`, distinto de `VERIFY_TOKEN`. Antes los tres
 *    endpoints reusaban VERIFY_TOKEN (que además es el handshake de Meta): un
 *    solo secreto para todo agranda el radio de daño si se filtra.
 *  - Viaja en el header `Authorization: Bearer <secreto>`, NO en la query string
 *    (`?token=...` queda en logs de acceso, historiales de proxy, etc.).
 *  - Comparación en tiempo constante (timingSafeEqual) para no filtrar el
 *    secreto por timing.
 *  - Fail-closed: sin `CRON_SECRET` configurado, se rechaza todo.
 */

/** Comparación de strings en tiempo constante. timingSafeEqual exige el mismo
 *  largo, así que el chequeo de longitud va antes (un largo distinto ya es
 *  mismatch). */
function igualSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function cronAutorizado(request: Request): boolean {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) {
    console.error('⛔ CRON_SECRET no configurado: rechazando la llamada interna. Cargá la env var.');
    return false;
  }

  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return false;

  return igualSeguro(header.slice('Bearer '.length), secreto);
}

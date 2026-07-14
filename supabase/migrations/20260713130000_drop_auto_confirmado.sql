-- Elimina la columna `pedidos.auto_confirmado` (higiene).
--
-- La auto-confirmación de borradores se dio de baja en la migración
-- 20260712120000 (la función y el pg_cron se borraron; la política pasó a
-- insistir + auto-rechazar). Desde entonces NADA setea `auto_confirmado`: la
-- columna quedó por compatibilidad con filas viejas, pero no la lee ni escribe
-- ningún código vivo.
--
-- Junto con esta migración se elimina el endpoint /api/webhook/notificacion (su
-- único receptor) y debe desactivarse el Database Webhook de Supabase que le
-- pegaba en cada UPDATE de pedidos.
--
-- Regenerá los tipos después de aplicar: `npm run update-types`.

alter table public.pedidos
  drop column if exists auto_confirmado;

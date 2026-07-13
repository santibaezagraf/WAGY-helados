-- Recordatorio + auto-rechazo de borradores silenciosos.
--
-- Cambio de política: un borrador NUNCA se confirma solo. En su lugar:
--   1. A los ~20 min de silencio se le insiste al cliente ("¿Seguís ahí?").
--   2. A las 6 horas sin confirmar, el borrador se cancela con
--      auto_rechazado=true y se le avisa al cliente.
-- Ambos pasos los ejecuta el endpoint /api/gestionar-borradores (ver su header
-- para el cron.schedule con pg_net, que se agenda a mano igual que el de
-- /api/reenviar-resumenes). Acá solo:
--   - agregamos las columnas de soporte,
--   - damos de baja el job y la función de auto-confirmación viejos.
-- La columna auto_confirmado y el branch correspondiente de
-- /api/webhook/notificacion quedan por compatibilidad histórica (filas viejas),
-- pero ya nada la setea.

alter table public.pedidos
  add column if not exists recordatorio_enviado boolean not null default false;

alter table public.pedidos
  add column if not exists auto_rechazado boolean not null default false;

-- Baja del cron viejo (idempotente).
do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid
  from cron.job
  where jobname = 'auto-confirmar-borradores';

  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end $$;

drop function if exists public.auto_confirmar_borradores_silenciosos();

-- Auto-confirmación de borradores con silencio prolongado del cliente.
--
-- El flow del bot deja un pedido en estado 'borrador' cuando manda el resumen
-- y queda esperando "SÍ" / "NO". Si el cliente no responde nada en 20 min,
-- asumimos que confirmó implícitamente y lo pasamos a 'pendiente' con el flag
-- auto_confirmado=true. El Database Webhook configurado sobre la tabla pedidos
-- dispara entonces /api/webhook/notificacion para avisarle al cliente.

set check_function_bodies = off;

create extension if not exists pg_cron with schema extensions;

create or replace function public.auto_confirmar_borradores_silenciosos()
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  telefonos_afectados text[];
begin
  -- 1. Buscar borradores que cumplen TODAS las condiciones y subirlos a
  --    pendiente con la marca de auto-confirmación. La cláusula RETURNING
  --    nos da los teléfonos para el segundo paso.
  with confirmados as (
    update public.pedidos p
    set estado = 'pendiente',
        auto_confirmado = true
    where p.estado = 'borrador'
      -- Borradores recientes nada más: zombies de hace varios días no se
      -- autoconfirman para no mandar comida sorpresa.
      and p.created_at > now() - interval '12 hours'
      -- Mínimo 20 min desde el último mensaje del cliente. mensajes_chat
      -- solo guarda mensajes entrantes, así que mide silencio real.
      and not exists (
        select 1 from public.mensajes_chat m
        where m.telefono = p.telefono
          and m.created_at > now() - interval '20 minutes'
      )
      -- Si hay mensajes sin procesar, hay un wake-up de QStash en vuelo;
      -- mejor que ese flow decida en lugar de pisarle el resultado.
      and not exists (
        select 1 from public.mensajes_chat m
        where m.telefono = p.telefono
          and m.procesado = false
      )
    returning p.telefono
  )
  select array_agg(distinct telefono) into telefonos_afectados from confirmados;

  -- 2. Cierre terminal de la conversación: descartar el historial de los
  --    clientes que acabamos de autoconfirmar, igual que hace el flow manual
  --    cuando el cliente responde "SÍ" al resumen.
  if telefonos_afectados is not null then
    update public.mensajes_chat
    set descartado = true
    where telefono = any(telefonos_afectados)
      and descartado = false;
  end if;
end;
$function$;

-- Schedule cada 5 minutos. Idempotente: si la migration corre dos veces,
-- desagendamos el job previo antes de reagendar.
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

select cron.schedule(
  'auto-confirmar-borradores',
  '*/5 * * * *',
  $$ select public.auto_confirmar_borradores_silenciosos(); $$
);

-- Moderación manual por número, sobre la tabla atencion_humana (la que ya
-- centraliza la supresión del bot por teléfono):
--
--   bloqueado           bloqueo PERSISTENTE controlado por el staff. Mientras
--                       esté en true, el webhook ignora por completo a ese
--                       teléfono (0 tokens, sin respuesta) hasta desbloquear.
--
--   rate_limit_reset_at watermark del rate-limit anti-DoS. El conteo por hora
--                       solo mira mensajes con created_at POSTERIOR a esto, así
--                       "resetear" (ponerlo en now()) desbloquea a un cliente
--                       legítimo de inmediato sin esperar a que la ventana de
--                       1h se vacíe sola.
--
-- Ambas nullable/con default → no rompen filas existentes. El bot lee estas
-- columnas con un cliente NO tipado (atencion-humana.ts), así que no hace falta
-- correr update-types para que compile; conviene igual para el resto del código.

alter table public.atencion_humana
  add column if not exists bloqueado boolean not null default false,
  add column if not exists rate_limit_reset_at timestamptz;

comment on column public.atencion_humana.bloqueado is
  'Bloqueo manual del staff: el webhook ignora por completo a este teléfono (0 tokens, sin respuesta) hasta desbloquear.';
comment on column public.atencion_humana.rate_limit_reset_at is
  'Watermark del rate-limit anti-DoS: el conteo por hora solo cuenta mensajes con created_at posterior. Resetear = now().';

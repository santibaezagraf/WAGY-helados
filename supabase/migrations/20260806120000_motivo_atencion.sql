-- Distingue el MOTIVO de `atencion_humana.requiere_atencion=true`.
--
-- Hoy el flag es un boolean puro: un cliente pausado por el rate-limit
-- anti-DoS (>=40 msj/hora) prende exactamente el mismo aviso que uno que
-- mandó una foto o hizo una consulta que el bot no puede responder — el
-- dashboard no puede distinguirlos aunque el significado operativo sea muy
-- distinto (uno es "posible abuso/flood", el otro "un cliente real necesita
-- una persona"). Esta columna cierra esa ambigüedad sin tocar el boolean
-- existente (todo el código que ya lee/escribe requiere_atencion sigue
-- funcionando igual).
--
-- NULL = motivo genérico (media/ubicación no resoluble, consulta de negocio
-- no respondible, gate de operador reciente, modificación fuera de plazo).
-- 'rate_limit' = el webhook silenció al cliente por superar el límite de
-- mensajes por hora (rate-limit.ts).

alter table public.atencion_humana
  add column if not exists motivo_atencion text;

alter table public.atencion_humana
  add constraint atencion_humana_motivo_atencion_check
  check (motivo_atencion is null or motivo_atencion in ('rate_limit'));

comment on column public.atencion_humana.motivo_atencion is
  'Motivo de requiere_atencion cuando no es el genérico de intervención humana. NULL = genérico (media/consulta/operador). ''rate_limit'' = cliente pausado por el anti-DoS de mensajes/hora.';

-- La vista de inbox suma la columna al final (create or replace view no
-- permite reordenar/insertar columnas en el medio de la lista existente).
create or replace view public.conversaciones_inbox
with (security_invoker = true) as
select distinct on (m.telefono)
  m.telefono,
  m.created_at            as ultimo_at,
  m.texto                 as ultimo_texto,
  m.tipo                  as ultimo_tipo,
  m.media_caption         as ultimo_media_caption,
  m.rol                   as ultimo_rol,
  coalesce(a.requiere_atencion, false) as requiere_atencion,
  coalesce(a.bloqueado, false)         as bloqueado,
  (a.activa is true and a.updated_at > (now() - interval '8 hours')) as toma_activa,
  a.motivo_atencion                    as motivo_atencion
from public.mensajes_chat m
left join public.atencion_humana a on a.telefono = m.telefono
where m.telefono is not null
  and m.created_at >= (now() - interval '30 days')
order by m.telefono, m.created_at desc;

comment on view public.conversaciones_inbox is
  'Inbox de conversaciones: 1 fila por teléfono (último mensaje de los últimos 30 días) + flags de atencion_humana, incluyendo el motivo de requiere_atencion. Alimenta la página /conversaciones.';

grant select on public.conversaciones_inbox to authenticated, service_role;

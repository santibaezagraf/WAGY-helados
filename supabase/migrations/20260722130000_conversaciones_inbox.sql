-- Vista de inbox de conversaciones (para la página /conversaciones).
--
-- El menú del header (getConversacionesRecientes) es un dropdown acotado a 24h y
-- solo devuelve {telefono, requiere_atencion}: sin preview, sin timestamp, sin
-- estado de bloqueo/toma. Esta vista arma el inbox completo: UNA fila por
-- teléfono con su ÚLTIMO mensaje (para preview + orden por recencia) y los flags
-- de atencion_humana ya resueltos. Ventana de 30 días horneada adentro (no
-- parametrizable en una vista) — coincide con el alcance elegido y deja que el
-- filtro por fecha use el índice en vez de escanear todo el historial.
--
-- Los bloqueados que se quedaron MUDOS (sin mensajes en 30 días) NO salen acá a
-- propósito: el tab "Bloqueadas" los trae directo de atencion_humana, así un
-- número bloqueado sigue siendo desbloqueable aunque no haya escrito nunca (el
-- límite conocido que esta feature viene a cerrar).
--
-- security_invoker=true: la vista corre con los permisos del rol que consulta.
-- El dashboard la lee con service-role (bypassa RLS) desde la server action; el
-- grant a authenticated queda por si se consultara desde el browser, en cuyo
-- caso respeta la RLS de select ya existente sobre mensajes_chat/atencion_humana.

create index if not exists mensajes_chat_telefono_created_idx
  on public.mensajes_chat (telefono, created_at desc);

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
  (a.activa is true and a.updated_at > (now() - interval '8 hours')) as toma_activa
from public.mensajes_chat m
left join public.atencion_humana a on a.telefono = m.telefono
where m.telefono is not null
  and m.created_at >= (now() - interval '30 days')
order by m.telefono, m.created_at desc;

comment on view public.conversaciones_inbox is
  'Inbox de conversaciones: 1 fila por teléfono (último mensaje de los últimos 30 días) + flags de atencion_humana. Alimenta la página /conversaciones.';

grant select on public.conversaciones_inbox to authenticated, service_role;

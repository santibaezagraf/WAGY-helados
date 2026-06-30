-- Soporte de mensajes multimedia en el chat manual.
--
-- Hasta ahora `mensajes_chat` solo guardaba texto y el webhook descartaba
-- (sin persistir) cualquier mensaje que no fuera texto/botón. Ahora el bot no
-- entiende media, pero el OPERADOR sí los necesita ver desde el modal de chat
-- (el número de Meta Business no se puede abrir desde un celular, así que el
-- modal es el único canal). Por eso:
--
--  - Guardamos los media en `mensajes_chat` con su `tipo` y la ruta del archivo
--    en el bucket privado `whatsapp-media` (Meta no manda el binario en el
--    webhook: manda un media_id; el backend lo descarga y lo sube a Storage).
--  - Cuando llega un media y NO hay toma humana activa, marcamos el teléfono
--    como `requiere_atencion` para avisar en el dashboard que hace falta que
--    una persona intervenga (el bot no puede resolverlo).

-- 1. Columnas de media en mensajes_chat.
alter table public.mensajes_chat
  add column if not exists tipo            text not null default 'text',
  add column if not exists media_path      text,
  add column if not exists media_mime      text,
  add column if not exists media_caption   text,
  add column if not exists media_filename  text,
  add column if not exists media_lat       double precision,
  add column if not exists media_lng       double precision;

comment on column public.mensajes_chat.tipo is
  'text | image | audio | video | document | sticker | location';
comment on column public.mensajes_chat.media_path is
  'Ruta del archivo en el bucket whatsapp-media (null para text/location)';

-- 2. Flag de "requiere intervención humana" por teléfono.
--    Vive en atencion_humana porque ya está keyed por teléfono y es la fuente
--    de verdad del estado de atención de cada conversación.
alter table public.atencion_humana
  add column if not exists requiere_atencion    boolean not null default false,
  add column if not exists requiere_atencion_at timestamptz;

-- Índice parcial para el contador/listado del dashboard (pocas filas en true).
create index if not exists atencion_humana_requiere_atencion_idx
  on public.atencion_humana (telefono)
  where requiere_atencion;

-- 3. Bucket privado para los archivos. El bot/los actions usan service-role y
--    bypassan RLS; el modal nunca accede al bucket directo, siempre vía URLs
--    firmadas generadas server-side. Por eso no agregamos policies públicas.
insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;

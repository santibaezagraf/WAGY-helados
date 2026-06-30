-- Permitir rol='operador' en mensajes_chat.
--
-- Los envíos manuales del staff desde el chat del dashboard (toma humana) se
-- persisten con rol='operador' para distinguirlos de las respuestas del bot.
-- El CHECK original solo aceptaba 'cliente'/'bot', así que esos inserts fallaban
-- con 23514 (mensajes_chat_rol_check) y el mensaje no quedaba guardado.

alter table public.mensajes_chat
  drop constraint if exists mensajes_chat_rol_check;

alter table public.mensajes_chat
  add constraint mensajes_chat_rol_check
  check (rol = any (array['cliente'::text, 'bot'::text, 'operador'::text]));

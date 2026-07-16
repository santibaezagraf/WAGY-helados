-- Flag de "una sola respuesta por ronda de botones".
--
-- Los clicks de botón se ejecutan inline en el webhook (sin el debounce +
-- claim atómico que protege al texto), y WhatsApp deja los dos botones de un
-- par tocables para siempre. El cliente podía tocar AMBOS (Confirmar +
-- Modificar, o Sí,cancelar + No,mantenerlo) y cada toque corría ejecutarBoton
-- en paralelo → dos respuestas, la segunda contradictoria. Los guards por
-- estado ya evitaban la corrupción de datos, pero no el segundo mensaje (y
-- modificarBorrador no toca DB ni tiene guard atómico, así que podía invitar a
-- modificar un pedido recién confirmado).
--
-- La columna es un token de un solo uso: se pone en true cada vez que el bot
-- manda un set de botones, y ejecutarBoton lo "consume" con un UPDATE atómico
-- (... WHERE esperando_respuesta_boton=true RETURNING) antes de actuar. Solo el
-- primer click de la ronda gana; el segundo afecta 0 filas y sale en silencio.
-- Mismo idioma que resumen_pendiente / recordatorio_enviado.

alter table pedidos
  add column if not exists esperando_respuesta_boton boolean not null default false;

-- Backfill de transición: los pedidos que YA tienen una ronda de botones viva
-- al momento del deploy (un resumen borrador esperando confirmación, o un
-- "¿estás seguro?" en esperando_cancelacion) arrancan con el token armado, así
-- el primer click post-deploy no se silencia por el default false.
update pedidos
set esperando_respuesta_boton = true
where estado in ('borrador', 'esperando_cancelacion');

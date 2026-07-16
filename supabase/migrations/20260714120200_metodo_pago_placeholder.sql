-- Los borradores parciales (procesar.ts) persisten el pedido apenas el cliente
-- da algún dato real, aunque falte el método de pago. Como la columna es NOT
-- NULL, se usa '' como placeholder de "todavía no cargado" ('' es falsy, así
-- que la lógica de faltantes lo trata como ausente sin ramas especiales) — el
-- mismo idioma que ya se usa para direccion.
--
-- Pero check_metodo_pago solo permitía ['efectivo','transferencia','mp','otro'],
-- así que el INSERT del borrador parcial reventaba con 23514 (violación de
-- check) y el borrador nunca se creaba. Agregamos '' al set permitido.
alter table pedidos
  drop constraint if exists check_metodo_pago;

alter table pedidos
  add constraint check_metodo_pago
  check (metodo_pago = any (array['efectivo', 'transferencia', 'mp', 'otro', '']));

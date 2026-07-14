-- Flag persistente: la dirección de este pedido se rellenó desde el historial
-- (el cliente NO la dio en esta conversación).
--
-- Antes esto era una variable local del turno (direccionInyectadaDeHistorial),
-- así que el aviso "📍 Usé la dirección de tu último pedido" solo salía si el
-- pedido se completaba en el MISMO turno de la inyección. Con borradores
-- parciales la inyección suele pasar en el turno 1 y el resumen recién sale
-- turnos después → el aviso nunca llegaba y el cliente podía confirmar sin
-- notar que el envío iba a una dirección vieja.
--
-- Se setea al crear el borrador con dirección inyectada; se limpia cuando el
-- cliente cambia la dirección; lo lee enviarResumenYPedirConfirmacion (y por
-- ende también el reenvío de resúmenes de /api/reenviar-resumenes).
alter table pedidos
  add column if not exists direccion_de_historial boolean not null default false;

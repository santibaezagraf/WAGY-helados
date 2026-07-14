-- Un solo borrador activo por teléfono, garantizado a nivel DB.
--
-- Nada en el código impedía dos filas estado='borrador' para el mismo cliente
-- (los inserts de procesar.ts no tienen guard de unicidad; el lookup de
-- pedidoActivo toma "el más reciente" y el otro queda zombie hasta el
-- auto-rechazo). Caso real: el cliente tocó "Sí, confirmar" de un resumen cuyo
-- pedido ya no era el borrador vigente (incidente del pedido 389) — con dos
-- borradores, los botones de un resumen pueden apuntar al equivocado.
--
-- El índice único parcial hace imposible el estado inconsistente; el código
-- maneja el 23505 fusionando sobre el borrador existente (ver procesar.ts).

-- 1. Limpieza previa: si hoy existen duplicados, conservamos el borrador MÁS
--    RECIENTE de cada teléfono (es el que el bot ya usa como pedidoActivo) y
--    cancelamos el resto como auto-rechazados (misma marca que la limpieza del
--    cron, así el dashboard los distingue de cancelaciones del cliente).
update pedidos p
set estado = 'cancelado',
    auto_rechazado = true,
    enviado = false
where p.estado = 'borrador'
  and exists (
    select 1
    from pedidos q
    where q.telefono = p.telefono
      and q.estado = 'borrador'
      and (q.created_at > p.created_at
           or (q.created_at = p.created_at and q.id > p.id))
  );

-- 2. El invariante, a nivel DB.
create unique index if not exists pedidos_un_borrador_por_telefono
  on pedidos (telefono)
  where estado = 'borrador';

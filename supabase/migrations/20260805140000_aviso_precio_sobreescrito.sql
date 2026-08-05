-- Aviso al operador cuando el cliente cambia cantidades sobre un pedido que
-- tenía precio manual.
--
-- Bug previo (silencioso): el trigger `procesar_pedido_final` retarifa con
-- la lista activa cada vez que cambian las cantidades. Si el operador había
-- puesto un precio manual (mayorista, promo, ajuste) y el cliente después
-- pedía "sumale 5 más" por WhatsApp, el UPDATE del bot pisaba el override
-- SIN QUE NADIE SE ENTERE — el operador seguía pensando que el pedido tenía
-- su precio manual pero en realidad ya no.
--
-- Política elegida: cuando cambian cantidades sobre un pedido con override
-- (`OLD.es_cambio_manual=true`), el trigger sigue retarifando con la lista
-- (comportamiento actual — la nueva cantidad puede caer en otro tier y no
-- tiene sentido preservar un unitario que fue elegido para el volumen
-- anterior), y ADEMÁS prende `aviso_precio_sobreescrito` para que el
-- dashboard señale la fila. El operador ve el aviso, revisa el pedido y
-- decide si vuelve a poner el override o lo deja en la lista.
--
-- Consecuencia esperada: `es_cambio_manual` queda `false` (el precio nuevo
-- matchea la lista), y el flag de aviso queda `true` hasta que el operador
-- edite el pedido explícitamente.
--
-- La limpieza pasa desde el dashboard: `actualizarPedidoCompleto` pisa
-- `aviso_precio_sobreescrito` en false en cualquier edición explícita
-- (cuando el operador ya revisó y decidió qué hacer).

alter table pedidos
  add column if not exists aviso_precio_sobreescrito boolean not null default false;

set check_function_bodies = off;

create or replace function public.procesar_pedido_final() returns trigger
    language plpgsql
    as $$
declare
  lista_activa_id bigint;
  precio_teorico_unit_agua numeric;
  precio_teorico_total_agua numeric;
  precio_teorico_unit_crema numeric;
  precio_teorico_total_crema numeric;
  es_diferente boolean := false;
  cantidad_cambio boolean := false;
  tenia_precio_manual boolean := false;
begin
  if TG_OP = 'UPDATE' then
    cantidad_cambio := (NEW.cantidad_agua IS DISTINCT FROM OLD.cantidad_agua)
      OR (NEW.cantidad_crema IS DISTINCT FROM OLD.cantidad_crema);
    tenia_precio_manual := COALESCE(OLD.es_cambio_manual, false);
  end if;

  select id into lista_activa_id from public.listas_precios where activa = true limit 1;

  select precio_unitario into precio_teorico_unit_agua
  from public.reglas_precios
  where lista_id = lista_activa_id and tipo_producto = 'agua' and min_cantidad <= NEW.cantidad_agua
  order by min_cantidad desc limit 1;

  if precio_teorico_unit_agua is null and NEW.cantidad_agua > 0 then
      select precio_unitario into precio_teorico_unit_agua from public.reglas_precios
      where lista_id = lista_activa_id and tipo_producto = 'agua' order by min_cantidad asc limit 1;
  end if;

  if NEW.cantidad_agua = 0 then precio_teorico_unit_agua := 0; end if;

  precio_teorico_total_agua := COALESCE(precio_teorico_unit_agua, 0) * NEW.cantidad_agua;

  select precio_unitario into precio_teorico_unit_crema
  from public.reglas_precios
  where lista_id = lista_activa_id and tipo_producto = 'crema' and min_cantidad <= NEW.cantidad_crema
  order by min_cantidad desc limit 1;

  if precio_teorico_unit_crema is null and NEW.cantidad_crema > 0 then
      select precio_unitario into precio_teorico_unit_crema from public.reglas_precios
      where lista_id = lista_activa_id and tipo_producto = 'crema' order by min_cantidad asc limit 1;
  end if;

  if NEW.cantidad_crema = 0 then precio_teorico_unit_crema := 0; end if;

  precio_teorico_total_crema := COALESCE(precio_teorico_unit_crema, 0) * NEW.cantidad_crema;

  if cantidad_cambio then
    -- Retarifamos con la lista (comportamiento base). El precio manual que
    -- pudiera tener el pedido se PIERDE — la nueva cantidad puede caer en
    -- otro tier y preservar el unitario viejo no tiene sentido.
    NEW.monto_total_agua := precio_teorico_total_agua;
    NEW.monto_total_crema := precio_teorico_total_crema;

    -- Pero si HABÍA precio manual, avisamos al operador: el override que
    -- puso ya no está más. Solo lo prendemos si NEW no lo trae explícitamente
    -- en false (permite que actualizarPedidoCompleto limpie el flag desde el
    -- dashboard, ver src/lib/actions/pedidos.ts).
    if tenia_precio_manual and NEW.aviso_precio_sobreescrito is not false then
      NEW.aviso_precio_sobreescrito := true;
    end if;
  else
    if NEW.monto_total_agua IS NULL then
      NEW.monto_total_agua := precio_teorico_total_agua;
    end if;

    if NEW.monto_total_crema IS NULL then
      NEW.monto_total_crema := precio_teorico_total_crema;
    end if;
  end if;

  if abs(COALESCE(NEW.monto_total_agua, 0) - precio_teorico_total_agua) > 0.01 OR
     abs(COALESCE(NEW.monto_total_crema, 0) - precio_teorico_total_crema) > 0.01 then
     es_diferente := true;
  end if;

  NEW.es_cambio_manual := es_diferente;

  if NEW.cantidad_agua > 0 then
      NEW.precio_unitario_agua := NEW.monto_total_agua / NEW.cantidad_agua;
  else
      NEW.precio_unitario_agua := 0;
  end if;

  if NEW.cantidad_crema > 0 then
      NEW.precio_unitario_crema := NEW.monto_total_crema / NEW.cantidad_crema;
  else
      NEW.precio_unitario_crema := 0;
  end if;

  RETURN NEW;
end;
$$;

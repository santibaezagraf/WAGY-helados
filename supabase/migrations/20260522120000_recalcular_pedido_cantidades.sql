set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.procesar_pedido_final()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  lista_activa_id bigint;
  precio_teorico_unit_agua numeric;
  precio_teorico_total_agua numeric;
  precio_teorico_unit_crema numeric;
  precio_teorico_total_crema numeric;
  es_diferente boolean := false;
  cantidad_cambio boolean := false;
begin
  if TG_OP = 'UPDATE' then
    cantidad_cambio := (NEW.cantidad_agua IS DISTINCT FROM OLD.cantidad_agua)
      OR (NEW.cantidad_crema IS DISTINCT FROM OLD.cantidad_crema);
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
    NEW.monto_total_agua := precio_teorico_total_agua;
    NEW.monto_total_crema := precio_teorico_total_crema;
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
$function$
;
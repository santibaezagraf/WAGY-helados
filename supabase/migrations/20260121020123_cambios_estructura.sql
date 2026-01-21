alter table "public"."pedidos" drop column "ganancia";

alter table "public"."pedidos" add column "precio_total" numeric generated always as ((COALESCE(monto_total_agua, (0)::numeric) + COALESCE(monto_total_crema, (0)::numeric))) stored;

alter table "public"."reglas_precios" alter column "lista_id" set not null;

CREATE UNIQUE INDEX reglas_precios_id_key ON public.reglas_precios USING btree (id);

alter table "public"."reglas_precios" add constraint "reglas_precios_id_key" UNIQUE using index "reglas_precios_id_key";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.manage_single_active_lista()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Si la nueva lista (o la editada) viene como activa
  IF NEW.activa IS TRUE THEN
    -- Desactivar todas las demas listas (excluyendo la actual si fuera un update)
    UPDATE public.listas_precios
    SET activa = false
    WHERE id <> NEW.id AND activa = true;
  END IF;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.procesar_pedido_final()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  -- Variables para calcular lo que "debería" costar (Precio Oficial)
  lista_activa_id bigint;
  precio_teorico_unit_agua numeric;
  precio_teorico_total_agua numeric;
  precio_teorico_unit_crema numeric;
  precio_teorico_total_crema numeric;
  
  es_diferente boolean := false;
begin
  -- 1. Buscamos la lista activa
  select id into lista_activa_id from public.listas_precios where activa = true limit 1;

  -- =======================================================
  -- CÁLCULO TEÓRICO AGUA (Lo que dice la lista)
  -- =======================================================
  select precio_unitario into precio_teorico_unit_agua 
  from public.reglas_precios
  where lista_id = lista_activa_id and tipo_producto = 'agua' and min_cantidad <= NEW.cantidad_agua
  order by min_cantidad desc limit 1;

  -- Fallback (Mínimo)
  if precio_teorico_unit_agua is null and NEW.cantidad_agua > 0 then
      select precio_unitario into precio_teorico_unit_agua from public.reglas_precios 
      where lista_id = lista_activa_id and tipo_producto = 'agua' order by min_cantidad asc limit 1;
  end if;
  
  if NEW.cantidad_agua = 0 then precio_teorico_unit_agua := 0; end if;
  
  -- Calculamos el total teórico
  precio_teorico_total_agua := COALESCE(precio_teorico_unit_agua, 0) * NEW.cantidad_agua;


  -- =======================================================
  -- CÁLCULO TEÓRICO CREMA (Lo que dice la lista)
  -- =======================================================
  select precio_unitario into precio_teorico_unit_crema 
  from public.reglas_precios
  where lista_id = lista_activa_id and tipo_producto = 'crema' and min_cantidad <= NEW.cantidad_crema
  order by min_cantidad desc limit 1;

  -- Fallback (Mínimo)
  if precio_teorico_unit_crema is null and NEW.cantidad_crema > 0 then
      select precio_unitario into precio_teorico_unit_crema from public.reglas_precios 
      where lista_id = lista_activa_id and tipo_producto = 'crema' order by min_cantidad asc limit 1;
  end if;

  if NEW.cantidad_crema = 0 then precio_teorico_unit_crema := 0; end if;

  -- Calculamos el total teórico
  precio_teorico_total_crema := COALESCE(precio_teorico_unit_crema, 0) * NEW.cantidad_crema;


  -- =======================================================
  -- COMPARACIÓN Y ASIGNACIÓN FINAL
  -- =======================================================
  
  -- En caso de no haberse introducido un monto total y este ser nulo,
  -- se inserta el teorico, calculado a partir de la lista de precisios
  -- y la cantidad de helados
  IF NEW.monto_total_agua IS NULL THEN -- COALESCE(NEW.monto_total_agua, 0) = 0
    NEW.monto_total_agua := precio_teorico_total_agua;
  END IF;

  IF NEW.monto_total_crema IS NULL THEN-- COALESCE(NEW.monto_total_crema, 0) = 0
    NEW.monto_total_crema := precio_teorico_total_crema;
  END IF;
 


  -- A. Detectar si hubo cambio manual
  -- Comparamos lo que mandó el Frontend (NEW.monto...) vs Lo Teórico
  -- Usamos ABS < 0.01 para evitar errores de redondeo en decimales
  IF abs(COALESCE(NEW.monto_total_agua, 0) - precio_teorico_total_agua) > 0.01 OR 
     abs(COALESCE(NEW.monto_total_crema, 0) - precio_teorico_total_crema) > 0.01 THEN
     es_diferente := true;
  END IF;

  NEW.es_cambio_manual := es_diferente;

  -- B. Calcular Unitarios Reales (Implícitos)
  -- Esto sirve para que tu historial tenga el valor real por unidad al que se vendió
  IF NEW.cantidad_agua > 0 THEN
      NEW.precio_unitario_agua := NEW.monto_total_agua / NEW.cantidad_agua;
  ELSE
      NEW.precio_unitario_agua := 0;
  END IF;

  IF NEW.cantidad_crema > 0 THEN
      NEW.precio_unitario_crema := NEW.monto_total_crema / NEW.cantidad_crema;
  ELSE
      NEW.precio_unitario_crema := 0;
  END IF;

  RETURN NEW;
end;
$function$
;

CREATE TRIGGER trigger_manage_active_lista BEFORE INSERT OR UPDATE ON public.listas_precios FOR EACH ROW EXECUTE FUNCTION public.manage_single_active_lista();



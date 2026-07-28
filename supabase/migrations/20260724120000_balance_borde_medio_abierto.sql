-- Balance: bordes de rango medio-abiertos [fecha_inicio, fecha_fin) en vez de
-- inclusivo-inclusivo. Alinea la convención del balance con la del listado de
-- pedidos (`created_at >= desde AND created_at < hasta`) y evita el doble conteo
-- de un pedido que caiga exactamente en el borde entre dos períodos consecutivos.
--
-- El rango lo arma el selector del dashboard (date-range-selector.tsx) en hora de
-- Argentina: fecha_inicio = 00:00 AR del primer día; fecha_fin = 00:00 AR del día
-- SIGUIENTE al último día del rango (fin exclusivo). Ver src/lib/zona-horaria.ts.
--
-- Único cambio respecto de 20260130184329: los dos `and created_at <= fecha_fin`
-- pasan a `and created_at < fecha_fin`.

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.obtener_balance(fecha_inicio timestamp with time zone, fecha_fin timestamp with time zone)
 RETURNS TABLE(total_agua numeric, total_crema numeric, plata_transferencia numeric, plata_efectivo numeric, costo_envio_total numeric, cantidad_envios numeric, total_gastos numeric, cantidad_gastos numeric, efectivo_final numeric, ingreso_total numeric)
 LANGUAGE plpgsql
AS $function$
begin
  return query

  -- 1. Calculamos los totales de PEDIDOS
  with resumen_pedidos as (
    select
      -- 1. Suma de cantidades (excluyendo cancelados)
      coalesce(sum(cantidad_agua), 0):: numeric as t_agua,
      coalesce(sum(cantidad_crema), 0):: numeric as t_crema,

      -- 2. Plata por Transferencia (Suma de montos donde metodo = transferencia)
      coalesce(sum(
        case when metodo_pago = 'transferencia'
             then coalesce(precio_total,0)
             else 0 end
      ), 0) as p_transferencia,

      -- 3. Plata Efectivo (Ingreso Bruto)
      coalesce(sum(
        case when metodo_pago = 'efectivo'
             then coalesce(precio_total,0)
             else 0 end
      ), 0) as p_efectivo,

      -- 4. Costo de envíos (Solo sumamos si hay costo > 0)
      coalesce(sum(costo_envio), 0) as c_envio,

      -- 5. Cantidad de envíos (Contamos cuántos pedidos tuvieron costo > 0)
      count(case when costo_envio > 0 then 1 else null end):: numeric as q_envios

    from public.pedidos
    where created_at >= fecha_inicio
      and created_at < fecha_fin
      and estado != 'cancelado'
  ),

  -- 2. Calculamos los totales de GASTOS
  resumen_gastos as (
    select
      coalesce(sum(monto), 0):: numeric as t_gastos,

      count(*):: numeric as q_gastos

    from public.gastos
    where created_at >= fecha_inicio
      and created_at < fecha_fin
  )
  -- Ahora sí, seleccionamos y hacemos la resta simple
  select
    p.t_agua,
    p.t_crema,
    p.p_transferencia,
    p.p_efectivo,
    p.c_envio,
    p.q_envios,
    g.t_gastos,
    g.q_gastos,
    (p.p_efectivo - p.c_envio - g.t_gastos) as efectivo_final,
    (p.p_efectivo + p.p_transferencia) as ingreso_total
  from resumen_pedidos p
  cross join resumen_gastos g;
end;
$function$
;

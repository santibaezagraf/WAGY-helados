-- Fix: la función obtener_balance contaba TODOS los gastos (incluyendo los
-- soft-deleted con activo=false), pero el listado de detalle filtra activo=true.
-- Esto causaba que "cantidad_gastos" y "total_gastos" no coincidieran con el
-- detalle visible. Ahora ambos filtran por activo = true.

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.obtener_balance(fecha_inicio timestamp with time zone, fecha_fin timestamp with time zone)
 RETURNS TABLE(total_agua numeric, total_crema numeric, plata_transferencia numeric, plata_efectivo numeric, costo_envio_total numeric, cantidad_envios numeric, total_gastos numeric, cantidad_gastos numeric, efectivo_final numeric, ingreso_total numeric)
 LANGUAGE plpgsql
AS $function$
begin
  return query

  with resumen_pedidos as (
    select
      coalesce(sum(cantidad_agua), 0):: numeric as t_agua,
      coalesce(sum(cantidad_crema), 0):: numeric as t_crema,

      coalesce(sum(
        case when metodo_pago = 'transferencia'
             then coalesce(precio_total,0)
             else 0 end
      ), 0) as p_transferencia,

      coalesce(sum(
        case when metodo_pago = 'efectivo'
             then coalesce(precio_total,0)
             else 0 end
      ), 0) as p_efectivo,

      coalesce(sum(costo_envio), 0) as c_envio,

      count(case when costo_envio > 0 then 1 else null end):: numeric as q_envios

    from public.pedidos
    where created_at >= fecha_inicio
      and created_at < fecha_fin
      and estado != 'cancelado'
  ),

  resumen_gastos as (
    select
      coalesce(sum(monto), 0):: numeric as t_gastos,
      count(*):: numeric as q_gastos
    from public.gastos
    where created_at >= fecha_inicio
      and created_at < fecha_fin
      and activo = true
  )

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

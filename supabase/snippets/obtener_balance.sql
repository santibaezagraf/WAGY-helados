create or replace function obtener_balance(fecha_inicio timestamptz, fecha_fin timestamptz)
returns table (
  total_agua numeric,
  total_crema numeric,
  plata_transferencia numeric,
  plata_efectivo numeric,
  costo_envio_total numeric,
  cantidad_envios numeric,
  total_gastos numeric,
  cantidad_gastos numeric,
  efectivo_final numeric,
  ingreso_total numeric
) as $$
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
      and created_at <= fecha_fin
      and estado != 'cancelado'
  ),

  -- 2. Calculamos los totales de GASTOS
  resumen_gastos as (
    select 
      coalesce(sum(monto), 0):: numeric as t_gastos,

      count(*):: numeric as q_gastos

    from public.gastos
    where created_at >= fecha_inicio 
      and created_at <= fecha_fin
      and activo != false
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
$$ language plpgsql;



drop function obtener_balance
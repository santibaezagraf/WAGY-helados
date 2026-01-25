create or replace function obtener_balance(fecha_inicio timestamptz, fecha_fin timestamptz)
returns table (
  total_agua numeric,
  total_crema numeric,
  plata_transferencia numeric,
  plata_efectivo numeric,
  costo_envio_total numeric,
  cantidad_envios numeric,
  efectivo_final numeric,
  ingreso_total numeric
) as $$
begin
  return query
  with calculos_previos as (
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
  )
  -- Ahora sí, seleccionamos y hacemos la resta simple
  select 
    t_agua,
    t_crema,
    p_transferencia,
    p_efectivo,
    c_envio,
    q_envios,
    (p_efectivo - c_envio) as efectivo_final,
    (p_efectivo + p_transferencia) as ingreso_total
  from calculos_previos;
end;
$$ language plpgsql;

drop function obtener_balance
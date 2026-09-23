-- PEDIDOS PROGRAMADOS: cargar hoy un pedido para entregar otro día (hasta 7).
--
-- `fecha_entrega` = cuándo hay que entregarlo. `created_at` sigue siendo cuándo
-- se cargó, y ahora se muestra en el listado (era un dato que no se veía en
-- ninguna parte).
--
-- El listado, los contadores del header y el balance pasan a bucketear los
-- pedidos por `fecha_entrega` en vez de por `created_at`: al abrir el día de
-- mañana querés ver lo que hay que repartir mañana.
--
-- OJO, esto NO cambia ningún número histórico: el backfill copia `created_at`
-- en todas las filas existentes, así que para todo lo ya cargado
-- fecha_entrega = created_at y los balances de días pasados dan idéntico. La
-- diferencia aparece solo con los pedidos programados de acá en adelante.


-- ---------------------------------------------------------------------------
-- 1. Columna + backfill.
--    Se agrega NULLABLE, se backfillea y recién ahí se pone NOT NULL: hacerlo
--    en un solo paso con `not null default now()` le estamparía a TODAS las
--    filas viejas el instante de la migración en vez de su fecha real.
-- ---------------------------------------------------------------------------
alter table public.pedidos add column if not exists fecha_entrega timestamptz;

update public.pedidos set fecha_entrega = created_at where fecha_entrega is null;

alter table public.pedidos alter column fecha_entrega set default now();
alter table public.pedidos alter column fecha_entrega set not null;

comment on column public.pedidos.fecha_entrega is
  'Cuándo hay que entregar el pedido. Default now() = se entrega el mismo día que se cargó. El listado y los balances bucketean por acá, no por created_at.';

-- El listado filtra y ordena por esta columna en cada request.
create index if not exists pedidos_fecha_entrega_idx on public.pedidos (fecha_entrega desc);


-- ---------------------------------------------------------------------------
-- 2. Contadores del header: mismo criterio que el listado, o los números no
--    cuadran con la tabla de abajo.
-- ---------------------------------------------------------------------------
create or replace function public.obtener_contadores_helados(
  fecha_desde      timestamptz default null,
  fecha_hasta      timestamptz default null,
  estados          text[]      default null,
  direccion_filtro text        default null,
  telefono_filtro  text        default null
)
returns table(total bigint, entregados bigint)
language sql
stable
as $$
  select
    coalesce(sum(p.cantidad_agua + p.cantidad_crema), 0)::bigint as total,
    coalesce(sum(
      case
        when p.estado <> 'cancelado' and (p.estado = 'enviado' or p.enviado = true)
        then p.cantidad_agua + p.cantidad_crema
        else 0
      end
    ), 0)::bigint as entregados
  from public.pedidos p
  where (fecha_desde      is null or p.fecha_entrega >= fecha_desde)
    and (fecha_hasta      is null or p.fecha_entrega <  fecha_hasta)
    and (estados          is null or p.estado = any(estados))
    and (direccion_filtro is null or p.direccion ilike '%' || direccion_filtro || '%')
    and (telefono_filtro  is null or p.telefono  ilike '%' || telefono_filtro  || '%');
$$;

revoke all on function public.obtener_contadores_helados(timestamptz, timestamptz, text[], text, text) from public;
grant execute on function public.obtener_contadores_helados(timestamptz, timestamptz, text[], text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Balance: los PEDIDOS pasan a contarse por fecha_entrega; los GASTOS siguen
--    por created_at (un gasto se hace cuando se hace, no se programa).
--
--    El motivo: si cargás hoy un pedido para la semana que viene, esa plata
--    todavía no la cobraste. Contarla en el balance de hoy infla el efectivo
--    del día con guita que no está en la caja. Además, dejar el listado por
--    fecha de entrega y el balance por fecha de carga haría que la misma pantalla
--    y el mismo balance asignen un pedido a días distintos — exactamente la
--    clase de incoherencia que motivó zona-horaria.ts.
--
--    Es el resto de la función 20260728120000 sin tocar (gastos activos, borde
--    medio-abierto): solo cambia la columna por la que se filtran los pedidos.
-- ---------------------------------------------------------------------------
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
    where fecha_entrega >= fecha_inicio
      and fecha_entrega <  fecha_fin
      and estado != 'cancelado'
  ),

  resumen_gastos as (
    select
      coalesce(sum(monto), 0):: numeric as t_gastos,
      count(*):: numeric as q_gastos
    from public.gastos
    where created_at >= fecha_inicio
      and created_at <  fecha_fin
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

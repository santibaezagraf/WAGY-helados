-- Renombra `pedidos.enviado` (booleano) a `pedidos.mensaje_enviado`.
--
-- El nombre viejo confundía con `pedidos.estado = 'enviado'` (el estado del
-- pedido en la cocina/despacho) — son DOS señales distintas que conviven en el
-- mismo pedido (ver `estaDespachado` en procesar.ts: "despachado" es
-- `estado='enviado' OR enviado=true`). El booleano se marca automático al
-- copiar el mensaje para el repartidor; el estado lo cambia el operador a mano
-- y suele ir atrasado. Mismo dato, nombre menos ambiguo.
--
-- `ALTER TABLE ... RENAME COLUMN` actualiza solo las vistas (Postgres las
-- re-resuelve por posición), NO el texto de las funciones — por eso acá
-- también se recrea `obtener_contadores_helados`, la única función que tenía
-- `p.enviado` hardcodeado en el cuerpo (confirmado con un `pg_get_functiondef`
-- sobre TODO el schema `public`, no solo grepeando migraciones: ninguna otra
-- función, vista, trigger o policy RLS lo menciona).
--
-- De paso se corrige un bug que traía esa función desde su origen (20260917120000):
-- "entregados"/"faltan" contaba como entregado a `mensaje_enviado=true` además de
-- `estado='enviado'`, mezclando dos señales con significados distintos — un
-- pedido puede tener el mensaje copiado (mensaje_enviado=true) y seguir
-- 'pendiente' en cocina. La estadística de faltan debe depender ÚNICAMENTE de
-- `estado='enviado'`.
--
-- ORDEN DE DEPLOY: como con la migración de roles, esto va ANTES que el
-- deploy del código nuevo, y lo más pegado posible en el tiempo — el código
-- viejo deja de compilar contra esta columna en caliente (el pipeline del bot
-- la lee/escribe en cada mensaje de WhatsApp), así que una ventana larga entre
-- migrar y deployar deja pedidos reales sin poder cancelarse/confirmarse.

alter table public.pedidos rename column enviado to mensaje_enviado;

comment on column public.pedidos.mensaje_enviado is
  'Si ya se copió el mensaje de confirmación para el repartidor (se marca solo). '
  'Distinto de estado=''enviado'', que el operador cambia a mano y suele ir atrasado. '
  'Ver estaDespachado() en procesar.ts: "despachado" = estado=''enviado'' OR mensaje_enviado=true.';

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
    -- "Entregado" = estado='enviado' ÚNICAMENTE. mensaje_enviado=true (el
    -- booleano temprano que se marca solo al copiar el mensaje al cadete) NO
    -- cuenta acá a propósito: "faltan" es una cuenta de cocina/despacho, no de
    -- si ya se le avisó al cliente, y contar mensaje_enviado adelantaba pedidos
    -- a "entregado" que todavía estaban en camino (o ni eso) con el estado
    -- todavía en 'pendiente'.
    coalesce(sum(
      case
        when p.estado = 'enviado'
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

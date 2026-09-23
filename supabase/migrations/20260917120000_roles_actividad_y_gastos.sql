-- ROLES (admin / mensajero), AUDITORÍA DE PEDIDOS, ACTIVIDAD DE USUARIOS,
-- CONCEPTO EN GASTOS Y AGREGADOS PARA LOS CONTADORES.
--
-- ORDEN DE DEPLOY — IMPORTANTE: esta migración tiene que aplicarse ANTES de
-- desplegar el código que la usa. Si el código sale primero, todos los usuarios
-- existentes (que no tienen rol) caen a `mensajero` por el fail-closed de
-- normalizarRol(), y como NO hay panel de alta de usuarios en la app, nadie
-- puede promover a nadie: el lockout solo se arregla desde el SQL editor.
--
-- BREAK-GLASS — si te quedaste sin ningún admin, desde el SQL editor de Supabase:
--   update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"rol":"admin"}'::jsonb
--   where email = 'tu-usuario@wagy.local';
-- y volvé a iniciar sesión (el claim viaja en el JWT: hace falta un token nuevo).
--
-- ALTA DE USUARIOS (manual, desde Authentication -> Add user):
--   email: <nombre>@wagy.local  ("Auto Confirm User" activado)
--   app_metadata: {"rol": "admin"}  ó  {"rol": "mensajero"}
-- El nombre visible y el login salen del mail; app_metadata solo lleva el rol.


-- ---------------------------------------------------------------------------
-- 1. BACKFILL: los usuarios que ya existen son el staff actual -> admin.
--    Va PRIMERO, antes de cualquier policy que dependa del rol.
--    Idempotente: solo toca a los que no tienen rol. Los que se creen después
--    llevan rol explícito, y uno creado sin rol cae a mensajero (lado seguro).
-- ---------------------------------------------------------------------------
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"rol":"admin"}'::jsonb
where raw_app_meta_data ->> 'rol' is null;


-- ---------------------------------------------------------------------------
-- 2. es_admin(): lee el rol del claim del JWT.
--    NO lleva `security definer`: solo mira los claims de la request, no toca
--    tablas. Que sea invoker es además lo que hace que la RLS de
--    actividad_usuario proteja sola a las RPCs de actividad de más abajo.
--    Fail-closed: sin claim `rol` -> false.
-- ---------------------------------------------------------------------------
create or replace function public.es_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'rol', '') = 'admin';
$$;

grant execute on function public.es_admin() to authenticated;


-- ---------------------------------------------------------------------------
-- 3. POLICIES: partir cada `FOR ALL ... USING(true) WITH CHECK(true)` en
--    lectura-para-todo-authenticated + escritura-solo-admin.
--    (mensajes_chat, alertas_modelo y uso_modelo ya son select-only: no se tocan.)
-- ---------------------------------------------------------------------------

-- pedidos
drop policy if exists "allow authenticated users to use pedidos" on public.pedidos;
create policy "pedidos_select_auth"  on public.pedidos for select to authenticated using (true);
create policy "pedidos_insert_admin" on public.pedidos for insert to authenticated with check (public.es_admin());
create policy "pedidos_update_admin" on public.pedidos for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy "pedidos_delete_admin" on public.pedidos for delete to authenticated using (public.es_admin());

-- gastos
drop policy if exists "Usuarios pueden ver y crear gastos" on public.gastos;
create policy "gastos_select_auth"  on public.gastos for select to authenticated using (true);
create policy "gastos_insert_admin" on public.gastos for insert to authenticated with check (public.es_admin());
create policy "gastos_update_admin" on public.gastos for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy "gastos_delete_admin" on public.gastos for delete to authenticated using (public.es_admin());

-- listas_precios. OJO: la policy vieja tenía USING(true) y ningún WITH CHECK;
-- en UPDATE el WITH CHECK hereda del USING, así que hoy sí deja escribir.
drop policy if exists "allow authenticated users to use listas_precios" on public.listas_precios;
create policy "listas_precios_select_auth"  on public.listas_precios for select to authenticated using (true);
create policy "listas_precios_insert_admin" on public.listas_precios for insert to authenticated with check (public.es_admin());
create policy "listas_precios_update_admin" on public.listas_precios for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy "listas_precios_delete_admin" on public.listas_precios for delete to authenticated using (public.es_admin());

-- reglas_precios (el nombre vigente lo puso la migración 20260713120000)
drop policy if exists "reglas_precios solo authenticated" on public.reglas_precios;
create policy "reglas_precios_select_auth"  on public.reglas_precios for select to authenticated using (true);
create policy "reglas_precios_insert_admin" on public.reglas_precios for insert to authenticated with check (public.es_admin());
create policy "reglas_precios_update_admin" on public.reglas_precios for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy "reglas_precios_delete_admin" on public.reglas_precios for delete to authenticated using (public.es_admin());

-- atencion_humana: el mensajero puede LEER (hoy no usa el chat, pero la lectura
-- es inocua y deja la puerta abierta a darle el chat en solo-lectura más
-- adelante) pero no moderar.
drop policy if exists "auth atencion_humana" on public.atencion_humana;
create policy "atencion_select_auth"  on public.atencion_humana for select to authenticated using (true);
create policy "atencion_insert_admin" on public.atencion_humana for insert to authenticated with check (public.es_admin());
create policy "atencion_update_admin" on public.atencion_humana for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy "atencion_delete_admin" on public.atencion_humana for delete to authenticated using (public.es_admin());


-- ---------------------------------------------------------------------------
-- 4. Sacarle el GRANT ALL a `anon`.
--    Viene del remote_schema original. Hoy lo ÚNICO que frena a cualquiera con
--    la anon key (que va en el bundle del browser) es que no existe ninguna
--    policy para `anon`. Cinturón y tiradores: le sacamos el privilegio.
--    Verificado que nada lo necesita: /precios y el bot leen con service-role,
--    y el browser del staff lee como `authenticated`, no como `anon`.
-- ---------------------------------------------------------------------------
revoke all on table public.pedidos        from anon;
revoke all on table public.gastos         from anon;
revoke all on table public.listas_precios from anon;
revoke all on table public.reglas_precios from anon;


-- ---------------------------------------------------------------------------
-- 5. AUDITORÍA EN pedidos: quién lo creó y quién lo marcó como enviado.
--    El nombre se guarda como SNAPSHOT (no como FK a auth.users) a propósito:
--    es lo correcto en una auditoría — si después alguien se renombra desde
--    /perfil, el registro histórico no cambia. Además evita un join contra el
--    schema `auth` en el listado.
-- ---------------------------------------------------------------------------
alter table public.pedidos add column if not exists creado_por_nombre  text;
alter table public.pedidos add column if not exists enviado_por_nombre text;
alter table public.pedidos add column if not exists enviado_at         timestamptz;

comment on column public.pedidos.creado_por_nombre  is 'Nombre del usuario que cargó el pedido, o ''bot'' si entró por WhatsApp. Snapshot, no FK.';
comment on column public.pedidos.enviado_por_nombre is 'Nombre del usuario que marcó el pedido como enviado. Snapshot, no FK.';
comment on column public.pedidos.enviado_at         is 'Cuándo se marcó como enviado.';


-- ---------------------------------------------------------------------------
-- 6. ACTIVIDAD DE USUARIOS: alimenta el ranking, el heatmap y el historial
--    de /perfil.
--    Se escribe SIEMPRE con service-role desde registrarActividad() y de forma
--    fail-open: un fallo escribiendo telemetría nunca debe romper la acción del
--    usuario (mismo criterio que registrarAlertaFallback en lib/bot/alertas.ts).
--    Se lee SOLO admin: el mensajero no ve la actividad de nadie.
-- ---------------------------------------------------------------------------
create table if not exists public.actividad_usuario (
  id             bigint generated always as identity primary key,
  usuario_id     uuid        not null,
  -- Snapshot del nombre al momento de la acción (mismo criterio que arriba).
  usuario_nombre text        not null,
  -- 'pedido.crear' | 'pedido.editar' | 'pedido.estado' | 'pedido.pago' |
  -- 'pedido.enviar' | 'pedido.costo_envio' | 'gasto.registrar' | 'gasto.eliminar'
  accion         text        not null,
  -- Pedidos afectados en una acción masiva. El ranking cuenta FILAS (una acción
  -- masiva = 1) para que no se infle seleccionando todo; esta columna es el
  -- volumen real, que se muestra al lado como dato aparte.
  cantidad       integer     not null default 1,
  pedido_id      bigint,
  detalle        jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists actividad_usuario_created_at_idx
  on public.actividad_usuario (created_at desc);
create index if not exists actividad_usuario_usuario_created_idx
  on public.actividad_usuario (usuario_id, created_at desc);

alter table public.actividad_usuario enable row level security;

drop policy if exists "actividad_select_admin" on public.actividad_usuario;
create policy "actividad_select_admin"
  on public.actividad_usuario
  for select to authenticated
  using (public.es_admin());


-- ---------------------------------------------------------------------------
-- 7. GASTOS: concepto + la columna `activo` que faltaba.
--    `activo` (soft delete) se había agregado a mano en la base remota y NUNCA
--    tuvo migración, pero el código ya la usa (ObtenerGastos, EliminarGasto y
--    obtener_balance). Sin esto, una base reconstruida desde cero desde
--    supabase/migrations/ rompe los balances. `if not exists` la deja idempotente.
-- ---------------------------------------------------------------------------
alter table public.gastos add column if not exists activo   boolean not null default true;
alter table public.gastos add column if not exists concepto text;

comment on column public.gastos.concepto is 'Descripción libre del gasto (opcional).';


-- ---------------------------------------------------------------------------
-- 8. RPC: contadores de helados del header.
--    Agrega en Postgres en vez de sumar en TS porque un select sin agregar tiene
--    el tope de 1000 filas de PostgREST: con periodo='todos' se cortaría en
--    silencio y los contadores darían mal SIN ningún error.
--
--    "Entregado" replica la regla de estaDespachado() (lib/bot/procesar.ts):
--    hay dos señales y la cancelación gana. `enviado` se marca al copiar el
--    mensaje al cadete (señal temprana) y `estado` se cambia a mano, a veces al
--    día siguiente; mirar una sola subcontaría.
--
--    Aplica los MISMOS filtros que el listado salvo pagado/enviado: filtrar por
--    `enviado` dejaría uno de los dos buckets siempre en 0, que es justo la
--    partición que los contadores muestran.
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
  where (fecha_desde      is null or p.created_at >= fecha_desde)
    and (fecha_hasta      is null or p.created_at <  fecha_hasta)
    and (estados          is null or p.estado = any(estados))
    and (direccion_filtro is null or p.direccion ilike '%' || direccion_filtro || '%')
    and (telefono_filtro  is null or p.telefono  ilike '%' || telefono_filtro  || '%');
$$;

revoke all on function public.obtener_contadores_helados(timestamptz, timestamptz, text[], text, text) from public;
grant execute on function public.obtener_contadores_helados(timestamptz, timestamptz, text[], text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 9. RPCs de actividad (heatmap y ranking).
--    Agrupan por DÍA ARGENTINO, no por día UTC: el runtime de Vercel es UTC y
--    una acción de las 22:00 AR cae en el día calendario siguiente — el mismo
--    bug que motivó lib/zona-horaria.ts. Sin esto el heatmap pinta corrido.
--
--    Sin `security definer`: corren con los permisos de quien llama, así que la
--    RLS de actividad_usuario (select solo admin) las protege sola si alguien
--    las invoca directo desde PostgREST con la anon key.
-- ---------------------------------------------------------------------------
create or replace function public.obtener_actividad_por_dia(
  desde timestamptz,
  hasta timestamptz
)
returns table(dia date, usuario_nombre text, acciones bigint)
language sql
stable
as $$
  select
    (a.created_at at time zone 'America/Argentina/Buenos_Aires')::date as dia,
    a.usuario_nombre,
    count(*)::bigint as acciones
  from public.actividad_usuario a
  where a.created_at >= desde
    and a.created_at <  hasta
  group by 1, 2
  order by 1;
$$;

create or replace function public.obtener_ranking_actividad(
  desde timestamptz,
  hasta timestamptz
)
returns table(usuario_id uuid, usuario_nombre text, acciones bigint, pedidos_tocados bigint)
language sql
stable
as $$
  select
    a.usuario_id,
    -- El nombre puede haber cambiado entre acciones: mostramos el más reciente.
    (array_agg(a.usuario_nombre order by a.created_at desc))[1] as usuario_nombre,
    count(*)::bigint                  as acciones,
    coalesce(sum(a.cantidad), 0)::bigint as pedidos_tocados
  from public.actividad_usuario a
  where a.created_at >= desde
    and a.created_at <  hasta
  group by a.usuario_id
  order by acciones desc;
$$;

revoke all on function public.obtener_actividad_por_dia(timestamptz, timestamptz) from public;
grant execute on function public.obtener_actividad_por_dia(timestamptz, timestamptz) to authenticated;
revoke all on function public.obtener_ranking_actividad(timestamptz, timestamptz) from public;
grant execute on function public.obtener_ranking_actividad(timestamptz, timestamptz) to authenticated;

-- Chat manual por pedido (toma humana + Realtime).
--
-- Habilita que el staff converse manualmente con el cliente desde el dashboard:
--  * `atencion_humana`: flag por teléfono que pausa el bot mientras un operador
--    maneja la conversación (ver src/lib/bot/atencion-humana.ts).
--  * RLS de lectura sobre `mensajes_chat` para el rol `authenticated`, necesaria
--    para que el cliente browser pueda leer el historial y recibir Realtime (el
--    bot usa service-role y bypassa RLS, así que no se ve afectado).
--  * Alta de `mensajes_chat` en la publicación `supabase_realtime`.
--
-- Todo idempotente: `mensajes_chat` se creó directo en el remoto (no está en
-- estas migraciones), así que no asumimos su estado previo de RLS/publicación.

-- 1. Tabla de toma humana (keyed por teléfono, no por pedido).
create table if not exists public.atencion_humana (
  telefono   text primary key,
  activa     boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.atencion_humana enable row level security;

drop policy if exists "auth atencion_humana" on public.atencion_humana;
create policy "auth atencion_humana" on public.atencion_humana
  to authenticated using (true) with check (true);

-- 2. RLS de lectura para mensajes_chat (Realtime + carga inicial la respetan).
alter table public.mensajes_chat enable row level security;

drop policy if exists "auth read mensajes_chat" on public.mensajes_chat;
create policy "auth read mensajes_chat" on public.mensajes_chat
  for select to authenticated using (true);

-- 3. Sumar mensajes_chat a la publicación de Realtime (si no estaba ya).
do $$
begin
  alter publication supabase_realtime add table public.mensajes_chat;
exception
  when duplicate_object then null;
end $$;

-- Cierra `reglas_precios` al rol `anon`.
--
-- Bug de seguridad: la policy original se creó SIN cláusula `TO`, así que aplica
-- a PUBLIC (incluye `anon`). Como la anon key es pública (va al browser),
-- cualquiera podía leer/escribir la tabla de precios directo contra la API REST
-- de Supabase. Sus hermanas `pedidos` y `listas_precios` sí tienen
-- `TO authenticated` y por eso `anon` no las ve.
--
-- Verificado en el remoto: un GET a /rest/v1/reglas_precios con la anon key
-- devolvía filas reales (200), mientras que pedidos/listas_precios devolvían [].
--
-- Fix: dropeamos TODAS las policies de la tabla (no asumimos el nombre exacto,
-- que puede haber derivado en el remoto respecto de la migración base) y creamos
-- una sola, restringida a `authenticated`. Los lectores legítimos no se afectan:
-- la landing pública usa service-role (saltea RLS) y el dashboard corre con
-- sesión autenticada.

do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'reglas_precios'
  loop
    execute format('drop policy if exists %I on public.reglas_precios', pol.policyname);
  end loop;
end $$;

alter table public.reglas_precios enable row level security;

create policy "reglas_precios solo authenticated"
  on public.reglas_precios
  for all
  to authenticated
  using (true)
  with check (true);

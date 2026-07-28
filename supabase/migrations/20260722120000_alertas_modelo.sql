-- Alertas de fallback de modelo (monitoreo del bot).
--
-- Cuando el modelo primario de extracción (gpt-oss-20b) se queda sin cuota (429 /
-- TPD), el pipeline salta al siguiente de MODELOS_EXTRACCION para no dejar al
-- cliente sin respuesta (ver procesar.ts). Ese fallback era hasta ahora un
-- `console.warn` invisible: nadie se enteraba de que el primario estaba caído
-- hasta que también se agotaba el 120b. Esta tabla registra cada salto para que
-- el dashboard lo muestre (banner + Realtime) y el staff sepa que hay que mirar
-- la cuota de Groq.
--
--   modelo_agotado    el modelo que devolvió el 429 (el que se quedó sin cuota).
--   modelo_fallback   el que se usó en su lugar (NULL si era el último de la
--                     cadena → toda la cadena agotada, el cliente quedó sin
--                     respuesta ese turno).
--   telefono          cliente afectado (contexto; puede ser NULL).
--   resuelto          el staff lo marca visto desde el banner. El bot siempre
--                     inserta con false.
--
-- El bot escribe con service-role (bypassa RLS). El dashboard lee vía la server
-- action (service-role) y escucha Realtime; la RLS de select para authenticated
-- habilita también una lectura directa desde el navegador si hiciera falta.

create table if not exists public.alertas_modelo (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  modelo_agotado text not null,
  modelo_fallback text,
  telefono text,
  resuelto boolean not null default false
);

comment on table public.alertas_modelo is
  'Registro de saltos de fallback de modelo del bot (429/TPD). Alimenta el banner de alerta del dashboard.';

-- El acceso más frecuente es "¿hay alertas sin resolver recientes?": índice
-- parcial por las no resueltas, ordenadas por fecha.
create index if not exists alertas_modelo_pendientes_idx
  on public.alertas_modelo (created_at desc)
  where resuelto = false;

alter table public.alertas_modelo enable row level security;

-- El dashboard (browser + Realtime) necesita leer; las mutaciones van por
-- service-role, así que no hace falta policy de insert/update para authenticated.
drop policy if exists "alertas_modelo_select_auth" on public.alertas_modelo;
create policy "alertas_modelo_select_auth" on public.alertas_modelo
  for select to authenticated using (true);

-- Realtime: el banner se prende en vivo cuando el bot inserta una alerta.
do $$
begin
  alter publication supabase_realtime add table public.alertas_modelo;
exception
  when duplicate_object then null;
end $$;

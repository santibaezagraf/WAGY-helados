-- Telemetría de uso de tokens de los modelos LLM del bot.
--
-- Hasta ahora sabíamos que un modelo se quedaba SIN cuota solo cuando devolvía un
-- 429 (registrado en `alertas_modelo`), pero no cuánto llevábamos consumido antes
-- de eso — el free-tier de Groq da 200k tokens/día POR MODELO (TPD) y no había
-- forma de ver "voy por la mitad" ni de graficar el consumo. Esta tabla registra
-- el `usage` de cada llamada exitosa (`generateObject`) para alimentar la página
-- de estado de modelos (`/modelos`): barras de uso vs. límite y series diarias.
--
--   modelo         id del modelo Groq (ej. 'openai/gpt-oss-20b').
--   tipo           'extraccion' (arma el pedido) | 'consulta' (respuesta libre).
--   tokens_input   tokens del prompt (usage.inputTokens del AI SDK).
--   tokens_output  tokens generados (usage.outputTokens).
--   tokens_total   total (usage.totalTokens; puede diferir de la suma por overhead).
--   telefono       cliente afectado (contexto; puede ser NULL).
--
-- Solo se insertan llamadas EXITOSAS: un 429 no devuelve usage (ya lo cubre
-- alertas_modelo). El bot escribe con service-role (bypassa RLS), fail-open y
-- fire-and-forget: un fallo de esta telemetría nunca frena la respuesta al cliente.

create table if not exists public.uso_modelo (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  modelo text not null,
  tipo text not null,
  tokens_input integer not null default 0,
  tokens_output integer not null default 0,
  tokens_total integer not null default 0,
  telefono text
);

comment on table public.uso_modelo is
  'Uso de tokens por llamada LLM del bot (Groq). Alimenta la página de estado de modelos del dashboard.';

-- El acceso típico es "consumo de los últimos N días": índice por fecha desc.
create index if not exists uso_modelo_created_at_idx
  on public.uso_modelo (created_at desc);

alter table public.uso_modelo enable row level security;

-- El dashboard (browser + Realtime) necesita leer; las inserciones van por
-- service-role, así que no hace falta policy de insert para authenticated.
drop policy if exists "uso_modelo_select_auth" on public.uso_modelo;
create policy "uso_modelo_select_auth" on public.uso_modelo
  for select to authenticated using (true);

-- Realtime: la página de estado se actualiza en vivo cuando entra un uso nuevo.
do $$
begin
  alter publication supabase_realtime add table public.uso_modelo;
exception
  when duplicate_object then null;
end $$;

-- Vista agregada por modelo y por DÍA CALENDARIO ARGENTINO (no UTC): el runtime
-- corre en UTC, así que el "día" del TPD hay que resolverlo en America/Argentina/
-- Buenos_Aires para que el consumo se agrupe igual que lo ve el negocio (mismo
-- criterio que el resto del sistema, ver zona-horaria.ts). Ventana de 30 días
-- horneada en la vista para que el filtro use el índice. `security_invoker` para
-- que respete la RLS del que consulta (aunque el bot y la action usan service-role).
drop view if exists public.uso_modelo_diario;
create view public.uso_modelo_diario with (security_invoker = true) as
select
  modelo,
  tipo,
  (created_at at time zone 'America/Argentina/Buenos_Aires')::date as dia,
  count(*)                as llamadas,
  sum(tokens_input)::bigint  as tokens_input,
  sum(tokens_output)::bigint as tokens_output,
  sum(tokens_total)::bigint  as tokens_total
from public.uso_modelo
where created_at >= now() - interval '30 days'
group by modelo, tipo, (created_at at time zone 'America/Argentina/Buenos_Aires')::date;

comment on view public.uso_modelo_diario is
  'Uso de tokens agregado por modelo, tipo y día calendario AR (últimos 30 días).';

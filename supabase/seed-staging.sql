-- Seed de precios para la Supabase de STAGING del harness de testeo del bot.
--
-- Una staging recién creada no tiene ninguna lista de precios activa, así que
-- los pedidos saldrían con monto en $0 / "a confirmar". Estos valores reproducen
-- los precios observados en producción (agua $200/u, crema $400/u) para que los
-- resúmenes y montos de los escenarios sean realistas.
--
-- Aplicar UNA sola vez, DESPUÉS del `supabase db push` a staging:
--   - desde el SQL Editor del proyecto staging (pegar y ejecutar), o
--   - psql "<STAGING_DB_URL>" -f supabase/seed-staging.sql
--
-- Es de una sola corrida: correrlo dos veces crea listas duplicadas. Si necesitás
-- rehacerlo, borrá antes las filas de listas_precios/reglas_precios de staging.

insert into public.listas_precios (nombre, activa)
values ('staging', true);

insert into public.reglas_precios (lista_id, tipo_producto, min_cantidad, precio_unitario)
select id, 'agua', 1, 200 from public.listas_precios where nombre = 'staging'
union all
select id, 'crema', 1, 400 from public.listas_precios where nombre = 'staging';

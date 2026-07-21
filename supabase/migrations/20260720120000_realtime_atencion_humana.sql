-- Realtime para atencion_humana.
--
-- El toast de "mensaje entrante con toma humana activa" del dashboard necesita
-- que el navegador se entere de las altas/bajas de la toma en vivo (para saber
-- qué teléfonos están "en manos humanas" sin recargar). La RLS de select para
-- authenticated ya está en 20260630120000_chat_manual.sql; solo falta sumarla
-- a la publicación de Realtime.
do $$
begin
  alter publication supabase_realtime add table public.atencion_humana;
exception
  when duplicate_object then null;
end $$;

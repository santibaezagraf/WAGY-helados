-- Realtime para `pedidos`.
--
-- El panel del pedido activo en el chat del dashboard (ChatPanel: info + Editar
-- + Enviar resumen) se hidrata al abrir el chat y hasta ahora NO se actualizaba
-- solo. Consecuencia: el cliente podía completar el pedido en vivo (el bot va
-- guardando el borrador y luego lo confirma) y hasta que no recargabas la
-- página, el panel seguía mostrando "sin pedido" o el estado viejo. Sumamos la
-- tabla a la publicación de Realtime; el chat se suscribe filtrando por teléfono
-- y refresca el panel ante cualquier INSERT/UPDATE/DELETE.
--
-- La RLS de select para `authenticated` (USING true) ya existe desde el schema
-- base (20260113192925), así que esta suma NO abre nada nuevo desde el browser.
-- El bot escribe con service-role y bypassa RLS: sin cambios.

do $$
begin
  alter publication supabase_realtime add table public.pedidos;
exception
  when duplicate_object then null;
end $$;

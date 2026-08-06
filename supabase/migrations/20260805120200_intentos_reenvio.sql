-- Cuenta los intentos consecutivos de reenvío de un resumen que Meta no pudo
-- entregar (ver enviarResumenYPedirConfirmacion en whatsapp.ts y el cron
-- /api/reenviar-resumenes). Sin tope, un borrador atascado por un número
-- bloqueado/token vencido generaba una petición fallida a Meta cada ~2 min
-- durante toda la ventana de 2h del cron (60 intentos), inflando logs sin
-- ninguna chance real de éxito.
alter table pedidos
  add column if not exists intentos_reenvio integer not null default 0;

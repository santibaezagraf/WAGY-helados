-- Columna + trigger que estampan CUÁNDO un pedido entró a cocina (pasó a
-- 'pendiente'), para poder acotar en cuánto tiempo el cliente puede
-- modificarlo por WhatsApp sin intervención humana (ventana de 15 min,
-- ver dentroDePlazoModificacionCocina en procesar.ts).
--
-- Se mantiene en DB (no en TS) porque un pedido puede llegar a 'pendiente'
-- por varios caminos distintos (texto del bot, botón "confirmar_borrador",
-- alta manual desde el dashboard) y todos deben quedar coherentes sin
-- duplicar la lógica en cada call site — mismo criterio que
-- patchConEnviadoCoherente/procesar_pedido_final.
alter table pedidos
  add column if not exists entro_a_cocina_at timestamptz null;

set check_function_bodies = off;

create or replace function public.mantener_entro_a_cocina()
 returns trigger
 language plpgsql
as $function$
begin
  if NEW.estado = 'pendiente' then
    -- Solo estampamos al ENTRAR a 'pendiente' (alta directa, o transición
    -- desde otro estado). Si ya estaba en 'pendiente' y solo cambió otro
    -- campo (ej. "pagado"), no reiniciamos el reloj.
    if TG_OP = 'INSERT' or OLD.estado is distinct from 'pendiente' then
      NEW.entro_a_cocina_at := now();
    end if;
  else
    -- Fuera de 'pendiente' (borrador, cancelado, enviado, esperando_cancelacion)
    -- la marca no aplica: la limpiamos para que un futuro reingreso a
    -- 'pendiente' la vuelva a estampar desde cero.
    NEW.entro_a_cocina_at := null;
  end if;

  return NEW;
end;
$function$
;

create trigger trigger_mantener_entro_a_cocina
  before insert or update on public.pedidos
  for each row execute function public.mantener_entro_a_cocina();

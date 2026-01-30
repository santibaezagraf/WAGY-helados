CREATE OR REPLACE FUNCTION public.manage_single_active_lista()
RETURNS TRIGGER AS $$
BEGIN
  -- Si la nueva lista (o la editada) viene como activa
  IF NEW.activa IS TRUE THEN
    -- Desactivar todas las demas listas (excluyendo la actual si fuera un update)
    UPDATE public.listas_precios
    SET activa = false
    WHERE id <> NEW.id AND activa = true;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_manage_active_lista
BEFORE INSERT OR UPDATE ON public.listas_precios
FOR EACH ROW
EXECUTE FUNCTION public.manage_single_active_lista();
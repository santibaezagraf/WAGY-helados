ALTER TABLE public.listas_precios ADD COLUMN sabores_agua jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.listas_precios ADD COLUMN sabores_crema jsonb DEFAULT '[]'::jsonb;

-- Migrar los sabores hardcodeados a las listas de precios existentes
UPDATE public.listas_precios
SET sabores_agua = '["Frutilla", "Uva", "Limón", "Pico Dulce", "Crema del Cielo", "Caramelo Fizz"]'::jsonb,
    sabores_crema = '["Chocolate", "Vainilla", "Frutilla", "Dulce de leche"]'::jsonb;

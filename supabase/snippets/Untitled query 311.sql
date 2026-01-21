ALTER TABLE pedidos 
DROP COLUMN ganancia;

ALTER TABLE pedidos 
ADD COLUMN precio_total NUMERIC 
GENERATED ALWAYS AS (
  COALESCE(monto_total_agua, 0) + COALESCE(monto_total_crema, 0)
) STORED;
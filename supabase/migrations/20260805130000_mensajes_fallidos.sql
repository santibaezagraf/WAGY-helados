-- Registro de mensajes salientes (bot u operador) que NO llegaron al cliente
-- porque Meta rechazó el envío tras agotar los reintentos de postAMeta
-- (fetch failed persistente, 5xx repetidos, 4xx no-reintentable como fuera
-- de la ventana de 24h). Antes se perdían en silencio: el operador no sabía
-- que el bot "dijo" algo que el cliente nunca vio, y el LLM en su próximo
-- turno leía esa fila como si sí hubiera llegado (razonando contra una
-- pregunta fantasma).
--
-- Convive con `resumen_pendiente` en pedidos: aquel cubre EL RESUMEN
-- (reconstruible desde la fila) y dispara reintentos automáticos; este es
-- registro visual de CUALQUIER envío del bot/operador que no llegó.
alter table mensajes_chat
  add column if not exists fallido boolean not null default false;

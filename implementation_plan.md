# Plan de Implementación: Mejoras y Correcciones del Bot

Este plan aborda las mejoras solicitadas, solucionando casos extremos en la gestión de estado y robusteciendo la arquitectura contra vulnerabilidades.

## Respuesta: ¿Cómo funciona la lógica de botones?

Actualmente, cuando el bot manda un par de botones (ej. Confirmar / Modificar), levanta una "bandera" (un token de un solo uso) en la base de datos poniendo la columna `esperando_respuesta_boton = true` para ese pedido.
WhatsApp por diseño permite que el cliente toque los dos botones todas las veces que quiera. Sin embargo, la función que ejecuta el botón (`consumirTokenRespuesta` en `botones.ts`) hace una actualización **atómica**:
`UPDATE pedidos SET esperando_respuesta_boton = false WHERE esperando_respuesta_boton = true`

El **primer** botón que llega a la base de datos encuentra la bandera en `true`, la baja a `false` y sigue adelante procesando la orden. El **segundo** botón (y cualquier otro intento) va a buscar la bandera, la encuentra en `false`, y la base de datos responde que modificó "0 filas". Al afectar 0 filas, el sistema corta la ejecución de forma silenciosa e ignora el segundo botón. Así se garantiza matemáticamente que solo el primer botón tenga efecto.

---

## Proposed Changes

A continuación se detalla el plan para las mejoras:

### Migraciones de Base de Datos
Se crearán tres archivos nuevos de migración en la carpeta `supabase/migrations/`:
- **[NEW] `20260805120000_mensajes_fallidos.sql`**: Agrega la columna `fallido boolean NOT NULL DEFAULT false` a `mensajes_chat` para registrar cuando Meta rechaza un mensaje (falla silenciosa).
- **[NEW] `20260805120100_aviso_precio_sobreescrito.sql`**: Agrega la columna `aviso_precio_sobreescrito boolean NOT NULL DEFAULT false` a `pedidos`. Actualiza la función `procesar_pedido_final` para que, si el precio era manual y el cliente cambia las cantidades, se desactive el flag manual y se active el aviso.
- **[NEW] `20260805120200_intentos_reenvio.sql`**: Agrega la columna `intentos_reenvio integer NOT NULL DEFAULT 0` a `pedidos`.

### Componentes de WhatsApp (Webhooks y API)
- **[MODIFY] `src/app/api/webhook/route.ts`**
  Agregaremos una verificación sobre la longitud del texto crudo (payload bytes) *antes* de hacer `JSON.parse`. Si `rawBody.length > 20000` (20KB), cortaremos la conexión (Status 413) para prevenir ataques de denegación de servicio que buscan agotar tokens.

- **[MODIFY] `src/lib/whatsapp.ts`**
  Modificaremos `enviarMensajeWhatsApp` para que, si falla permanentemente el envío a Meta, igual haga el `INSERT` en `mensajes_chat` pero seteando `fallido: true`. Así quedará registro visual para el operador.

### Lógica de Estados (Crons y Botones)
- **[MODIFY] `src/app/api/gestionar-borradores/route.ts`**
  En los bloques de auto-rechazo y cancelación colgada, al hacer `update({ estado: 'cancelado' })`, sumaremos `enviado: false` para evitar que quede un estado inconsistente en la base de datos.
  
- **[MODIFY] `src/lib/bot/botones.ts`**
  Lo mismo para las cancelaciones explícitas del cliente (`cancelarBorrador`, `confirmarCancelacion`): agregaremos `enviado: false`.

- **[MODIFY] `src/app/api/reenviar-resumenes/route.ts`**
  Agregaremos la condición `.lt('intentos_reenvio', 5)` a la consulta de borradores colgados, e incrementaremos `intentos_reenvio` en la base de datos dentro del loop de reintento.

### Confusión Text vs Botón (Stale State)
- **[MODIFY] `src/lib/bot/procesar.ts`**
  Agregaremos una guardia rápida al principio de `procesarMensajesDeCliente` o antes de llamar al LLM: si el texto es claramente un "confirmar" o "modificar", pero el estado del pedido actual ya pasó a `pendiente` o `enviado` (porque el cliente quizás tocó el botón y luego escribió), interceptaremos el texto y devolveremos un amigable "Tu pedido ya está confirmado y en marcha 👍", sin invocar a la Inteligencia Artificial.

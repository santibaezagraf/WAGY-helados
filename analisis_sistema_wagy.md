# Análisis del Sistema WAGY Helados (Bot de WhatsApp)

He realizado una revisión profunda de la arquitectura y la lógica del sistema basándome en `CLAUDE.md`, `botones.ts`, `procesar.ts` y la arquitectura descrita. El sistema es sorprendentemente robusto, especialmente en el manejo de concurrencia (debounce + claim atómico), fallback de modelos (para mitigar 429 de Groq) y la forma en que estructura la extracción (operaciones puntuales en lugar de pedirle al LLM que resuelva el JSON completo).

Sin embargo, identifico algunas **áreas de mejora**, **límites arquitectónicos** y **posibles fallas lógicas (edge cases)** que valen la pena considerar:

## 1. Posibles Fallas y Casos Extremos (Edge Cases)

### A. Condiciones de Carrera (Race Conditions) entre Turnos del LLM
El *claim atómico* (`UPDATE ... SET procesado=true`) protege muy bien contra el doble procesamiento del *mismo* lote de mensajes por múltiples wake-ups de QStash. Pero **no protege contra actualizaciones obsoletas (stale updates)** si el cliente manda un segundo mensaje mientras el LLM está procesando el primero:
1. El cliente dice "Confirmar pedido". El worker 1 lee `estado='borrador'`, llama a Groq (tarda 3-5s).
2. Mientras tanto, el cliente manda "Y agregale 1 de crema". El worker 2 se despierta (los 8s de debounce del nuevo mensaje), lee `estado='borrador'`, llama a Groq.
3. El worker 1 termina y hace el UPDATE a `estado='pendiente'`.
4. El worker 2 termina su extracción (intención: modificar) e intenta aplicar los cambios a la base de datos.
**Riesgo:** Si el worker 2 no hace un guard estricto (`.eq('estado', 'borrador')`) en cada uno de sus `UPDATE`, podría mutar un pedido que ya fue confirmado y mandado a cocina. He visto que `botones.ts` es súper estricto con esto (`.eq('estado', 'borrador')`), pero si el flujo de texto en `procesar.ts` usa un `UPDATE` simple basado en el objeto que leyó al principio, podría pisar el estado.

### B. Incoherencia de Estado en Cancelaciones Silenciosas (`enviado=true`)
Como bien detalla la documentación, `estaDespachado` resuelve el problema de desfase asumiendo que `estado='cancelado'` gana siempre, aunque `enviado=true` quede colgado en true tras el auto-rechazo del cron.
**Falla Técnica:** Aunque la lectura (`estaDespachado`) es segura, a nivel de base de datos esto deja un estado inválido y conceptualmente roto (`estado='cancelado'` pero `enviado=true`).
**Solución:** Los crons (`/api/gestionar-borradores`) y las rutinas de auto-cancelación del bot deberían hacer explícitamente `UPDATE ... SET estado='cancelado', enviado=false` para mantener la invariante de datos limpia, en vez de depender 100% de que la lectura enmascare el error.

### C. Vulnerabilidad en el Anti-DoS por Tamaño de Payload
El rate-limit (`RATE_LIMIT_MAX` = 40 msjs por hora) protege maravillosamente contra un ataque de *cantidad*. Sin embargo, el webhook no parece verificar el **tamaño máximo del texto** entrante.
**Riesgo:** Un atacante podría enviar 10 mensajes, cada uno con 50,000 caracteres. El sistema no llega al límite de 40, pero el LLM de Groq va a recibir un payload gigantesco, consumiendo masivamente tokens (agotando el TPD del modelo primario rápidamente) o crasheando por superar el límite de tokens de entrada.
**Solución:** Agregar una validación en el webhook: si el texto supera `X` caracteres (ej. 2000), cortarlo o directamente rechazarlo antes del insert.

### D. Falsos Positivos Críticos en Whisper (Alucinaciones)
El filtrado de alucinaciones de Whisper por `no_speech_prob` y `compression_ratio` es excelente. Sin embargo, Whisper v3 tiene un comportamiento conocido donde, si hay ruido de fondo (como una TV prendida o gente hablando a lo lejos), transcribe una oración completamente inventada **pero con alta confianza**.
**Riesgo:** Si la TV dice "sí, claro", Whisper transcribe "Sí claro" con buena confianza. El bot toma el audio y el *short-circuit* heurístico lo detecta como `CONFIRMACIONES.has("si claro")`. El bot confirmaría el pedido basado en ruido de ambiente.
**Mitigación:** Es un riesgo inherente de la IA, pero se puede agregar una validación donde mensajes de audio que caen directo en short-circuits críticos (como cancelar o confirmar) requieran texto más explícito, o bien notificar al cliente: "Entendí que dijiste 'sí claro', confirmando pedido...".

## 2. Mejoras Propuestas (Sistema y Experiencia de Usuario)

### A. Fallas Silenciosas de Mensajes Salientes
Actualmente, si Meta falla al enviar una respuesta del bot (5xx persistente, o timeout), el bot falla silenciosamente (solo el resumen está protegido por `/api/reenviar-resumenes`).
**Mejora:** Para mensajes de texto arbitrarios ("¿qué gusto de agua querés?"), si `postAMeta` falla después de los 3 retiros, no hay red de seguridad y el cliente se queda esperando. Se podría persistir el mensaje en `mensajes_chat` con `estado='fallido'` (como en WhatsApp original) y que el dashboard lo muestre con un ícono rojo ⚠️ para que el operador sepa que el bot intentó responder pero no llegó.

### B. Precios Manuales Sobrescritos
Se menciona el límite: "Si el operador pone un precio manual en el modal de edición, y el cliente luego cambia las cantidades por WhatsApp, el trigger DB vuelve a calcular el precio usando la lista, pisando el precio manual."
**Mejora:** Agregar una columna booleana `precio_manual (default false)`. Si el operador edita el precio, se setea a `true`. El trigger DB (`procesar_pedido_final`) debe ignorar el cálculo si `precio_manual=true`. Si el cliente cambia la cantidad por el bot, un trigger podría avisar por consola/dashboard o simplemente mantener el flag hasta que el operador lo revise, o bien advertir al operador: "Fijar un precio manual congela futuros recálculos de este pedido".

### C. Retiros de Cron Agresivos
El job `/api/reenviar-resumenes` intenta reenviar cada 2 minutos en una ventana de 2 horas. Si el número del cliente fue bloqueado por Meta (ej. cuenta suspendida) o el token expiró, esto va a hacer 60 peticiones fallidas por cada borrador atascado.
**Mejora:** Agregar una columna `intentos_reenvio` (int) a `pedidos`. Incrementar en el cron y frenar a los 5 intentos, para no desperdiciar recursos ni rellenar los logs con cientos de errores de Meta.

### D. Interacción Text vs Botón Confusa
Si el usuario hace doble acción (toca el botón "Confirmar" y *también* escribe por texto "Dale confirmar"):
1. El botón ejecuta instantáneamente (sin QStash) y pasa a `pendiente`.
2. A los 8s, QStash procesa el texto "Dale confirmar". Como el estado ya es `pendiente`, el texto no cae en el *short-circuit* de borrador (que busca `estado === 'borrador'`).
3. El LLM lo clasifica probablemente como `saludo` o `datos_pedido`, y podría responder al cliente "No te entendí" o algo descontextualizado.
**Mejora:** En `procesarMensajesDeCliente`, guardar el último estado del pedido. Si el mensaje es "Confirmar" (por short circuit o modelo) pero el estado **ya no es** borrador (sino que es `pendiente`), atraparlo y descartarlo silenciosamente o responder: "Tu pedido ya está en cocina, ¡gracias!", en lugar de enviar el mensaje al flujo genérico que podría causar confusión.

### E. Limpieza de Storage (Media Huerfanos)
Las imágenes y audios se descargan al bucket privado de Supabase. Con el tiempo, esto consumirá almacenamiento significativamente, y la documentación indica que "Storage has no retention/cleanup job".
**Mejora:** Hacer que el cron `/api/gestionar-borradores` (o uno nuevo) barra los archivos en el Storage cuya fecha sea mayor a 60 días, basándose en la fecha del archivo o cruzando con la tabla `mensajes_chat`.

## Conclusión

El diseño del Bot y el manejo de concurrencia es de un altísimo nivel. El uso de `QStash` para encolar y debouncer peticiones asíncronas, combinado con *Atomic Claims*, resuelve el 90% de los problemas típicos en bots conversacionales. 

Las mejoras más críticas que sugiero apuntan a **edge cases defensivos**:
1. Prevenir payload abuse en el webhook (tamaño de texto).
2. Evitar que un mensaje de confirmación tardío confunda al usuario si ya confirmó por botón.
3. Arreglar el *stale state* de `enviado=true` en cancelaciones (para mejor higiene de datos).

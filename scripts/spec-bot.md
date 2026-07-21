# Spec del bot para el juez (paso 2 del harness)

Esta es la referencia que usa Claude Code para **juzgar** las conversaciones que
genera `scripts/probar-bot.mjs`. Es un resumen curado del contrato del bot,
derivado de [CLAUDE.md](../CLAUDE.md). **Cuando cambie el comportamiento del bot,
actualizá este archivo** (si no, el juez juzga contra reglas viejas).

Flujo: `npm run probar-bot` escribe `informes-bot/corrida-<ts>/transcripts.md`
(entrada del juez). El juez lee ese archivo + este spec y escribe
`informe.md` en la misma carpeta.

---

## Qué es el bot

Toma pedidos de una heladería (WAGY) por WhatsApp, en español rioplatense
informal. Extrae datos con un LLM y escribe en la tabla `pedidos`. Vende dos
tipos de helado por cantidad: **agua** y **crema**. Un pedido necesita:
**cantidad(es)**, **dirección** (o "retira") y **método de pago**
(`efectivo` / `transferencia`).

## Máquina de estados (`pedidos.estado`)

`borrador` → `pendiente` → `enviado`, con `esperando_cancelacion` y `cancelado`
como ramas.

- **borrador**: armándose. Puede ser **parcial** (faltan datos) — el bot pide lo
  que falta y **no manda el resumen** hasta que esté completo.
- Completo → el bot manda un **resumen con botones** (Confirmar / Modificar) y
  arma `esperando_respuesta_boton`.
- **pendiente**: confirmado, a cocina.
- **enviado**: despachado. Terminal para el cliente (no se cancela ni modifica).
  El bot trata como "despachado" también a `enviado=true` aunque el estado siga
  en `pendiente` (`estaDespachado`).
- **esperando_cancelacion**: el bot preguntó "¿seguro?" y espera sí/no.
- **cancelado**: cancelado (por el cliente o auto-rechazo del cron). Si el cliente se arrepiente **dentro de los ~30 min** de cancelar ("no, quiero el pedido"), el bot lo **reactiva** (vuelve a `borrador` con sus datos originales) en vez de arrancar uno nuevo desde cero.

## Comportamientos esperados (el "debería")

1. **Pedido completo de una** → borrador completo + resumen con botones. Confirmar → pendiente + mensaje de confirmación con tiempo estimado.
2. **Datos por partes** → pide SOLO lo que falta, sin perder lo ya dicho (merge determinístico contra la DB). No manda resumen hasta completar.
3. **Cantidades como operación**: "sumale 10" es delta (suma), "que sean 25" es reemplazo. El bot no debe confundir delta con total.
4. **Dirección**: exige calle + número, o "retira" para retiro en local. Un texto que no parece dirección (p.ej. "depto 6" solo) no debe entrar como dirección. Las variantes/conjugaciones de retirar ("retiro", "paso a retirar", "lo paso a buscar", "lo busco", "paso por el local") se mapean al sentinela `retira` aunque vengan inline con el resto del pedido (red determinista `mencionaRetiro`, que se aplica solo si no quedó una dirección de envío válida).
5. **Método de pago**: efectivo o transferencia. Con transferencia, la **confirmación** (no el resumen) incluye el alias y pide comprobante.
6. **Cancelación**: "cancelar" → pide confirmación con botones, NO cancela de una. Sí → cancelado. Si en vez de sí/no manda cambios concretos → **rechazo implícito**: vuelve a borrador con los cambios aplicados y reenvía el resumen. **Deshacer una cancelación**: si el cliente se arrepiente enseguida (≤30 min) de un pedido ya cancelado ("no, quiero el pedido"), el bot lo **reactiva** con sus datos originales (no pierde cantidad/pago ni arranca de cero).
7. **Mensaje partido** (varias burbujas): se procesan como UN turno (debounce + claim). Un solo resumen, sin pedidos duplicados, sin responder N veces.
8. **Sobre pedido despachado**: se rechaza modificar/cancelar ("ya está en camino").
9. **Un solo click por ronda de botones**: tocar ambos botones de un par no dispara dos acciones contradictorias.
10. **Consulta de negocio real** (horarios, zonas, sabores disponibles, stock, promos, mayorista, reclamos) que el bot no puede responder → **delegación a humano**: marca `requiere_atencion` y responde "te atiende una persona", SIN tocar el pedido activo. Esto vale **también cuando la pregunta viene mezclada con datos de pedido**: el modelo copia la pregunta en el campo ortogonal `pregunta_negocio`, el bot delega esa pregunta a un humano **y además procesa el pedido** (resumen o pide lo que falta). La pregunta ya NO se descarta en silencio.
11. **Media** (foto/audio/video) → delega a humano. **Ubicación** (pin) → NO delega: pide la dirección escrita.

## Señales de "❓ NO CONTEMPLADO" (lo más valioso de detectar)

El bucket ❓ es cuando el bot **no tiene un camino diseñado** para el caso y lo
resuelve por accidente (o mal). Señales:

- Cae en el fallback genérico **"no te entendí / solo leo texto"** ante algo que un cliente real diría con naturalidad.
- **Delega a humano** algo que NO es una consulta de negocio real (usar la delegación como cajón de sastre / cop-out).
- Un mensaje **mezcla pedido + pregunta de negocio real**: el bot debería procesar el pedido **Y** delegar la pregunta a un humano (campo `pregunta_negocio`). Si la pregunta se **descarta en silencio** (el cliente queda sin respuesta) o, peor, el pedido tampoco se procesa (cae al saludo genérico), es ❓.
- El pedido queda **trabado** en un estado (p.ej. `esperando_cancelacion` sin salida, borrador que nunca completa).
- **Loop**: el bot repite el mismo pedido de dato o el mismo resumen sin avanzar.
- **Pérdida de datos**: una cantidad/dirección/sabor dicha antes desaparece tras un turno siguiente.
- Contradicción entre lo que dice el bot y el estado real del pedido.

Distinguir **"bien por diseño"** de **"bien por accidente"**: si el bot acertó
pero por un camino que claramente no estaba pensado para eso (o que se rompería
con una variante mínima), marcarlo y explicarlo.

## Rúbrica de veredicto

Para cada escenario, un veredicto por bucket:

- **✅ bien**: el bot siguió el flujo esperado. Para guionados, `chequeoAutomatico` en verde Y los `criterios` cumplidos.
- **⚠️ a mejorar**: funcionó pero con fricción — respuesta confusa/robótica, pasos de más, tono, un criterio parcial, o "bien por accidente" frágil.
- **❓ no contemplado**: el bot no tiene camino para el caso (ver señales arriba). Indicar **qué falta plantear**.

Además, **severidad** (alta / media / baja) según impacto en un cliente real
(alta = pierde el pedido, recibe algo cancelado, o queda sin respuesta).

## Formato del `informe.md` que produce el juez

1. **Resumen**: conteo por bucket, tasa de ✅, y los hallazgos más graves arriba.
2. **Por escenario**: nombre, persona/objetivo, veredicto (✅/⚠️/❓), severidad, qué esperaba vs qué pasó (citando el transcript), y para ❓ qué habría que plantear en el bot.
3. **Recomendaciones priorizadas**: qué mejorar primero.

Notas de contexto para no marcar falsos positivos:
- El harness corre con `BOT_TEST_MODE=1`: **no se mandan WhatsApp reales**, las respuestas se leen de `mensajes_chat`. La ausencia de "envío real" NO es un bug.
- El debounce se saltea atrasando `created_at`; no juzgar tiempos de espera.
- Los teléfonos `54000…` son de test.

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
3. **Cantidades como operación**: "sumale 10" es delta (suma), "que sean 25" es reemplazo. El bot no debe confundir delta con total. Esto incluye el **número pelado** (una cantidad sin repetir el tipo): si hay exactamente UN tipo con cantidad > 0, "son 30 ahora" / "son 40" / "ponele 30" es un **reemplazo sobre ese tipo** — no se puede ignorar. Una pista de delta pegada al número ("5 más", "sumale 5") sí lo hace suma, pero una palabra suelta en OTRA oración no ("me pidieron mas. son 30 ahora" → 30, no 50). Si los DOS tipos tienen cantidad > 0, el número es ambiguo: el bot **pregunta** de cuál son, nunca adivina ni lo descarta. Esto vale tanto para el **reemplazo pelado** ("que sean 30" → red `detectarCantidadPelada`) como para el **delta pelado** ("sumale 10" / "sacale 5" → red `detectarDeltaPelado`): en el delta la pregunta dice qué se **suma/saca** y los botones aplican la operación, no un reemplazo (10 sobre 40 → 50, no → 10). **Señal de ⚠️**: el bot repite el mismo pedido de datos faltantes —o contesta un genérico "no te entendí"— sin acusar recibo del número nuevo, ante un "sumale 10" sobre un pedido con los dos tipos cargados. **Unidades que no vendemos**: si la cantidad viene en kilos/gramos/potes/porciones/bolas/cucuruchos, el bot NUNCA la convierte ni la usa como si fueran unidades — ni siquiera para corregir un pedido ya armado — y explica que se vende por unidad. **Señal de ⚠️**: el pedido queda con el número de kilos como si fueran helados (ej. 40 → 2), o el bot contesta un genérico "no te entendí".
4. **Dirección**: exige calle + número, o "retira" para retiro en local. Un texto que no parece dirección (p.ej. "depto 6" solo) no debe entrar como dirección. Las variantes/conjugaciones de retirar ("retiro", "paso a retirar", "lo paso a buscar", "lo busco", "paso por el local") se mapean al sentinela `retira` aunque vengan inline con el resto del pedido (red determinista `mencionaRetiro`, que se aplica solo si no quedó una dirección de envío válida).
5. **Método de pago**: efectivo o transferencia. Con transferencia, la **confirmación** (no el resumen) incluye el alias y pide comprobante.
6. **Cancelación**: "cancelar" → pide confirmación con botones, NO cancela de una. Sí → cancelado. Un **"no" claro** (incluso "no lo cancelo" mezclado con otra frase, p.ej. "no, no lo cancelo, dame el total ya" — pedir el total es una consulta, no un cambio) → vuelve al estado anterior y reenvía el resumen; **no debe quedar trabado** en `esperando_cancelacion`. Si en vez de sí/no manda cambios concretos → **rechazo implícito**: vuelve a borrador con los cambios aplicados y reenvía el resumen. **Deshacer una cancelación**: si el cliente se arrepiente enseguida (≤30 min) de un pedido ya cancelado ("no, quiero el pedido"), el bot lo **reactiva** con sus datos originales (no pierde cantidad/pago ni arranca de cero). **Después del rechazo** el pedido vuelve a ser un borrador normal: un "sí, confirmá" por texto debe **confirmarlo y mandarlo a cocina**. **Señal de ⚠️**: el bot reenvía el mismo resumen otra vez y el pedido queda trabado en `borrador` (redes `mencionaConfirmacion` + clamp de intención por estado). A la inversa, **repetir el pedido no es confirmarlo**: si con el resumen pendiente el cliente reescribe los mismos datos sin ninguna señal de afirmación, el bot reenvía el resumen — nunca lo manda a cocina. **Señal de ⚠️**: un pedido pasa a `pendiente` sin que el cliente haya dicho que sí ni tocado el botón.
7. **Mensaje partido** (varias burbujas): se procesan como UN turno (debounce + claim). Un solo resumen, sin pedidos duplicados, sin responder N veces.
8. **Sobre pedido despachado**: se rechaza modificar/cancelar ("ya está en camino").
9. **Un solo click por ronda de botones**: tocar ambos botones de un par no dispara dos acciones contradictorias.
10. **Consulta de negocio**: el bot primero intenta **responderla él mismo** desde el conocimiento que tiene (tipos agua/crema, sabores, demora de entrega, envíos/costo, formas de pago, y datos del pedido en curso como el **total**). Lo hace con una respuesta **breve** generada con contexto acotado (schema `{puede_responder, respuesta}`); si el dato NO está en ese contexto (horarios exactos, zonas/cobertura puntual, stock del día, promos, mayorista, reclamos, facturación) → **delega a un humano**: marca `requiere_atencion` y responde "te atiende una persona", SIN tocar el pedido activo. Esto vale **también cuando la pregunta viene mezclada con datos de pedido** (campo ortogonal `pregunta_negocio`): el bot responde/delega la pregunta **y además procesa el pedido** (resumen o pide lo que falta). La pregunta ya NO se descarta en silencio — y el **dato del pedido tampoco**: "transferencia. y hasta qué hora entregan?" tiene que delegar el horario Y guardar el pago en el MISMO turno, sin volver a pedirlo después. Una pregunta **pura** (sin datos nuevos, aunque el mensaje repita datos que el pedido YA tiene) se responde/delega y **nada más**: es UNA sola burbuja (la respuesta o el "te atiende una persona"), sin un segundo mensaje. Esto vale en cualquier estado del pedido: con el resumen ya enviado (no reenvía el resumen), **sobre un borrador a medio armar** (no vuelve a pedir los datos que faltan), y **para un cliente conocido sin pedido en curso**. Tener una dirección guardada NO es un pedido iniciado, así que una consulta pura NUNCA debe disparar un "Para armar tu pedido me falta: cantidad, pago". La dirección histórica es una comodidad para cuando el cliente SÍ está pidiendo, no un dato aportado hoy. **Señal de ⚠️**: tras contestar/delegar la consulta, una segunda burbuja re-pidiendo los datos faltantes. El bot **sabe qué es y qué puede hacer**: "¿qué sabés hacer?" / "¿sos un bot?" las contesta él, no las delega. Cuando la "pregunta" es en realidad una **confirmación retórica del cambio que el bot está aplicando en ese mismo mensaje** ("Me los mandan ahí no?" sobre la dirección nueva, "¿entonces son 30?", "¿queda así?"), el bot la contesta él —el pedido actualizado que sale a continuación **ya es la respuesta**— y **no** delega ni prende `requiere_atencion`: sería una burbuja que la burbuja siguiente contradice, y un aviso al staff por algo ya resuelto. Ojo con no pasarse para el otro lado: "¿llegan hasta allá?" es cobertura de zona y **sí** se delega. **Señal de ⚠️/❓**: delegar a un humano algo que el bot conoce de memoria (ej: "¿tenés de agua o de crema?"); **contradicción** "no te puedo responder" + contestarlo igual en la burbuja siguiente; o —tras contestar/delegar bien una consulta pura— mandar **encima** un "no te entendí, ¿confirmamos?" / reenviar el resumen (segunda burbuja contradictoria). Si delega varias veces seguidas, el texto debe **variar** (no repetir palabra por palabra).
11. **Media** (foto/audio/video) → delega a humano. **Ubicación** (pin) → NO delega: pide la dirección escrita.
12. **Cantidad sin tipo de helado**: si el cliente dice cuántos quiere pero NO si son de agua o de crema ("quiero 50 helados de frutilla"), el bot **NO debe adivinar el tipo** (ni deducirlo del sabor: un mismo sabor puede existir en los dos). Debe **preguntar el tipo** repitiendo la cantidad, con los dos botones ("50 de agua" / "50 de crema"), y recién con la respuesta cargar la cantidad. La pregunta es **libre pero acotada** al conocimiento real (puede decir en qué tipo está el sabor pedido, o que ese sabor no lo tenemos), nunca inventar sabores ni delegar a un humano — los sabores son un dato que el bot conoce. **Señal de ⚠️/❌**: un pedido con 50 de agua y "los de agua frutilla" en observaciones cuando el cliente nunca dijo "de agua".

13. **Formato ≠ sabor ≠ stock**. "Palito", "palita", "paleta" y "bombón" son formas de nombrar **nuestro producto** por su formato: son los mismos helados de agua/crema, no un producto aparte y **no un sabor**. De ahí salen dos obligaciones:
    - **Nunca persistir un formato como sabor.** "20 palitos de crema" es 20 helados de crema **sin sabor declarado**; un pedido que queda con `observaciones: "palitos"` es un **dato inventado** (❌), no una imprecisión. Si el cliente nombró el formato pero no el sabor, el bot se lo **pregunta** y le lista los sabores reales de ese tipo, en vez de dejarlo sin sabor y sin avisar. Los sabores son opcionales: la pregunta no bloquea el armado del pedido.
    - **Enumerar los sabores es CATÁLOGO, no stock.** "¿Qué sabores tenés?", "¿qué palitos hay?", "elegime uno de crema", "¿qué me recomendás?" son todas preguntas que el bot **responde él mismo** con la lista. Lo único que no sabe de sabores es si uno está **agotado hoy**. **Señal de ❓**: delegar a un humano un pedido de lista/recomendación de sabores — es el caso del punto 10 aplicado al área que el bot mejor conoce.

    Los sabores que el bot nombra salen de la **lista de precios activa** (son configurables desde el dashboard), no de una constante del código: si el staff los cambia, el bot tiene que decir los nuevos.

14. **Off-topic e insistencia**: un mensaje que no tiene nada que ver (el partido, un chiste, una cuenta matemática) NO se delega a un humano ni se contesta: el bot reencauza pidiendo los datos del pedido. Pero si el cliente insiste turno tras turno, el bot **no puede responder el texto calcado**: el encabezado rota, y **desde la tercera vez** deja de saludar como si la conversación recién empezara y reconoce que viene contestando lo mismo. **Señal de ⚠️**: dos respuestas idénticas palabra por palabra en la misma conversación, o un "¡Hola! 👋 ¿Qué te gustaría pedir?" en el cuarto turno seguido. El fondo no cambia nunca: los tres datos que faltan se siguen listando igual.

## Señales de "❓ NO CONTEMPLADO" (lo más valioso de detectar)

El bucket ❓ es cuando el bot **no tiene un camino diseñado** para el caso y lo
resuelve por accidente (o mal). Señales:

- Cae en el fallback genérico **"no te entendí / solo leo texto"** ante algo que un cliente real diría con naturalidad.
- **Delega a humano** algo que NO es una consulta de negocio real (usar la delegación como cajón de sastre / cop-out).
- Un mensaje **mezcla pedido + pregunta de negocio real**: el bot debería procesar el pedido **Y** delegar la pregunta a un humano (campo `pregunta_negocio`). Si la pregunta se **descarta en silencio** (el cliente queda sin respuesta) o, peor, el pedido tampoco se procesa (cae al saludo genérico), es ❓.
- El pedido queda **trabado** en un estado (p.ej. `esperando_cancelacion` sin salida, borrador que nunca completa).
- **Loop**: el bot repite el mismo pedido de dato o el mismo resumen sin avanzar.
- **Pérdida de datos**: una cantidad/dirección/sabor dicha antes desaparece tras un turno siguiente.
- **Dato inventado**: el bot escribe en el pedido algo que el cliente no dijo (p.ej. el tipo de helado cuando solo nombró el sabor). Es peor que preguntar de más.
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

// Escenarios para el harness de testeo conversacional del bot (probar-bot.mjs).
//
// Dos tipos, mismo formato base { nombre, tipo, persona, ... }:
//
//  - GUIONADOS: turnos fijos (no usan LLM del lado del cliente) + un `espera`
//    con el flujo/estado esperado. Sirven como suite de regresión: el juicio
//    contra `espera` es casi mecánico. Ideales para el camino feliz y las
//    invariantes conocidas del bot.
//
//  - EXPLORATORIOS (fase 2): un `objetivo` + `persona` que un cliente-agente LLM
//    usa para improvisar mensajes turno a turno. No traen `espera` fija; el juez
//    (Claude Code) decide si el bot lo resolvió por diseño o por accidente.
//
// TURNOS (guionados). Cada uno es:
//   { texto: '...' }                     un mensaje del cliente
//   { textos: ['...', '...'] }           un "mensaje partido" (varias burbujas seguidas)
//   { boton: 'confirmar_borrador' }      un click de botón; el pedidoId se resuelve
//                                        solo contra el último pedido del teléfono
//     accion válida: confirmar_borrador | modificar_borrador
//                    confirmar_cancelacion | rechazar_cancelacion
//
// ESPERA (guionados). Campos opcionales que lee el juez:
//   estadoFinal        estado esperado del pedido ('borrador'|'pendiente'|'cancelado'|...)
//   cantidad_agua / cantidad_crema     números esperados
//   direccionContiene  substring esperado en la dirección (o 'retira')
//   metodo_pago        'efectivo' | 'transferencia'
//   criterios          lista de afirmaciones en lenguaje natural que el juez verifica

export const ESCENARIOS = [
  {
    nombre: 'pedido-nuevo-completo',
    tipo: 'guionado',
    persona: 'Cliente que da todo junto en el primer mensaje y confirma.',
    turnos: [
      { texto: 'hola! quería 10 de crema para mandar a Mitre 951, pago en efectivo' },
      { boton: 'confirmar_borrador' },
    ],
    espera: {
      estadoFinal: 'pendiente',
      cantidad_crema: 10,
      cantidad_agua: 0,
      direccionContiene: 'Mitre 951',
      metodo_pago: 'efectivo',
      criterios: [
        'El bot arma un borrador completo y manda un resumen pidiendo confirmación con botones (Confirmar / Modificar).',
        'Tras el click de Confirmar, el pedido queda en pendiente (a cocina) y el bot manda un mensaje de confirmación con tiempo estimado de entrega.',
      ],
    },
  },

  {
    nombre: 'armado-por-partes',
    tipo: 'guionado',
    persona: 'Cliente que suelta un dato por mensaje y hay que ir juntándolos.',
    turnos: [
      { texto: 'buenas, quiero 20 de agua' },
      { texto: 'mandámelos a Rivadavia 123' },
      { texto: 'efectivo' },
      { boton: 'confirmar_borrador' },
    ],
    espera: {
      estadoFinal: 'pendiente',
      cantidad_agua: 20,
      direccionContiene: 'Rivadavia 123',
      metodo_pago: 'efectivo',
      criterios: [
        'Con datos incompletos el bot NO manda el resumen: pide el dato que falta (dirección, y luego método de pago) sin perder la cantidad ya dicha.',
        'Cuando se completa, manda el resumen con 20 de agua y los botones de confirmación.',
        'El click de Confirmar lo pasa a pendiente.',
      ],
    },
  },

  {
    nombre: 'sumar-cantidad-sobre-borrador',
    tipo: 'guionado',
    persona: 'Cliente que pide y después quiere agregar más de lo mismo.',
    turnos: [
      { texto: 'hola, 30 de agua a San Martín 456, transferencia' },
      { texto: 'uh, sumale 10 más de agua' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_agua: 40,
      direccionContiene: 'San Martín 456',
      metodo_pago: 'transferencia',
      criterios: [
        '"sumale 10 más de agua" es un delta: la cantidad final debe ser 40, no 10.',
        'El bot reenvía el resumen actualizado con 40 de agua y vuelve a pedir confirmación.',
      ],
    },
  },

  {
    nombre: 'transferencia-muestra-alias',
    tipo: 'guionado',
    persona: 'Cliente que paga por transferencia y confirma.',
    turnos: [
      { texto: 'quiero 10 de crema, La Plata 100, pago por transferencia' },
      { boton: 'confirmar_borrador' },
    ],
    espera: {
      estadoFinal: 'pendiente',
      cantidad_crema: 10,
      metodo_pago: 'transferencia',
      criterios: [
        'Al confirmar, el mensaje de confirmación incluye el alias para transferir y pide el comprobante.',
      ],
    },
  },

  {
    nombre: 'retira-en-local',
    tipo: 'guionado',
    // La red determinista mencionaRetiro (procesar.ts) mapea "paso a retirar"
    // inline al sentinela direccion="retira" aunque el modelo no lo haga, así el
    // borrador queda completo en el primer turno y el resumen sale con botones.
    persona: 'Cliente que pasa a buscar el pedido en vez de pedir envío.',
    turnos: [
      { texto: 'hola, 15 de crema, paso a retirar, pago en efectivo' },
      { boton: 'confirmar_borrador' },
    ],
    espera: {
      estadoFinal: 'pendiente',
      cantidad_crema: 15,
      direccionContiene: 'retira',
      metodo_pago: 'efectivo',
      criterios: [
        'El bot entiende "paso a retirar" como retiro en local (dirección = "retira"), sin pedir una dirección de envío.',
        'La confirmación habla de pasar a buscarlo, no de envío a domicilio.',
      ],
    },
  },

  {
    nombre: 'cancelar-y-confirmar',
    tipo: 'guionado',
    persona: 'Cliente que confirma un pedido y después se arrepiente del todo.',
    turnos: [
      { texto: 'hola, 10 de agua a Belgrano 500, efectivo' },
      { boton: 'confirmar_borrador' },
      { texto: 'che, quiero cancelar el pedido' },
      { boton: 'confirmar_cancelacion' },
    ],
    espera: {
      estadoFinal: 'cancelado',
      criterios: [
        'Ante "quiero cancelar" el bot pide confirmación de la cancelación con botones (Sí / No), no cancela de una.',
        'Tras el click de confirmar cancelación, el pedido queda en cancelado y el bot lo avisa.',
      ],
    },
  },

  {
    nombre: 'cancelar-rechazo-implicito',
    tipo: 'guionado',
    persona: 'Cliente que empieza a cancelar pero en el medio cambia el pedido.',
    turnos: [
      { texto: 'hola, 10 de crema a Sarmiento 800, efectivo' },
      { boton: 'confirmar_borrador' },
      { texto: 'quiero cancelar' },
      { texto: 'no, mejor sumale 5 de crema y dejalo' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 15,
      criterios: [
        'Estando en esperando_cancelacion, un mensaje con cambios concretos se toma como rechazo implícito de la cancelación.',
        'El pedido vuelve a borrador con 15 de crema y el bot manda el resumen actualizado — NO vuelve a preguntar sí/no.',
      ],
    },
  },

  {
    nombre: 'descancelar-reabre-pedido',
    tipo: 'guionado',
    // #3 del informe: tras confirmar una cancelación, si el cliente se arrepiente
    // enseguida, el bot reabre el pedido cancelado con SUS datos (intent
    // "reactivar", habilitado solo cuando hay un cancelado reciente) en vez de
    // arrancar de cero perdiendo cantidad/pago.
    persona: 'Cliente que cancela y enseguida se arrepiente y quiere el pedido de vuelta.',
    turnos: [
      { texto: 'hola, 8 de crema a Rivadavia 456, efectivo' },
      { boton: 'confirmar_borrador' },
      { texto: 'che, cancelá el pedido' },
      { boton: 'confirmar_cancelacion' },
      { texto: 'no, pará, en realidad sí lo quiero' },
      { boton: 'confirmar_borrador' },
    ],
    espera: {
      estadoFinal: 'pendiente',
      cantidad_crema: 8,
      direccionContiene: 'Rivadavia 456',
      metodo_pago: 'efectivo',
      criterios: [
        'Tras el click de confirmar cancelación el pedido queda cancelado.',
        'Cuando el cliente se arrepiente ("en realidad sí lo quiero"), el bot REABRE el pedido cancelado con sus datos (8 de crema, Rivadavia 456, efectivo) en vez de arrancar de cero: NO vuelve a pedir cantidad ni pago.',
        'Reenvía el resumen con botones y, al confirmar, queda en pendiente con los datos originales.',
      ],
    },
  },

  {
    nombre: 'mensaje-partido',
    tipo: 'guionado',
    persona: 'Cliente que escribe en varias burbujas seguidas antes de que el bot conteste.',
    turnos: [
      { textos: ['hola buenas', 'quería 10 de crema', 'para Belgrano 789', 'pago efectivo'] },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 10,
      direccionContiene: 'Belgrano 789',
      metodo_pago: 'efectivo',
      criterios: [
        'El bot procesa las 4 burbujas como un solo turno (debounce + claim) y arma UN borrador completo.',
        'No responde 4 veces ni crea pedidos duplicados; manda un único resumen con botones.',
      ],
    },
  },

  {
    nombre: 'pedido-mas-pregunta-guionado',
    tipo: 'guionado',
    // Versión completa de A: la pregunta de negocio se copia en `pregunta_negocio`
    // (ortogonal a la intención) y se delega a un humano SIEMPRE, aunque el pedido
    // se arme igual. Antes la pregunta mezclada con datos se descartaba en silencio.
    persona: 'Cliente que arma un pedido completo y en el mismo mensaje pregunta algo del negocio.',
    turnos: [
      { texto: 'quiero 10 de crema para Mitre 951, pago efectivo. ¿hasta qué hora entregan hoy?' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 10,
      direccionContiene: 'Mitre 951',
      metodo_pago: 'efectivo',
      criterios: [
        'El bot arma el borrador completo (10 de crema, Mitre 951, efectivo) y manda el resumen con botones de confirmación.',
        'ADEMÁS delega la pregunta de negocio ("hasta qué hora entregan") a un humano: avisa que le responde una persona del equipo. La pregunta NO se descarta en silencio.',
      ],
    },
  },

  {
    nombre: 'consulta-pura-con-eco-no-repite-no-entendi',
    tipo: 'guionado',
    // Caso real observado en producción: con el resumen ya enviado, el cliente
    // hace una pregunta PURA de negocio ("hasta qué hora abren?"). El modelo la
    // clasifica consulta_negocio pero copia metodo_pago/direccion del pedido (ECO,
    // no datos nuevos); traeDatosDePedido cuenta el eco y el override la manda al
    // path mixto. La pregunta se delega bien, pero al no haber cambios reales el
    // bot mandaba ENCIMA un "no te entendí, ¿confirmamos?" — segunda burbuja
    // contradictoria justo después de "ya le pasé tu consulta a una persona".
    persona: 'Cliente con un pedido completo esperando confirmación que pregunta el horario de atención.',
    turnos: [
      { texto: 'hola, 20 de crema frutilla, retiro, transferencia' },
      { texto: 'hasta que hora estan abiertos?' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 20,
      cantidad_agua: 0,
      direccionContiene: 'retira',
      metodo_pago: 'transferencia',
      criterios: [
        'El bot delega la pregunta de horario a un humano (avisa que le responde una persona): el horario exacto no está en su contexto.',
        'CLAVE: NO manda una segunda burbuja contradictoria del tipo "no te entendí, ¿confirmamos?" ni reenvía el resumen encima de la respuesta a la consulta.',
        'La pregunta era PURA: aunque el mensaje no traía datos nuevos (el pago/dirección ya estaban en el pedido), el bot no la trata como una modificación fallida.',
        'El pedido queda intacto (20 de crema, retira, transferencia) esperando la confirmación; los botones del resumen anterior siguen disponibles.',
      ],
    },
  },

  {
    nombre: 'consulta-pura-sin-pedido-no-pide-datos',
    tipo: 'guionado',
    // Caso real observado en producción: un cliente (sin pedido en curso) hace una
    // pregunta PURA de negocio. El bot la contesta/delega bien, pero DESPUÉS
    // mandaba "Para armar tu pedido me falta: cantidad, pago" — porque si el
    // cliente tenía dirección guardada, la inyección histórica dejaba faltaDireccion
    // en false y el flujo creía que había un pedido a medio armar. Una consulta no
    // es un pedido iniciado: tener dirección guardada no cuenta como dato aportado.
    persona: 'Cliente que solo pregunta cosas del negocio, sin intención de pedir todavía.',
    turnos: [
      { texto: 'hola, una consulta: ¿tenés helados de agua o de crema?' },
      { texto: '¿y hacen envío o solo retiro?' },
    ],
    espera: {
      // No se crea ningún pedido: es solo una consulta. Sin campos mecánicos de
      // pedido; el juez verifica el contrato por los criterios.
      criterios: [
        'El bot responde cada consulta (tipos de helado los sabe; envío/retiro también) o la delega si no la sabe, en UNA sola burbuja por turno.',
        'CLAVE: NO manda un "Para armar tu pedido me falta: cantidad / pago" ni ningún prompt de armado de pedido después de contestar. El cliente solo preguntó, no empezó a pedir.',
        'No inventa ni asume un pedido: no hay cantidades, no muestra un resumen. Si el cliente tuviera dirección guardada, NO la usa para simular un pedido a medio armar.',
      ],
    },
  },

  {
    nombre: 'consulta-pura-sobre-borrador-parcial-no-repide',
    tipo: 'guionado',
    // Caso real observado en producción: con un borrador a medio armar (falta
    // dirección y/o pago), el cliente hace una pregunta PURA de negocio. El bot la
    // delega bien, pero DESPUÉS volvía a mandar "Para armar tu pedido me falta…"
    // porque el borrador sigue incompleto — una segunda burbuja de armado pisando
    // la respuesta a la consulta. La pregunta no cambió el pedido: no hay que
    // re-pedir nada.
    persona: 'Cliente que empezó a armar un pedido y en el medio pregunta algo del negocio.',
    turnos: [
      { texto: 'hola, quiero 10 de crema' },
      { texto: '¿hasta qué hora están abiertos?' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 10,
      cantidad_agua: 0,
      criterios: [
        'Tras el primer mensaje el bot arma un borrador parcial (10 de crema) y pide lo que falta (dirección y forma de pago).',
        'Ante la pregunta de horario, el bot la contesta o la delega a un humano (el horario exacto no lo sabe), en UNA sola burbuja.',
        'CLAVE: NO vuelve a mandar "Para armar tu pedido me falta…" ni ningún prompt de armado DESPUÉS de responder la consulta. La pregunta no modificó el pedido.',
        'El borrador queda intacto (10 de crema, todavía sin dirección ni pago) esperando que el cliente continúe cuando quiera.',
      ],
    },
  },

  // ── Regresiones del informe nightly 32740622175 ──────────────────────────
  // Los tres bugs de esa corrida salieron en EXPLORATORIOS porque no había
  // guionado que los cubriera. Estos cierran ese hueco.

  {
    nombre: 'reemplazar-cantidad-sin-tipo',
    tipo: 'guionado',
    // Hallazgo #3: con 20 de crema cargados, "son 30 ahora" y "son 40" no se
    // aplicaban NUNCA (el modelo devolvía mantener y el literal se descartaba en
    // silencio). El guionado que existía, `sumar-cantidad-sobre-borrador`, solo
    // cubre el DELTA — el reemplazo con número pelado no estaba cubierto.
    persona: 'Cliente indeciso que corrige la cantidad varias veces sin repetir el tipo de helado.',
    turnos: [
      { texto: 'hola, 20 de crema de chocolate a Mitre 951, efectivo' },
      { texto: 'espera un toque, me pidieron mas. son 30 ahora' },
      { texto: 'che, se me va la mano, son 40' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 40,
      cantidad_agua: 0,
      direccionContiene: 'Mitre 951',
      metodo_pago: 'efectivo',
      criterios: [
        '"son 30 ahora" es un REEMPLAZO sobre los de crema (el único tipo cargado), no una suma ni algo a ignorar.',
        'El "mas" de "me pidieron mas" está en otra oración: NO convierte el 30 en un delta. La cantidad debe quedar en 30, no en 50.',
        '"son 40" vuelve a reemplazar: la cantidad final es 40.',
        'El bot reenvía el resumen actualizado con la cantidad nueva; no repite el mismo mensaje de datos faltantes.',
      ],
    },
  },

  {
    nombre: 'cantidad-pelada-con-dos-tipos',
    tipo: 'guionado',
    // Caso hermano del anterior: con los DOS tipos cargados no se puede saber a
    // cuál se refiere un número pelado. La regla del sistema es no adivinar nunca
    // el tipo (misma razón que `cantidad_sin_tipo`), así que debe preguntar.
    persona: 'Cliente con agua y crema en el pedido que corrige la cantidad sin decir de cuál.',
    turnos: [
      { texto: 'hola, 10 de agua y 10 de crema a Mitre 951, efectivo' },
      { texto: 'mejor que sean 30' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_agua: 10,
      cantidad_crema: 10,
      direccionContiene: 'Mitre 951',
      metodo_pago: 'efectivo',
      criterios: [
        'Con los dos tipos cargados, el bot NO adivina a cuál se refiere "que sean 30": pregunta si esos 30 son de agua o de crema.',
        'Tampoco ignora el número en silencio (que es lo que hacía antes): la pregunta menciona la cantidad 30.',
        'Las cantidades quedan intactas (10 y 10) hasta que el cliente aclare el tipo.',
      ],
    },
  },

  {
    nombre: 'delta-pelado-con-dos-tipos',
    tipo: 'guionado',
    // Caso real observado en producción: con los DOS tipos cargados y el resumen
    // ya enviado, "sumale 10" (un DELTA sin tipo) caía al fallback de
    // desambiguación y el cliente recibía un "no te entendí" pese a ser una
    // instrucción clarísima. `detectarCantidadPelada` vetea los deltas a
    // propósito, así que el reemplazo pelado no lo cubría: lo capta
    // `detectarDeltaPelado`, que además lleva la operación (sumar) a los botones.
    persona: 'Cliente con agua y crema en el pedido que quiere agregar más sin decir de cuál.',
    turnos: [
      { texto: 'hola, 10 de agua y 10 de crema a Mitre 951, efectivo' },
      { texto: 'sumale 10' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_agua: 10,
      cantidad_crema: 10,
      direccionContiene: 'Mitre 951',
      metodo_pago: 'efectivo',
      criterios: [
        'Con los dos tipos cargados, el bot NO adivina a cuál sumarle 10: pregunta si esos 10 que se AGREGAN son de agua o de crema.',
        'NUNCA responde un genérico "no te entendí" ni repite el mismo resumen sin acusar recibo: "sumale 10" es una instrucción clara.',
        'La pregunta deja claro que es una SUMA (agregar), no un reemplazo, y menciona la cantidad 10.',
        'Las cantidades quedan intactas (10 y 10) hasta que el cliente aclare el tipo.',
      ],
    },
  },

  {
    nombre: 'rechazo-cancelacion-y-confirmar-por-texto',
    tipo: 'guionado',
    // Hallazgo #1: tras rechazar la cancelación, un "sí, confirmá" por TEXTO no
    // confirmaba y el bot repetía el mismo resumen en loop. Ningún escenario
    // encadenaba rechazo-de-cancelación → confirmación.
    persona: 'Cliente apurado que amaga con cancelar, se arrepiente y después confirma.',
    turnos: [
      { texto: 'hola, 20 de crema, retiro, efectivo' },
      { texto: 'espera, no quiero nada mas. cancelá' },
      { texto: 'no, mantenelo. me dio un susto' },
      { texto: 'sí, confirmá.' },
    ],
    espera: {
      estadoFinal: 'pendiente',
      cantidad_crema: 20,
      direccionContiene: 'retira',
      metodo_pago: 'efectivo',
      criterios: [
        'Ante "cancelá" el bot pide confirmación con botones, no cancela de una.',
        '"no, mantenelo" es un rechazo de la cancelación: vuelve a borrador y reenvía el resumen.',
        '"sí, confirmá." confirma el pedido y lo manda a cocina. NO repite el resumen otra vez: el pedido NO puede quedar trabado en borrador.',
      ],
    },
  },

  {
    nombre: 'mixto-pago-mas-pregunta-borrador-parcial',
    tipo: 'guionado',
    // Hallazgo #2: el dato de pedido se descartaba cuando venía mezclado con una
    // pregunta de negocio y el modelo clasificaba `consulta_negocio` (ese handler
    // corta el flujo con return). `pedido-mas-pregunta-guionado` no lo cubría:
    // es de un solo turno y con el pedido YA completo.
    persona: 'Cliente que completa el último dato del pedido y en el mismo mensaje hace una pregunta de negocio.',
    turnos: [
      { texto: 'Hola, quiero 20 de crema sabor frutilla, me los podés dejar en la puerta del local para retirar?' },
      { texto: 'transferencia. y hasta que hora entregan?' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 20,
      direccionContiene: 'retira',
      metodo_pago: 'transferencia',
      criterios: [
        'El bot delega a un humano la pregunta de horarios (los horarios exactos no los conoce).',
        'En el MISMO turno guarda metodo_pago=transferencia: el dato NO se descarta por venir con una pregunta.',
        'Como con eso el pedido queda completo, manda el resumen. NO vuelve a preguntar la forma de pago en el turno siguiente.',
      ],
    },
  },

  {
    nombre: 'repetir-pedido-no-es-confirmar',
    tipo: 'guionado',
    // Hallazgo de pruebas manuales: con el resumen ya enviado, el cliente REPITE su
    // pedido textual. El modelo lo lee como "confirmar" (pregunté "¿está todo bien?"
    // y me responden lo mismo) y, como los datos son idénticos, el pedido se iba a
    // cocina sin que el cliente hubiera confirmado nada. Repetir no es confirmar.
    persona: 'Cliente que reescribe su pedido igual, sin darse cuenta de que ya se lo tomaron.',
    turnos: [
      { texto: 'hola, 20 de crema de chocolate, paso a retirar, efectivo' },
      { texto: 'ola, 20 de crema de chocolate, paso a retirar, efectivo' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 20,
      direccionContiene: 'retira',
      metodo_pago: 'efectivo',
      criterios: [
        'El pedido NO se confirma: repetir los mismos datos no es una confirmación explícita. El estado debe seguir en borrador, nunca pasar a pendiente.',
        'El bot reenvía el resumen y vuelve a pedir confirmación, en vez de mandarlo a cocina.',
      ],
    },
  },

  {
    nombre: 'corregir-en-kilos-sobre-pedido-completo',
    tipo: 'guionado',
    // Hallazgo de pruebas manuales: con el resumen ya enviado, "que sean 2 kilos"
    // caía al fallback y el cliente recibía un "no te entendí" que no explicaba
    // nada — y él cree que ya dio la cantidad. La explicación existía, pero estaba
    // cableada solo al camino de "faltan datos".
    persona: 'Cliente que intenta corregir la cantidad en kilos sobre un pedido ya armado.',
    turnos: [
      { texto: 'hola, 40 de crema de chocolate a Mitre 951, efectivo' },
      { texto: 'que sean 2 kilos' },
    ],
    espera: {
      estadoFinal: 'borrador',
      cantidad_crema: 40,
      direccionContiene: 'Mitre 951',
      metodo_pago: 'efectivo',
      criterios: [
        'El bot NO acepta la cantidad en kilos ni inventa un número de unidades: la cantidad sigue en 40.',
        'Le explica que los helados se venden POR UNIDAD (no por kilo/pote/porción) y le pide las unidades. NO responde un genérico "no te entendí".',
      ],
    },
  },

  // ─────────────────────── EXPLORATORIOS (fase 2) ───────────────────────
  // Un cliente-agente LLM improvisa a partir de persona + objetivo. Sin oráculo
  // fijo: el juez decide si el bot lo resolvió por diseño o por accidente.
  // `pistas` orienta al cliente-agente (no son mensajes literales).

  {
    nombre: 'cliente-indeciso',
    tipo: 'exploratorio',
    persona: 'Cliente que no tiene claro qué quiere y cambia de opinión.',
    objetivo: 'Terminar haciendo un pedido, pero cambiando varias veces de cantidad y de tipo (agua/crema) antes de decidirte.',
    pistas: [
      'Empezá vago ("qué tenés?", "no sé cuántos"), después andá ajustando.',
      'Cambiá al menos dos veces la cantidad y una vez el tipo.',
      'Cerrá dando dirección y forma de pago si el bot te lleva bien.',
    ],
  },

  {
    nombre: 'pedido-mas-pregunta',
    tipo: 'exploratorio',
    persona: 'Cliente que mete un pedido y una consulta de negocio en el mismo mensaje.',
    objetivo: 'Hacer un pedido pero además preguntar algo del negocio (hasta qué hora entregan, o si llegan a tu zona) en el mismo mensaje.',
    pistas: [
      'Mezclá el dato del pedido con la pregunta en una sola frase.',
      'Fijate si el bot te contesta la pregunta o la ignora.',
      'Si la ignora, volvé a preguntarla suelta.',
    ],
  },

  {
    nombre: 'cliente-fuera-de-tema',
    tipo: 'exploratorio',
    persona: 'Cliente que arranca con cosas que no tienen nada que ver.',
    objetivo: 'Mandar mensajes fuera de tema (un chiste, preguntar quién ganó el partido, un audio imaginario descripto en texto) y ver cómo reacciona el bot antes de, quizás, pedir algo.',
    pistas: [
      'No pidas helado en los primeros mensajes.',
      'Probá una pregunta random y una frase sin sentido.',
      'Fijate si el bot te empuja de vuelta al pedido o si delega a un humano innecesariamente.',
    ],
  },

  {
    nombre: 'cliente-apurado-y-brusco',
    tipo: 'exploratorio',
    persona: 'Cliente apurado, mensajes cortos y bruscos, poca paciencia.',
    objetivo: 'Pedir rápido, quejarte de que tarda, y a mitad de camino decir que cancelás y después que no, que lo querés igual.',
    pistas: [
      'Mensajes de pocas palabras, tono impaciente.',
      'Amagá con cancelar y después echate atrás.',
      'Fijate si el bot te sigue el hilo sin trabarse.',
    ],
  },

  {
    nombre: 'cambia-direccion-post-confirmacion',
    tipo: 'exploratorio',
    persona: 'Cliente que confirma y después se da cuenta de que la dirección estaba mal.',
    objetivo: 'Hacer un pedido completo, confirmarlo, y recién ahí querer cambiar la dirección de entrega.',
    pistas: [
      'Confirmá el pedido primero.',
      'Después decí que te equivocaste de dirección y dá una nueva.',
      'Fijate si el bot puede modificar un pedido ya confirmado (pendiente) o qué te responde.',
    ],
  },
];

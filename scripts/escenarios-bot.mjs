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
    // Fallo conocido (no gatea CI): el bot no toma "paso a retirar" dicho inline
    // con el resto del pedido como direccion='retira' en el primer turno — pide
    // dirección y ofrece el quick-reply resp_retira. Además este escenario toca
    // confirmar_borrador cuando el bot ofreció resp_retira (habría que tocar ese).
    // Ver informe corrida-2026-07-16T03-29-33. Sacar el xfail cuando se resuelva.
    xfail: 'el bot no interpreta "paso a retirar" inline como retiro en el primer turno; escenario pendiente de ajustar',
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

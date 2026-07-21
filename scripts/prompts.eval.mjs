// Suite de evaluación del prompt del bot (mejora #10).
//
// Dispara casos reales contra el endpoint dev /api/dev/test-ia, que reusa el
// MISMO buildSystemPrompt + aplicarOperacion* que el flujo de producción. No hay
// mocks: pega contra Groq de verdad, así que refleja lo que la DB terminaría
// guardando. Es la red de seguridad para los recortes/cambios de prompt (#4, #4b, #6).
//
// CÓMO CORRERLO:
//   1. En una terminal:  npm run dev      (deja el server en localhost:3000)
//   2. En otra:          npm run eval
//
// Variables opcionales:
//   EVAL_URL=http://localhost:3000   base del server
//   EVAL_FILTER=cantidad             corre solo los casos cuyo nombre matchea
//   EVAL_REPEAT=3                    repite cada caso N veces (mide flakiness del modelo)
//   EVAL_DELAY_MS=20000             pausa entre casos. Default 20s: el free-tier de Groq
//                                   tiene 8000 TPM y cada caso pide ~3700 tokens, así que
//                                   disparar en ráfaga agota el cupo (los fallos son del
//                                   límite, no del prompt). Ponelo en 0 si tenés Dev Tier.
//
// NOTA: el endpoint NO pasa por intentarShortCircuit (eso es heurística pura y
// determinista). Este suite evalúa el camino del LLM, que es el que tiene riesgo.

const BASE_URL = process.env.EVAL_URL || 'http://localhost:3000';
const FILTER = process.env.EVAL_FILTER || '';
const REPEAT = Math.max(1, parseInt(process.env.EVAL_REPEAT || '1', 10));
// Default 20s entre casos para no agotar el free-tier de Groq (8000 TPM). El
// auto-retry de correrCaso cubre los choques residuales; en Dev Tier poné EVAL_DELAY_MS=0.
const DELAY_MS = Math.max(0, parseInt(process.env.EVAL_DELAY_MS || '20000', 10));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Helpers para armar pedidoActivo de forma compacta.
const borrador = (extra) => ({
  estado: 'borrador',
  cantidad_agua: 0,
  cantidad_crema: 0,
  direccion: 'Mitre 951',
  aclaracion: null,
  observaciones: null,
  observaciones_detalle: null,
  metodo_pago: 'efectivo',
  ...extra,
});
const cocina = (extra) => borrador({ estado: 'pendiente', ...extra });
const esperandoCancelacion = (extra) => borrador({ estado: 'esperando_cancelacion', ...extra });

// Cada caso: { nombre, mensaje, pedidoActivo?, espera }.
// `espera` es un objeto: cada clave se compara contra el resultado aplanado
// (raw_ia + computado). El valor esperado puede ser:
//   - un literal (match exacto, deep-equal)
//   - una RegExp (se testea contra el string actual; útil para texto libre del modelo)
const CASOS = [
  // ---- CANTIDADES (#6: bloque comprimido) ----
  {
    nombre: 'cantidad: sumar con "sumale"',
    mensaje: 'sumale 5 de agua',
    pedidoActivo: borrador({ cantidad_agua: 70, cantidad_crema: 10 }),
    espera: { cantidad_agua: 75, cantidad_crema: 10, intencion: 'datos_pedido' },
  },
  {
    nombre: 'cantidad: "25 más" es delta, no total',
    mensaje: 'que sean 25 más de agua',
    pedidoActivo: borrador({ cantidad_agua: 70 }),
    espera: { cantidad_agua: 95 },
  },
  {
    nombre: 'cantidad: "25 de agua" es reemplazo',
    mensaje: 'que sean 25 de agua',
    pedidoActivo: borrador({ cantidad_agua: 70 }),
    espera: { cantidad_agua: 25 },
  },
  {
    nombre: 'cantidad: restar con "menos"',
    mensaje: '5 menos de crema',
    pedidoActivo: borrador({ cantidad_crema: 10 }),
    espera: { cantidad_crema: 5 },
  },
  {
    nombre: 'cantidad: desglose por sabores suma (única suma permitida)',
    mensaje: 'que los de agua sean 20 de frutilla y 40 de menta',
    pedidoActivo: borrador({ cantidad_agua: 0 }),
    espera: { cantidad_agua: 60 },
  },
  {
    // Se venden por unidad, no por peso. En pedido nuevo, "2 kilos" no debe
    // convertirse ni inventar un número: la cantidad queda en 0 y el flujo de
    // datos faltantes vuelve a pedir las unidades. Falla si mete 2 en crema.
    nombre: 'cantidad: kilos en pedido nuevo no inventa cantidad',
    mensaje: 'quiero 2 kilos de crema, pago efectivo',
    espera: { cantidad_crema: 0, metodo_pago: 'efectivo' },
  },
  {
    // Sobre un borrador con cantidad ya cargada, pedir en kilos debe DEJARLA
    // intacta (operación "mantener"), no pisarla con un número inventado.
    nombre: 'cantidad: kilos sobre borrador mantiene la cantidad cargada',
    mensaje: 'que sea medio kilo de agua',
    pedidoActivo: borrador({ cantidad_agua: 30 }),
    espera: { cantidad_agua: 30 },
  },
  {
    // "porción con 2 bolas" NO es 2 unidades de crema (caso real del log): una
    // porción servida no es la unidad agua/crema que se vende. La cantidad queda
    // en 0 y se piden las unidades; el sabor sí se guarda.
    nombre: 'cantidad: porción con bolas en pedido nuevo no inventa cantidad',
    mensaje: 'quiero una porción de chocolate con 2 bolas',
    espera: { cantidad_crema: 0, cantidad_agua: 0 },
  },
  {
    // Mismo caso pero sobre un borrador activo (prompt de modificación, que era
    // el más "ávido" en mapear "2 bolas" → 2): la cantidad cargada no se toca.
    nombre: 'cantidad: porción con bolas sobre borrador mantiene la cantidad',
    mensaje: 'una porción de chocolate con 2 bolas',
    pedidoActivo: borrador({ cantidad_crema: 0 }),
    espera: { cantidad_crema: 0 },
  },

  // ---- PEDIDO EN ARMADO EN PARTES (multiturno) ----
  // Regresión real: el cliente daba la cantidad en un mensaje y el pago en otro.
  // Como antes NO se persistía nada hasta tener el pedido completo, el 2º turno
  // re-extraía todo desde el historial y el modelo perdía la cantidad (log real:
  // "50 de crema" en el turno 1, "efectivo" en el turno 2 → crema volvía a 0).
  // Ahora el 1er turno deja un borrador PARCIAL (metodo_pago=''), así que el 2º
  // turno llega con pedidoActivo y TS mergea determinísticamente: la cantidad ya
  // cargada tiene que sobrevivir al mensaje que solo trae el pago ("mantener").
  {
    nombre: 'multiturno: pasar el pago mantiene la cantidad de crema ya cargada',
    mensaje: 'efectivo',
    pedidoActivo: borrador({ cantidad_crema: 50, metodo_pago: '' }),
    espera: { cantidad_crema: 50, metodo_pago: 'efectivo', intencion: 'datos_pedido' },
  },
  {
    nombre: 'multiturno: pasar el pago mantiene agua y crema',
    mensaje: 'lo pago por transferencia',
    pedidoActivo: borrador({ cantidad_agua: 20, cantidad_crema: 30, metodo_pago: '' }),
    espera: { cantidad_agua: 20, cantidad_crema: 30, metodo_pago: 'transferencia' },
  },

  // ---- ACLARACION (#4: patch estructurado) ----
  {
    nombre: 'aclaracion: agregar concatena sin perder lo viejo',
    mensaje: 'agregale que tiene el marco naranja',
    pedidoActivo: borrador({ aclaracion: 'la casa es verde' }),
    espera: { aclaracion: /verde.*naranja/i },
  },
  {
    nombre: 'aclaracion: se mantiene si el mensaje no la toca',
    mensaje: 'sumale 3 de crema',
    pedidoActivo: borrador({ cantidad_crema: 5, aclaracion: 'depto 6' }),
    espera: { aclaracion: 'depto 6', cantidad_crema: 8 },
  },
  {
    // Contradicción IMPLÍCITA (sin "no"): el cliente re-describe el mismo objeto
    // (el portón) con otro color. Debe reemplazar ese valor, NO concatenar. La
    // puerta gris (otro objeto) se conserva. Falla si sobrevive "rojo".
    nombre: 'aclaracion: nueva contradice a la vieja sin decir "no" (reemplaza el atributo)',
    mensaje: 'el porton es gris',
    pedidoActivo: borrador({ aclaracion: 'porton rojo, puerta gris' }),
    espera: { aclaracion: /^(?!.*rojo).*gris/i },
  },
  {
    // Cambio de dirección: la aclaración vieja pertenecía a la dirección anterior,
    // así que TS la descarta como base del merge. Solo debe quedar lo nuevo de
    // ESTE mensaje ("ladrillo"), nunca "rojo" de la casa anterior.
    nombre: 'aclaracion: cambiar de direccion descarta la aclaracion vieja',
    mensaje: 'la direccion es Vergara 2664, la casa de ladrillo',
    pedidoActivo: borrador({ aclaracion: 'porton rojo, puerta gris' }),
    espera: { direccion: /vergara 2664/i, aclaracion: /^(?!.*rojo).*ladrillo/i },
  },

  // ---- OBSERVACIONES (#4b: slots keyed por tipo) ----
  {
    nombre: 'observaciones: reemplazar agua NO toca crema',
    mensaje: 'los de agua que sean de frutilla',
    pedidoActivo: borrador({
      cantidad_agua: 10,
      cantidad_crema: 10,
      observaciones: 'los de agua de vainilla, los de crema de chocolate',
      observaciones_detalle: { agua: 'de vainilla', crema: 'de chocolate', general: null },
    }),
    espera: { observaciones: /frutilla.*chocolate/i },
  },
  {
    nombre: 'observaciones: detalle general "sin coco"',
    mensaje: 'que sean sin coco',
    pedidoActivo: borrador({ cantidad_crema: 10, observaciones: null, observaciones_detalle: null }),
    espera: { observaciones: /sin coco/i },
  },
  {
    nombre: 'observaciones: "10 de crema" sin sabor no inventa nada',
    mensaje: 'quiero 10 de crema',
    espera: { cantidad_crema: 10, observaciones: null },
  },

  // ---- INTENCIONES ----
  {
    nombre: 'intencion: saludo con pedido en cocina',
    mensaje: 'hola buenas',
    pedidoActivo: cocina({ cantidad_crema: 10 }),
    espera: { intencion: 'saludo' },
  },
  {
    nombre: 'intencion: cancelar',
    mensaje: 'quiero cancelar el pedido',
    pedidoActivo: borrador({ cantidad_crema: 10 }),
    espera: { intencion: 'cancelar' },
  },
  {
    nombre: 'intencion: confirmar borrador',
    mensaje: 'dale, está perfecto, confirmo',
    pedidoActivo: borrador({ cantidad_crema: 10 }),
    espera: { intencion: 'confirmar' },
  },
  {
    nombre: 'intencion: consultar_precios sin pedido activo',
    mensaje: 'hola, cuánto salen los helados?',
    espera: { intencion: 'consultar_precios' },
  },
  {
    nombre: 'intencion: consultar_precios pidiendo la lista',
    mensaje: 'me pasás la lista de precios?',
    espera: { intencion: 'consultar_precios' },
  },
  {
    nombre: 'intencion: consultar_precios con typos',
    mensaje: 'cuanto salne la lsita de precios porfa',
    espera: { intencion: 'consultar_precios' },
  },
  {
    nombre: 'intencion: consultar_precios con pedido en cocina no toca el pedido',
    mensaje: 'y cuánto cuesta cada uno?',
    pedidoActivo: cocina({ cantidad_crema: 10 }),
    espera: { intencion: 'consultar_precios', cantidad_crema: 10 },
  },
  {
    nombre: 'intencion: pedido con cantidad NO es consultar_precios',
    mensaje: 'quiero 20 de agua, cuánto sale?',
    espera: { intencion: 'datos_pedido', cantidad_agua: 20 },
  },

  // ---- CONSULTA DE NEGOCIO (delegación a humano) ----
  // Preguntas reales sobre el negocio que el bot no sabe responder → se marca
  // requiere_atencion y contesta una persona. Los negativos importan tanto como
  // los positivos: un off-topic o un sinsentido NO debe molestar a un humano.
  {
    nombre: 'consulta_negocio: horarios',
    mensaje: 'hola! hasta qué hora hacen envíos?',
    espera: { intencion: 'consulta_negocio' },
  },
  {
    nombre: 'consulta_negocio: zona de entrega',
    mensaje: 'llegan hasta barrio norte?',
    espera: { intencion: 'consulta_negocio' },
  },
  {
    nombre: 'consulta_negocio: sabores disponibles',
    mensaje: 'qué sabores tenés hoy?',
    espera: { intencion: 'consulta_negocio' },
  },
  {
    nombre: 'consulta_negocio: venta mayorista',
    mensaje: 'venden al por mayor para un kiosco?',
    espera: { intencion: 'consulta_negocio' },
  },
  {
    nombre: 'consulta_negocio: reclamo por pedido con borrador activo no toca el pedido',
    mensaje: 'che, el pedido de la semana pasada vino derretido',
    pedidoActivo: borrador({ cantidad_crema: 10 }),
    espera: { intencion: 'consulta_negocio', cantidad_crema: 10 },
  },
  {
    nombre: 'consulta_negocio: pregunta off-topic NO delega',
    mensaje: 'quién ganó el partido de anoche?',
    // pregunta_negocio null: off-topic NO es consulta de negocio → no delega.
    espera: { intencion: 'datos_pedido', pregunta_negocio: null },
  },
  {
    nombre: 'consulta_negocio: mensaje sin sentido NO delega',
    mensaje: 'asdf jkl qwerty',
    espera: { intencion: 'datos_pedido', pregunta_negocio: null },
  },
  {
    // Versión completa de A: la intención sigue siendo datos_pedido (se procesa
    // el pedido), pero la pregunta de negocio se extrae en pregunta_negocio para
    // que el flujo la delegue a un humano en vez de descartarla en silencio.
    nombre: 'consulta_negocio: pregunta + datos del pedido → datos_pedido + pregunta_negocio',
    mensaje: 'quiero 20 de agua, hasta qué hora entregan?',
    espera: { intencion: 'datos_pedido', cantidad_agua: 20, pregunta_negocio: /hora|entrega/i },
  },
  {
    // Pedido completo de una + pregunta: se extrae todo y ADEMÁS la pregunta.
    nombre: 'consulta_negocio: pedido completo + pregunta extrae ambos',
    mensaje: 'quiero 10 de crema para Mitre 951, efectivo, ¿llegan hasta el centro?',
    espera: { intencion: 'datos_pedido', cantidad_crema: 10, metodo_pago: 'efectivo', pregunta_negocio: /centro|lleg|zona/i },
  },
  {
    // Negativo clave del diseño "always delegate": un pedido normal SIN pregunta
    // no debe setear pregunta_negocio (si no, pingaría a un humano de gusto).
    nombre: 'consulta_negocio: pedido normal sin pregunta no setea pregunta_negocio',
    mensaje: 'quiero 10 de crema para Mitre 951, efectivo',
    espera: { intencion: 'datos_pedido', cantidad_crema: 10, pregunta_negocio: null },
  },
  {
    nombre: 'consulta_negocio: precios sigue siendo consultar_precios, no consulta_negocio',
    mensaje: 'cuánto están los helados?',
    espera: { intencion: 'consultar_precios' },
  },

  // ---- CAMBIOS DURANTE CANCELACION ----
  // El flujo trata datos_pedido + cambios reales en esperando_cancelacion como
  // RECHAZO IMPLÍCITO de la cancelación: vuelve a borrador con los cambios
  // aplicados. Para que eso funcione el modelo tiene que clasificar el mensaje
  // como "datos_pedido" (con la operación correcta), NO como
  // "rechazar_cancelacion" — esa rama vuelve a borrador SIN aplicar nada y los
  // cambios se perderían.
  {
    nombre: 'cancelacion: cambios concretos durante la cancelación son datos_pedido',
    mensaje: 'mejor cambiale, que sean 20 de crema',
    pedidoActivo: esperandoCancelacion({ cantidad_crema: 10 }),
    espera: { intencion: 'datos_pedido', cantidad_crema: 20 },
  },
  {
    nombre: 'cancelacion: "no" + cambios sigue siendo datos_pedido (los cambios no se pierden)',
    mensaje: 'no, mejor sumale 5 de agua',
    pedidoActivo: esperandoCancelacion({ cantidad_agua: 10 }),
    espera: { intencion: 'datos_pedido', cantidad_agua: 15 },
  },
  {
    nombre: 'cancelacion: cambio de dirección durante la cancelación',
    mensaje: 'mandalo a Vergara 2664 mejor',
    pedidoActivo: esperandoCancelacion({ cantidad_crema: 10 }),
    espera: { intencion: 'datos_pedido', direccion: /vergara 2664/i },
  },
  {
    nombre: 'cancelacion: confirmación no trivial (fuera del short-circuit)',
    mensaje: 'si si, cancelalo nomas',
    pedidoActivo: esperandoCancelacion({ cantidad_crema: 10 }),
    espera: { intencion: 'confirmar_cancelacion' },
  },
  {
    nombre: 'cancelacion: arrepentimiento SIN datos es rechazar_cancelacion',
    mensaje: 'no no, dejalo así como estaba',
    pedidoActivo: esperandoCancelacion({ cantidad_crema: 10 }),
    espera: { intencion: 'rechazar_cancelacion' },
  },

  // ---- REACTIVAR (deshacer una cancelación reciente) ----
  // Sin pedido activo pero con uno cancelado hace poco (canceladoReciente=true),
  // el prompt ofrece "reactivar". Un arrepentimiento lo dispara; un pedido nuevo
  // con datos NO (arranca de cero). Sin el flag, "reactivar" no existe.
  {
    nombre: 'reactivar: arrepentimiento tras cancelar es reactivar',
    mensaje: 'no, pará, en realidad sí lo quiero',
    canceladoReciente: true,
    espera: { intencion: 'reactivar' },
  },
  {
    nombre: 'reactivar: "no lo canceles" es reactivar',
    mensaje: 'no no, no lo canceles, quiero el pedido',
    canceladoReciente: true,
    espera: { intencion: 'reactivar' },
  },
  {
    nombre: 'reactivar: un pedido nuevo con datos NO es reactivar',
    mensaje: 'quiero 12 de agua a San Martín 200, efectivo',
    canceladoReciente: true,
    espera: { intencion: 'datos_pedido', cantidad_agua: 12 },
  },

  // ---- PEDIDO NUEVO (desde cero) ----
  {
    nombre: 'nuevo: pedido completo en un mensaje',
    mensaje: 'hola, quiero 10 de crema de chocolate, en Mitre 951, pago en efectivo',
    espera: {
      cantidad_crema: 10,
      direccion: /mitre 951/i,
      metodo_pago: 'efectivo',
      observaciones: /chocolate/i,
      intencion: 'datos_pedido',
    },
  },
  {
    nombre: 'nuevo: depto sin calle NO es direccion',
    mensaje: 'mandame 5 de agua al depto 6',
    espera: { direccion: null, cantidad_agua: 5 },
  },
  {
    nombre: 'nuevo: calle sin altura NO valida como direccion (#7)',
    mensaje: 'quiero 10 de crema en la calle Mitre, pago efectivo',
    espera: { direccion: null, cantidad_crema: 10 },
  },
];

function comparar(esperado, actual) {
  if (esperado instanceof RegExp) {
    return typeof actual === 'string' && esperado.test(actual);
  }
  return JSON.stringify(esperado) === JSON.stringify(actual);
}

function aplanar(resultado) {
  const raw = resultado.raw_ia ?? {};
  const comp = resultado.computado ?? {};
  return {
    intencion: raw.intencion,
    // direccion ya validada por pareceDireccion (#7); cae a null si no parecía calle+altura.
    direccion: comp.direccion ?? null,
    metodo_pago: raw.metodo_pago,
    cantidad_agua: comp.cantidad_agua,
    cantidad_crema: comp.cantidad_crema,
    aclaracion: comp.aclaracion,
    observaciones: comp.observaciones,
    // Señal ortogonal (versión completa de A): la pregunta de negocio se extrae
    // aunque la intención sea datos_pedido. El flujo la delega a un humano.
    // Normalizamos igual que esPreguntaNegocioReal en el flujo: el modelo a veces
    // devuelve el TEXTO "null"/"none"/… en vez del null de JSON, y eso NO cuenta.
    pregunta_negocio: preguntaNegocioReal(raw.pregunta_negocio) ? raw.pregunta_negocio : null,
  };
}

// Espejo de esPreguntaNegocioReal (procesar.ts) para el .mjs standalone.
function preguntaNegocioReal(valor) {
  if (!valor || typeof valor !== 'string') return false;
  const v = valor.trim().toLowerCase();
  return v !== '' && v !== 'null' && v !== 'none' && v !== 'undefined' && v !== 'n/a';
}

async function llamarEndpoint(caso) {
  const res = await fetch(`${BASE_URL}/api/dev/test-ia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mensaje: caso.mensaje,
      pedidoActivo: caso.pedidoActivo,
      hayPedidoCanceladoReciente: caso.canceladoReciente,
    }),
  });
  return res.json();
}

async function correrCaso(caso) {
  // El free-tier de Groq tiene un límite de tokens-por-minuto bajo (8000 TPM).
  // Disparar casos en ráfaga lo agota: el error NO es del prompt sino del cupo.
  // Lo tratamos como transitorio y reintentamos el caso con pausas crecientes.
  let data;
  for (let intento = 1; intento <= 4; intento++) {
    data = await llamarEndpoint(caso);
    const esRateLimit = !data.ok && /rate limit|rate_limit|TPM|tokens per minute/i.test(String(data.error ?? ''));
    if (!esRateLimit) break;
    if (intento < 4) {
      const espera = 4000 * intento; // 4s, 8s, 12s
      console.log(`       ⏳ rate limit de Groq, reintentando en ${espera / 1000}s...`);
      await sleep(espera);
    }
  }

  if (!data.ok) {
    return { ok: false, fallos: [`endpoint devolvió error: ${data.error ?? 'desconocido'}`], data };
  }

  const actual = aplanar(data);
  const fallos = [];
  for (const [campo, esperado] of Object.entries(caso.espera)) {
    if (!comparar(esperado, actual[campo])) {
      const esp = esperado instanceof RegExp ? esperado.toString() : JSON.stringify(esperado);
      fallos.push(`${campo}: esperaba ${esp}, obtuvo ${JSON.stringify(actual[campo])}`);
    }
  }
  return { ok: fallos.length === 0, fallos, data, latencyMs: data.latencyMs };
}

async function main() {
  const casos = FILTER
    ? CASOS.filter(c => c.nombre.toLowerCase().includes(FILTER.toLowerCase()))
    : CASOS;

  if (casos.length === 0) {
    console.error(`No hay casos que matcheen el filtro "${FILTER}".`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n🧪 Eval del prompt — ${casos.length} caso(s)${REPEAT > 1 ? ` x${REPEAT} repeticiones` : ''} contra ${BASE_URL}\n`);

  let pasados = 0;
  let fallados = 0;

  for (const [idx, caso] of casos.entries()) {
    if (DELAY_MS > 0 && idx > 0) await sleep(DELAY_MS);
    let okEnTodas = true;
    const fallosVistos = new Set();
    let latencyAcum = 0;

    for (let i = 0; i < REPEAT; i++) {
      let r;
      try {
        r = await correrCaso(caso);
      } catch (e) {
        if (e?.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(String(e))) {
          console.error(`\n❌ No me pude conectar a ${BASE_URL}. ¿Está corriendo "npm run dev"?\n`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
      latencyAcum += r.latencyMs ?? 0;
      if (!r.ok) {
        okEnTodas = false;
        r.fallos.forEach(f => fallosVistos.add(f));
      }
    }

    const latProm = Math.round(latencyAcum / REPEAT);
    if (okEnTodas) {
      pasados++;
      console.log(`  ✅ ${caso.nombre}  (${latProm}ms)`);
    } else {
      fallados++;
      console.log(`  ❌ ${caso.nombre}  (${latProm}ms)`);
      for (const f of fallosVistos) console.log(`       ↳ ${f}`);
    }
  }

  console.log(`\n${fallados === 0 ? '✅' : '❌'} ${pasados}/${casos.length} pasaron${fallados > 0 ? `, ${fallados} fallaron` : ''}.\n`);
  // Seteamos exitCode en vez de process.exit(): forzar la salida mientras undici
  // todavía cierra sus sockets keep-alive dispara un abort de libuv en Windows
  // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"). Dejamos que Node
  // drene el event loop y salga solo con el código correcto.
  process.exitCode = fallados === 0 ? 0 : 1;
}

main();

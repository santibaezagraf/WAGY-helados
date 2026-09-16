// Harness de testeo conversacional del bot — PASO 1: correr las conversaciones.
//
// Maneja conversaciones multi-turno contra el bot REAL (mismo prompt, misma
// extracción, misma máquina de estados, misma DB) a través del endpoint dev
// /api/dev/simular-conversacion, que NO manda WhatsApp de verdad (requiere
// BOT_TEST_MODE=1). Guarda los transcripts crudos; NO juzga.
//
// PASO 2 (juicio + informe) lo hace Claude Code leyendo los transcripts contra
// scripts/spec-bot.md. Ver CLAUDE.md > "Testeo".
//
// CÓMO CORRERLO:
//   1. Una terminal:  BOT_TEST_MODE=1 npm run dev        (deja el server en :3000)
//      (en PowerShell:  $env:BOT_TEST_MODE=1; npm run dev)
//   2. Otra terminal: npm run probar-bot
//   3. Pedile a Claude Code: "juzgá la última corrida de probar-bot"
//
// Variables opcionales:
//   PROBAR_URL=http://localhost:3000   base del server
//   PROBAR_FILTER=cancelar             corre solo escenarios cuyo nombre matchea
//   PROBAR_DELAY_MS=31000              pausa entre turnos. El default respeta el TPM
//                                      del primario (8000 TPM medido / ~3459 tokens
//                                      por turno, con margen). Bajalo para
//                                      corridas filtradas; 0 en Dev Tier.
//   PROBAR_PREFIX=54000                prefijo de los teléfonos de test (debe
//                                      coincidir con BOT_TEST_PREFIX del server)
//   PROBAR_MAX_TURNOS=12               tope de turnos por escenario (red de seguridad)
//   PROBAR_MODELO_CLIENTE=openai/gpt-oss-20b   modelo Groq del cliente-agente (exploratorios).
//                                      Tiene que ser de Groq: los modelos de Gemini que se
//                                      probaron NO cierran los escenarios (no emiten FIN),
//                                      ver la nota de esfuerzoRazonamiento más abajo.
//                                      ⚠️ CONVIENE PISARLO. El default coincide con el
//                                      PRIMARIO del bot, así que el cliente simulado y el
//                                      bot bajo prueba comparten la misma cubeta TPD de
//                                      200k y la corrida se queda sin tokens antes de
//                                      terminar. Apuntalo a otro modelo de la cadena
//                                      (ej. qwen/qwen3.8-27b) y el primario queda entero
//                                      para el bot. El nightly ya lo hace; en local se
//                                      pone en .env.local.
//                                      Si es de razonamiento híbrido (qwen3.x), su bloque
//                                      <think> se apaga vía providerOptions y, por si acaso,
//                                      se filtra en cliente-agente.mjs. Hay preflight: si Groq
//                                      dio de baja el modelo, la corrida aborta ruidosa.
//   PROBAR_SOLO_GUIONADOS=1            omite los exploratorios (no usa el cliente-agente LLM)
//   PROBAR_SOLO_EXPLORATORIOS=1        omite los guionados (corre solo la capa exploratoria)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { ESCENARIOS } from './escenarios-bot.mjs';
import { limpiarMensajeCliente, validarMensajeCliente } from './cliente-agente.mjs';

const BASE_URL = process.env.PROBAR_URL || 'http://localhost:3000';
const FILTER = process.env.PROBAR_FILTER || '';
// Pausa entre turnos. El default sale del TPM REAL del primario, no de una
// corazonada: Groq devuelve x-ratelimit-limit-tokens=8000 (medido 2026-09-15) y
// una extracción cuesta ~3459 tokens (3202 de prompt + ~257 de salida, medidos
// con reasoningEffort=low), o sea que entra UNA llamada cada ~26s.
//
// Se deja en 31s, con margen sobre esos 26: las consultas de negocio agregan
// llamadas que esta cuenta no ve, y quedarse corto es exactamente lo que rompió
// la corrida 34928105031 — el 15000 viejo iba al doble del TPM y el 6000 del CI
// a 5×, y ese exceso lo absorbía la cadena de fallback, así que un 429
// transitorio terminaba cayendo en el último eslabón (que estaba dado de baja).
//
// Para una corrida filtrada de 1-2 escenarios se puede bajar sin riesgo (son
// pocas llamadas); el default protege la corrida completa.
const DELAY_MS = Math.max(0, parseInt(process.env.PROBAR_DELAY_MS || '31000', 10));

// Costo medido de una extracción (entrada + salida), con reasoningEffort=low.
// Solo alimenta la estimación que se imprime al arrancar.
const TOKENS_POR_TURNO = 3459;
const PREFIX = process.env.PROBAR_PREFIX || '54000';
const MAX_TURNOS = Math.max(1, parseInt(process.env.PROBAR_MAX_TURNOS || '12', 10));
// El cliente-agente NO es el sistema bajo prueba: solo improvisa mensajes de
// cliente. Por eso el default NO PUEDE SER el primario del bot (hoy
// `MODELOS_EXTRACCION[0]` = 'openai/gpt-oss-20b' en src/lib/bot/modelos.ts): con
// los dos en el mismo modelo comparten la cubeta TPD de 200k y la corrida se
// queda sin tokens a mitad de camino. Apuntándolo a otro modelo de la cadena, el
// primario queda entero para el bot y el presupuesto del día se duplica.
//
// La otra colisión de cubeta no se ve desde acá: cuando el nightly corre con
// `modelo=todos`, el MISMO día ejecuta dos pasadas (groq y gemini). El workflow
// le pasa un id DISTINTO a cada una (PROBAR_MODELO_CLIENTE_GROQ / _GEMINI) para
// que no se repartan los 200k del cliente-agente entre las dos — en la corrida
// 35012068144 la segunda pasada arrancó con la cubeta ya casi vacía y cortó 2 de
// los 5 exploratorios a mitad de conversación.
//
// ⚠️ Acoplamiento a mano: este id no se puede importar de modelos.ts (es TS y
// esto es .mjs suelto), así que si algún día la cadena cambia y este modelo pasa
// a ser el primario, la colisión vuelve en silencio. El chequeo de abajo avisa.
const MODELO_CLIENTE = process.env.PROBAR_MODELO_CLIENTE || 'qwen/qwen3.8-27b';
const SOLO_GUIONADOS = process.env.PROBAR_SOLO_GUIONADOS === '1';
const SOLO_EXPLORATORIOS = process.env.PROBAR_SOLO_EXPLORATORIOS === '1';
const ENDPOINT = `${BASE_URL}/api/dev/simular-conversacion`;

// Cliente-agente para los escenarios exploratorios. createGroq() lee GROQ_API_KEY
// (por eso el npm script corre con --env-file=.env.local). Es lazy: si solo
// corrés guionados, nunca se usa.
const groq = createGroq();

/**
 * Cuánto esfuerzo de razonamiento pedirle al cliente-agente. NO es un parámetro
 * de calidad: es de COMPATIBILIDAD. `gpt-oss-*` RECHAZA 'none' con un 400
 * ("`reasoning_effort` must be one of `low`, `medium`, ..."), así que mandarle el
 * mismo valor que a qwen tumbaba TODAS sus llamadas —el preflight incluido—.
 * Medido contra la API el 2026-09-16.
 *
 * El mínimo que acepta cada familia: gpt-oss → 'low', qwen3.x → 'none'. Con 'low',
 * gpt-oss-120b cierra los escenarios bien (FIN 3/3 en la prueba); con 'medium'
 * empieza a alargar la charla (2/3).
 */
const esfuerzoRazonamiento = (id) => (id.startsWith('openai/gpt-oss') ? 'low' : 'none');

const opcionesRazonamiento = () => ({
  groq: { reasoningFormat: 'hidden', reasoningEffort: esfuerzoRazonamiento(MODELO_CLIENTE) },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST al endpoint con auto-retry cuando el bot se quedó SIN CUOTA.
//
// Hasta la corrida 34928105031 este retry era código muerto: miraba un
// `ok:false` con texto de rate-limit, pero `/api/dev/simular-conversacion`
// NUNCA devolvía eso — `procesarMensajesDeCliente` se traga el 429, manda su
// "no te entendí" y el endpoint respondía `ok:true` con esa burbuja. O sea que
// una corrida sin cuota era indistinguible de un bot que se porta mal, y el
// informe de esa corrida reportó una regresión que no existía.
//
// Ahora el endpoint expone `falloExtraccion` con el motivo:
//   - 'sin_cuota'          → transitorio, se reintenta con backoff.
//   - 'modelo_inexistente' → NO se reintenta: hay que arreglar la cadena
//                            (npm run verificar-modelos lo detecta antes).
//   - 'validacion'         → es un fallo REAL del bot; se devuelve tal cual.
async function llamar(payload, reintentos = 4) {
  for (let intento = 1; intento <= reintentos; intento++) {
    let data;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      data = await res.json();
    } catch (error) {
      if (String(error).match(/ECONNREFUSED|fetch failed/i)) {
        throw new Error(`No se pudo conectar a ${ENDPOINT}. ¿Está corriendo "npm run dev" con BOT_TEST_MODE=1?`);
      }
      throw error;
    }
    if (data?.falloExtraccion === 'sin_cuota' && intento < reintentos) {
      // Backoff largo a propósito: el TPM de Groq se repone por minuto, así que
      // esperar 4s no alcanza. Arranca en 20s y crece.
      const espera = 20000 * intento;
      console.log(`   ⏳ sin cuota de Groq, reintento ${intento}/${reintentos - 1} en ${Math.round(espera / 1000)}s…`);
      await sleep(espera);
      continue;
    }
    return data;
  }
}

/**
 * Nota legible para el transcript cuando el turno no se pudo evaluar por culpa
 * de la infraestructura (cuota/modelo), no del bot. Es lo que impide que el juez
 * vuelva a leer un "no te entendí" por falta de cuota como una regresión.
 * Devuelve null si el turno sí es evaluable. Pura y exportada para test.
 */
export function notaDeFalloExtraccion(data, turno) {
  const motivo = data?.falloExtraccion;
  if (!motivo) return null;
  if (motivo === 'sin_cuota') {
    return `Turno ${turno}: ⚠️ NO EVALUABLE — se agotó la cuota de Groq en toda la cadena de modelos (se reintentó y siguió sin cuota). El "no te entendí" de este turno es de infraestructura, NO del bot.`;
  }
  if (motivo === 'modelo_inexistente') {
    return `Turno ${turno}: ⚠️ NO EVALUABLE — algún modelo de la cadena no existe en el proveedor (dado de baja). Corré "npm run verificar-modelos" y actualizá modelos.ts.`;
  }
  return `Turno ${turno}: la extracción falló por validación del schema tras agotar los reintentos. Esto SÍ es un fallo del bot.`;
}

/**
 * Estimación del costo de una corrida: cuántas llamadas al LLM, cuántos tokens y
 * cuánto va a tardar. Los clicks de botón no cuentan (se resuelven inline, 0
 * tokens); los exploratorios no tienen turnos fijos, así que se usa el tope, y
 * cada turno suyo son DOS llamadas (el cliente-agente improvisa y el bot procesa).
 *
 * Es aproximada a propósito —las consultas de negocio agregan llamadas que no se
 * pueden prever—, pero alcanza para decidir si conviene correr la suite completa
 * hoy o filtrar: una corrida entera se come ~92% del TPD de un modelo.
 * Pura y exportada para test.
 */
export function estimarCorrida(escenarios, delayMs, tokensPorTurno = TOKENS_POR_TURNO, tpd = 200000, maxTurnos = MAX_TURNOS) {
  let llamadas = 0;
  for (const e of escenarios) {
    if (e.tipo === 'exploratorio') llamadas += maxTurnos * 2;
    else llamadas += (e.turnos ?? []).filter((t) => !t.boton).length;
  }
  const tokens = llamadas * tokensPorTurno;
  return {
    llamadas,
    tokens,
    porcentajeTPD: Math.round((tokens / tpd) * 100),
    minutos: Math.ceil((llamadas * delayMs) / 60000),
  };
}

// Chequeo automático (mecánico) del estado final contra `espera`. Los criterios
// en lenguaje natural los evalúa el juez (Claude Code); esto es solo la señal
// rápida y objetiva sobre el pedido resultante.
function chequear(espera, pedido) {
  if (!espera) return null;
  const checks = [];
  const add = (campo, ok, detalle) => checks.push({ campo, ok, detalle });
  if (espera.estadoFinal !== undefined) {
    add('estadoFinal', pedido?.estado === espera.estadoFinal, `esperado="${espera.estadoFinal}" real="${pedido?.estado ?? '(sin pedido)'}"`);
  }
  if (espera.cantidad_agua !== undefined) {
    add('cantidad_agua', pedido?.cantidad_agua === espera.cantidad_agua, `esperado=${espera.cantidad_agua} real=${pedido?.cantidad_agua ?? '-'}`);
  }
  if (espera.cantidad_crema !== undefined) {
    add('cantidad_crema', pedido?.cantidad_crema === espera.cantidad_crema, `esperado=${espera.cantidad_crema} real=${pedido?.cantidad_crema ?? '-'}`);
  }
  if (espera.direccionContiene !== undefined) {
    const dir = String(pedido?.direccion ?? '');
    add('direccion', dir.toLowerCase().includes(espera.direccionContiene.toLowerCase()), `esperado contiene "${espera.direccionContiene}" real="${dir}"`);
  }
  // Sabores: el bug que motivó el chequeo es que una palabra de FORMATO ("palitos")
  // terminaba persistida como si fuera un sabor. Eso no se ve en ningún otro campo,
  // así que sin esto la regresión dependía del ojo del juez.
  if (espera.observacionesContiene !== undefined) {
    const obs = String(pedido?.observaciones ?? '');
    add('observaciones', obs.toLowerCase().includes(espera.observacionesContiene.toLowerCase()), `esperado contiene "${espera.observacionesContiene}" real="${obs}"`);
  }
  if (espera.observacionesNoContiene !== undefined) {
    const obs = String(pedido?.observaciones ?? '');
    add('observaciones(veto)', !obs.toLowerCase().includes(espera.observacionesNoContiene.toLowerCase()), `NO debe contener "${espera.observacionesNoContiene}" real="${obs}"`);
  }
  if (espera.metodo_pago !== undefined) {
    add('metodo_pago', pedido?.metodo_pago === espera.metodo_pago, `esperado="${espera.metodo_pago}" real="${pedido?.metodo_pago ?? '-'}"`);
  }
  return checks;
}

function volcarRespuestas(respuestas, transcript) {
  for (const r of respuestas ?? []) {
    if (r.tipo === 'botones') {
      const ops = r.opciones.map((o) => o.title).join(' | ');
      transcript.push({ rol: 'bot', texto: `${r.texto}\n[botones: ${ops}]`, opciones: r.opciones });
    } else {
      transcript.push({ rol: 'bot', texto: r.texto });
    }
  }
}

async function correrGuionado(escenario, telefono) {
  const transcript = [];
  let ultimoPedido = null;
  const notas = [];

  const turnos = escenario.turnos.slice(0, MAX_TURNOS);
  if (escenario.turnos.length > MAX_TURNOS) {
    notas.push(`Escenario truncado a ${MAX_TURNOS} turnos (tenía ${escenario.turnos.length}).`);
  }

  for (let i = 0; i < turnos.length; i++) {
    const turno = turnos[i];

    if (turno.boton) {
      const pedidoId = turno.pedidoId ?? ultimoPedido?.id;
      if (!pedidoId) {
        notas.push(`Turno ${i + 1}: no había pedido para resolver el pedidoId del botón "${turno.boton}". Se omitió.`);
        transcript.push({ rol: 'sistema', texto: `(no se pudo tocar el botón "${turno.boton}": sin pedido activo)` });
        continue;
      }
      transcript.push({ rol: 'cliente', texto: `[toca botón: ${turno.boton}]` });
      const data = await llamar({ accion: 'tocarBoton', telefono, botonAccion: turno.boton, pedidoId });
      volcarRespuestas(data?.respuestas, transcript);
      if (data?.pedido) ultimoPedido = data.pedido;
    } else {
      const textos = turno.textos ?? [turno.texto];
      transcript.push({ rol: 'cliente', texto: textos.join('  ⏎  ') });
      const data = await llamar({ accion: 'enviarTexto', telefono, textos });
      // Un fallo de extracción por cuota/modelo NO es un fallo del bot: se anota
      // aparte y bien visible para que el juez no lo lea como regresión.
      const notaFallo = notaDeFalloExtraccion(data, i + 1);
      if (notaFallo) notas.push(notaFallo);
      else if (data?.error) notas.push(`Turno ${i + 1}: el endpoint devolvió error: ${data.error}`);
      volcarRespuestas(data?.respuestas, transcript);
      if (data?.pedido) ultimoPedido = data.pedido;
    }

    if (i < turnos.length - 1) await sleep(DELAY_MS);
  }

  const estadoFinal = await llamar({ accion: 'estado', telefono });
  const pedidoFinal = estadoFinal?.pedido ?? ultimoPedido ?? null;

  return {
    nombre: escenario.nombre,
    tipo: escenario.tipo,
    persona: escenario.persona,
    telefono,
    transcript,
    espera: escenario.espera ?? null,
    chequeoAutomatico: chequear(escenario.espera, pedidoFinal),
    pedidoFinal,
    xfail: escenario.xfail ?? null,
    notas,
  };
}

// Pide al cliente-agente (Groq) su próximo mensaje dado el guion de persona +
// objetivo + la conversación hasta ahora. Devuelve el texto o 'FIN'.
async function siguienteMensajeCliente(escenario, transcript) {
  const historial =
    transcript
      .map((m) => `${m.rol === 'cliente' ? 'VOS (cliente)' : 'BOT'}: ${m.texto}`)
      .join('\n') || '(todavía no escribiste nada)';

  const system = `Sos un cliente REAL escribiendo por WhatsApp a una heladería (WAGY) que toma pedidos con un bot, no tiene local, sino que envían a domicilio o aceptan retiros en la ubicacion donde preparan los pedidos, venden únicamente helados de palito por unidad en cantidades de por lo menos 20, con 2 tipos: de crema o de agua, con varios sabores dentro de cada tipo. 
  Escribís en español rioplatense informal (de vos), mensajes cortos y naturales, como una persona en el celular. NO actúes de asistente, NO expliques lo que hacés, NO uses comillas.

Tu personaje: ${escenario.persona}
Tu objetivo: ${escenario.objetivo}
Cómo comportarte:
${(escenario.pistas || []).map((p) => `- ${p}`).join('\n')}

Reglas de salida:
- Devolvé SOLO tu próximo mensaje como cliente (una burbuja de WhatsApp).
- Cuando tu objetivo ya se cumplió, o la charla no tiene más sentido, respondé exactamente: FIN`;

  const { text } = await generateText({
    model: groq(MODELO_CLIENTE),
    system,
    prompt: `Conversación hasta ahora:\n${historial}\n\nTu próximo mensaje (o FIN):`,
    temperature: 0.7,
    // Una burbuja de WhatsApp no necesita más. Sin un tope explícito, el modelo
    // de razonamiento gastaba la salida entera en el bloque <think> y el mensaje
    // real salía cortado a mitad de frase (corrida 32609751045).
    maxOutputTokens: 300,
    // CAUSA RAÍZ de la fuga de <think>: el MODELO_CLIENTE de Groq es de
    // razonamiento híbrido. `hidden` le pide a Groq que no devuelva el bloque y
    // `none` que directamente no razone (es un cliente improvisando un mensaje
    // corto, no lo necesita). `limpiarMensajeCliente` queda igual como red,
    // porque esto depende de que el modelo del día soporte las dos opciones —y
    // porque con un modelo de Google estas opciones no aplican.
    providerOptions: opcionesRazonamiento(),
  });
  // Se limpia SIEMPRE antes de que el llamador compare contra FIN o se lo mande
  // al bot: el crudo puede traer razonamiento pegado adelante.
  return limpiarMensajeCliente(text);
}

/**
 * ¿El cliente-agente está corriendo en el MISMO modelo que el primario del bot?
 * Si sí, los dos comen de la misma cubeta TPD (200k en el free tier de Groq) y la
 * corrida se queda sin tokens antes de terminar. El id del primario se le pregunta
 * al server (GET del endpoint de simulación, 0 tokens) en vez de duplicarlo acá,
 * así no se desincroniza cuando cambie la cadena en modelos.ts.
 *
 * Solo avisa: no aborta. Puede haber una razón para querer los dos iguales, y un
 * fallo de esta consulta no debería tumbar la corrida.
 */
async function avisarSiColisionaConElBot() {
  try {
    const r = await fetch(ENDPOINT, { method: 'GET' });
    if (!r.ok) return;
    const { primarioExtraccion, proveedor } = await r.json();
    if (!primarioExtraccion || primarioExtraccion !== MODELO_CLIENTE) return;
    console.log(
      `\n⚠️  El cliente-agente usa "${MODELO_CLIENTE}", el MISMO modelo primario del bot (${proveedor}).\n` +
      '   Van a compartir la cubeta de cuota y es probable que la corrida se quede sin tokens.\n' +
      '   Elegí otro modelo de la cadena con PROBAR_MODELO_CLIENTE.\n'
    );
  } catch {
    // El server puede no estar listo o ser una versión vieja sin GET: no es motivo
    // para frenar nada.
  }
}

// Chequeo previo del modelo del cliente-agente. Groq da de baja modelos sin
// aviso (le pasó a llama-3.3-70b-versatile) y el síntoma era pésimo: los 5
// escenarios fallaban en el turno 1 y quedaba una nota por escenario en vez de
// un error claro. Una llamada mínima acá lo convierte en un abort ruidoso.
async function preflightModeloCliente() {
  await avisarSiColisionaConElBot();
  process.stdout.write(`🔎 Preflight del modelo del cliente-agente (${MODELO_CLIENTE})… `);
  try {
    await generateText({
      model: groq(MODELO_CLIENTE),
      prompt: 'Respondé solo: ok',
      maxOutputTokens: 16,
      providerOptions: opcionesRazonamiento(),
    });
    console.log('OK');
  } catch (error) {
    console.log('❌');
    throw new Error(
      `El modelo del cliente-agente "${MODELO_CLIENTE}" no respondió: ${String(error.message || error)}\n` +
      '   Si Groq lo dio de baja, elegí otro vigente (GET /openai/v1/models) y actualizá\n' +
      '   PROBAR_MODELO_CLIENTE (local) y .github/workflows/nightly-bot-test.yml (CI).\n' +
      '   Si el error habla de `reasoning_effort`, el modelo no acepta el valor que le manda\n' +
      '   `esfuerzoRazonamiento` — agregá su familia ahí en vez de cambiarlo para todos.'
    );
  }
}

async function correrExploratorio(escenario, telefono) {
  const transcript = [];
  const notas = [];
  let ultimoPedido = null;

  for (let turno = 0; turno < MAX_TURNOS; turno++) {
    let mensaje;
    try {
      mensaje = await siguienteMensajeCliente(escenario, transcript);
    } catch (error) {
      notas.push(`El cliente-agente falló en el turno ${turno + 1}: ${String(error.message || error)}`);
      break;
    }
    if (/^fin\b/i.test(mensaje)) break;

    // Guarda ruidosa: un mensaje vacío o larguísimo significa que el cliente-agente
    // filtró razonamiento (o se cortó a mitad). Cortamos el escenario con una nota
    // visible en el informe, en vez de seguir contaminando la conversación en silencio.
    const valido = validarMensajeCliente(mensaje);
    if (!valido.ok) {
      notas.push(`Turno ${turno + 1}: ${valido.motivo} Se cortó el escenario acá.`);
      break;
    }

    transcript.push({ rol: 'cliente', texto: mensaje });
    const data = await llamar({ accion: 'enviarTexto', telefono, texto: mensaje });
    if (data?.error) notas.push(`Turno ${turno + 1}: el endpoint devolvió error: ${data.error}`);
    volcarRespuestas(data?.respuestas, transcript);
    if (data?.pedido) ultimoPedido = data.pedido;

    await sleep(DELAY_MS);
  }
  if (transcript.length >= MAX_TURNOS * 2) {
    notas.push(`Alcanzó el tope de ${MAX_TURNOS} turnos sin que el cliente-agente diera por terminada la charla.`);
  }

  const estadoFinal = await llamar({ accion: 'estado', telefono });
  return {
    nombre: escenario.nombre,
    tipo: escenario.tipo,
    persona: escenario.persona,
    objetivo: escenario.objetivo,
    telefono,
    transcript,
    espera: null,
    chequeoAutomatico: null,
    pedidoFinal: estadoFinal?.pedido ?? ultimoPedido ?? null,
    xfail: escenario.xfail ?? null,
    notas,
  };
}

function renderMarkdown(corrida) {
  const l = [];
  l.push(`# Transcripts — corrida ${corrida.generadoEn}`);
  l.push('');
  l.push(`Base: ${BASE_URL} · ${corrida.escenarios.length} escenario(s)`);
  l.push('');
  l.push('> Este archivo es la ENTRADA del juez (Claude Code). El veredicto (✅/⚠️/❓) y el informe van en `informe.md`.');
  l.push('');
  for (const e of corrida.escenarios) {
    l.push(`## ${e.nombre}  \`${e.tipo}\``);
    l.push('');
    l.push(`**Persona:** ${e.persona}`);
    if (e.objetivo) {
      l.push('');
      l.push(`**Objetivo:** ${e.objetivo}`);
    }
    l.push('');
    l.push('**Conversación:**');
    l.push('');
    for (const m of e.transcript) {
      const quien = m.rol === 'cliente' ? '🧑 Cliente' : m.rol === 'bot' ? '🤖 Bot' : '⚙️ Sistema';
      const texto = String(m.texto ?? '').split('\n').join('\n> ');
      l.push(`> **${quien}:** ${texto}`);
      l.push('>');
    }
    l.push('');
    if (e.espera) {
      l.push('**Esperado (oráculo):**');
      l.push('');
      l.push('```json');
      l.push(JSON.stringify(e.espera, null, 2));
      l.push('```');
      l.push('');
    }
    if (e.chequeoAutomatico) {
      l.push('**Chequeo automático del estado final:**');
      l.push('');
      for (const c of e.chequeoAutomatico) {
        l.push(`- ${c.ok ? '✅' : '❌'} \`${c.campo}\` — ${c.detalle}`);
      }
      l.push('');
    }
    l.push('**Pedido final en DB:**');
    l.push('');
    l.push('```json');
    l.push(JSON.stringify(resumenPedido(e.pedidoFinal), null, 2));
    l.push('```');
    l.push('');
    if (e.notas?.length) {
      l.push('**Notas del harness:**');
      l.push('');
      for (const n of e.notas) l.push(`- ⚠️ ${n}`);
      l.push('');
    }
    l.push('---');
    l.push('');
  }
  return l.join('\n');
}

// Proyección compacta del pedido para el transcript (las columnas que importan).
function resumenPedido(p) {
  if (!p) return null;
  return {
    id: p.id,
    estado: p.estado,
    enviado: p.enviado,
    cantidad_agua: p.cantidad_agua,
    cantidad_crema: p.cantidad_crema,
    direccion: p.direccion,
    aclaracion: p.aclaracion,
    metodo_pago: p.metodo_pago,
    observaciones: p.observaciones,
    precio_total: p.precio_total,
    esperando_respuesta_boton: p.esperando_respuesta_boton,
    auto_rechazado: p.auto_rechazado,
  };
}

async function main() {
  const seleccionados = ESCENARIOS
    .filter((e) => !FILTER || e.nombre.toLowerCase().includes(FILTER.toLowerCase()))
    .filter((e) => !(SOLO_GUIONADOS && e.tipo === 'exploratorio'))
    .filter((e) => !(SOLO_EXPLORATORIOS && e.tipo === 'guionado'));

  if (!seleccionados.length) {
    console.log('No hay escenarios para correr (revisá PROBAR_FILTER / PROBAR_SOLO_GUIONADOS).');
    return;
  }

  const nGuionados = seleccionados.filter((e) => e.tipo === 'guionado').length;
  const nExplor = seleccionados.filter((e) => e.tipo === 'exploratorio').length;
  console.log(`▶️  Corriendo ${seleccionados.length} escenario(s) contra ${BASE_URL} (${nGuionados} guionado(s), ${nExplor} exploratorio(s))`);
  console.log(`   delay entre turnos: ${DELAY_MS}ms · prefijo teléfonos: ${PREFIX} · modelo cliente: ${MODELO_CLIENTE}`);
  // Estimación por adelantado: el free-tier de Groq es chico y una corrida
  // completa se come casi el TPD entero de un modelo. Mejor saberlo ANTES de
  // arrancar que descubrirlo a mitad de camino con un "no te entendí".
  const est = estimarCorrida(seleccionados, DELAY_MS);
  console.log(
    `   estimado: ~${est.llamadas} llamada(s) al LLM · ~${est.tokens.toLocaleString()} tokens ` +
    `(~${est.porcentajeTPD}% del TPD de un modelo) · ~${est.minutos} min\n`,
  );

  // Solo si hay exploratorios: los guionados no usan el cliente-agente y no
  // tienen por qué gastar una llamada a Groq ni depender de ese modelo.
  if (nExplor > 0) await preflightModeloCliente();

  const generadoEn = new Date().toISOString();
  const escenarios = [];

  for (let idx = 0; idx < seleccionados.length; idx++) {
    const escenario = seleccionados[idx];
    const telefono = `${PREFIX}${String(idx + 1).padStart(7, '0')}`;
    process.stdout.write(`• ${escenario.nombre} [${escenario.tipo}] (${telefono})… `);

    await llamar({ accion: 'reset', telefono });
    try {
      const resultado =
        escenario.tipo === 'exploratorio'
          ? await correrExploratorio(escenario, telefono)
          : await correrGuionado(escenario, telefono);
      escenarios.push(resultado);
      if (escenario.tipo === 'guionado') {
        const fallos = (resultado.chequeoAutomatico ?? []).filter((c) => !c.ok).length;
        if (fallos === 0) console.log('✅ chequeo automático OK');
        else if (escenario.xfail) console.log(`⚠️ ${fallos} chequeo(s) en rojo (xfail conocido, no gatea)`);
        else console.log(`⚠️ ${fallos} chequeo(s) automático(s) en rojo`);
      } else {
        console.log(`💬 ${resultado.transcript.filter((m) => m.rol === 'cliente').length} turno(s) de cliente`);
      }
    } catch (error) {
      console.log(`❌ ${String(error.message || error)}`);
      escenarios.push({ nombre: escenario.nombre, tipo: escenario.tipo, error: String(error.message || error) });
    } finally {
      await llamar({ accion: 'reset', telefono }); // limpieza
    }

    if (idx < seleccionados.length - 1) await sleep(DELAY_MS);
  }

  const corrida = { generadoEn, baseUrl: BASE_URL, escenarios };
  const carpeta = join('informes-bot', `corrida-${generadoEn.replace(/[:.]/g, '-')}`);
  mkdirSync(carpeta, { recursive: true });
  writeFileSync(join(carpeta, 'transcripts.json'), JSON.stringify(corrida, null, 2), 'utf8');
  writeFileSync(join(carpeta, 'transcripts.md'), renderMarkdown(corrida), 'utf8');

  console.log(`\n📝 Transcripts guardados en ${carpeta}/`);
  console.log('   Paso 2 — pedile a Claude Code: "juzgá la última corrida de probar-bot".');

  // Señal de regresión para CI (GitHub Actions): con PROBAR_FAIL_ON_RED=1, si algún
  // escenario tuvo un chequeoAutomatico en rojo o un error, salimos con código != 0
  // para que el workflow falle y avise. En local (sin el flag) no cambia nada: siempre
  // sale 0 y te quedás leyendo el informe.
  if (process.env.PROBAR_FAIL_ON_RED === '1') {
    const enRojo = (e) => e.error || (e.chequeoAutomatico ?? []).some((c) => !c.ok);
    const regresiones = escenarios.filter((e) => enRojo(e) && !e.xfail);
    const xfailEnRojo = escenarios.filter((e) => enRojo(e) && e.xfail);
    const xfailQueYaPasan = escenarios.filter((e) => !enRojo(e) && e.xfail);

    for (const e of xfailEnRojo) {
      console.log(`\n⚠️ (xfail conocido, NO gatea) "${e.nombre}" en rojo. Motivo: ${e.xfail}`);
    }
    for (const e of xfailQueYaPasan) {
      console.log(`\n🎉 "${e.nombre}" estaba marcado xfail y AHORA PASA — sacale el marcador xfail en escenarios-bot.mjs.`);
    }

    if (regresiones.length) {
      console.log(`\n❌ ${regresiones.length} regresión(es) nueva(s): ${regresiones.map((e) => e.nombre).join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('\n✅ Sin regresiones nuevas (verde, salvo xfail conocidos).');
    }
  }
}

// Solo corre la suite cuando se invoca como SCRIPT. Sin esta guarda, cualquier
// `import` del módulo lanza la corrida entera: `scripts/probar-bot.test.mjs`
// importa `notaDeFalloExtraccion` y `npm test` terminaba disparando los 27
// escenarios contra localhost:3000 — quemando tokens de Groq si había un dev
// server con BOT_TEST_MODE levantado.
const invocadoComoScript = process.argv[1] && /probar-bot\.mjs$/.test(process.argv[1]);

if (invocadoComoScript) {
  main().catch((error) => {
    console.error('❌ Error fatal:', error);
    process.exitCode = 1; // no process.exit(): deja drenar los sockets keep-alive en Windows
  });
}

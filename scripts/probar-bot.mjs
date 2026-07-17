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
//   PROBAR_DELAY_MS=15000              pausa entre turnos (cada turno pega a Groq;
//                                      el free-tier tiene 8000 TPM). 0 en Dev Tier.
//   PROBAR_PREFIX=54000                prefijo de los teléfonos de test (debe
//                                      coincidir con BOT_TEST_PREFIX del server)
//   PROBAR_MAX_TURNOS=12               tope de turnos por escenario (red de seguridad)
//   PROBAR_MODELO_CLIENTE=openai/gpt-oss-20b   modelo Groq del cliente-agente (exploratorios)
//   PROBAR_SOLO_GUIONADOS=1            omite los exploratorios (no usa el cliente-agente LLM)
//   PROBAR_SOLO_EXPLORATORIOS=1        omite los guionados (corre solo la capa exploratoria)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { ESCENARIOS } from './escenarios-bot.mjs';

const BASE_URL = process.env.PROBAR_URL || 'http://localhost:3000';
const FILTER = process.env.PROBAR_FILTER || '';
const DELAY_MS = Math.max(0, parseInt(process.env.PROBAR_DELAY_MS || '15000', 10));
const PREFIX = process.env.PROBAR_PREFIX || '54000';
const MAX_TURNOS = Math.max(1, parseInt(process.env.PROBAR_MAX_TURNOS || '12', 10));
const MODELO_CLIENTE = process.env.PROBAR_MODELO_CLIENTE || 'openai/gpt-oss-20b';
const SOLO_GUIONADOS = process.env.PROBAR_SOLO_GUIONADOS === '1';
const SOLO_EXPLORATORIOS = process.env.PROBAR_SOLO_EXPLORATORIOS === '1';
const ENDPOINT = `${BASE_URL}/api/dev/simular-conversacion`;

// Cliente-agente para los escenarios exploratorios. createGroq() lee GROQ_API_KEY
// (por eso el npm script corre con --env-file=.env.local). Es lazy: si solo
// corrés guionados, nunca se usa.
const groq = createGroq();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST al endpoint con auto-retry ante rate-limit de Groq (mismo criterio que
// el eval): el bot corre Groq de verdad y en free-tier choca contra el TPM.
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
    const esRateLimit = data && data.ok === false && /rate limit|rate_limit|TPM|tokens per minute/i.test(String(data.error || ''));
    if (esRateLimit && intento < reintentos) {
      const espera = 4000 * intento;
      console.log(`   ⏳ rate-limit de Groq, reintento ${intento}/${reintentos - 1} en ${espera}ms…`);
      await sleep(espera);
      continue;
    }
    return data;
  }
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
      if (data?.error) notas.push(`Turno ${i + 1}: el endpoint devolvió error: ${data.error}`);
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

  const system = `Sos un cliente REAL escribiendo por WhatsApp a una heladería (WAGY) que toma pedidos con un bot. Escribís en español rioplatense informal (de vos), mensajes cortos y naturales, como una persona en el celular. NO actúes de asistente, NO expliques lo que hacés, NO uses comillas.

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
  });
  return (text || '').trim();
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
    if (!mensaje || /^fin\b/i.test(mensaje)) break;

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
  console.log(`   delay entre turnos: ${DELAY_MS}ms · prefijo teléfonos: ${PREFIX} · modelo cliente: ${MODELO_CLIENTE}\n`);

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

main().catch((error) => {
  console.error('❌ Error fatal:', error);
  process.exitCode = 1; // no process.exit(): deja drenar los sockets keep-alive en Windows
});

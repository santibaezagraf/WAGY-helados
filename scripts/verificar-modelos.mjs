// Verifica que TODOS los ids de modelo que el sistema puede llegar a usar sigan
// existiendo en su proveedor. NO gasta un solo token de inferencia: son dos GET
// al listado de modelos.
//
// POR QUÉ EXISTE: es la tercera vez que un modelo dado de baja rompe algo sin
// aviso — `llama-3.3-70b-versatile` (corrida 32609751045, mató los 5 exploratorios),
// `moonshotai/kimi-k2-instruct` + `qwen/qwen3-32b` (detectados a mano), y
// `qwen/qwen3.6-27b` (corrida 34928105031, que además hizo perder un pedido
// completo porque era el último eslabón de la cadena de producción). La
// mitigación hasta ahora era "acordate de verificar a mano contra
// GET /openai/v1/models". No funcionó. Esto lo hace la máquina.
//
// CÓMO CORRERLO:
//   npm run verificar-modelos
// En CI corre ANTES de la suite, así un modelo muerto falla con un mensaje claro
// en vez de convertirse en escenarios rojos con diagnóstico confuso.
//
// Sale con código 1 si falta alguno.

import { readFileSync } from 'node:fs';

const RUTA_MODELOS = 'src/lib/bot/modelos.ts';
const RUTA_HARNESS = 'scripts/probar-bot.mjs';

// Familias de MIME type, que tienen la misma forma `algo/algo` que un id de
// modelo y aparecen en headers ('Content-Type': 'application/json').
const PREFIJOS_NO_MODELO = /^(application|text|image|audio|video|multipart)\//i;

/** Saca comentarios de línea y de bloque, para no leer ids que solo se MENCIONAN. */
function sinComentarios(fuente) {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Extrae los ids de modelo declarados en el fuente TS. No se puede importar
 * `modelos.ts` desde acá (es TypeScript y esto es un .mjs suelto), así que se
 * parsea: buscamos strings con pinta de id de modelo (`org/modelo` o `gemini-*`).
 *
 * Ignora los comentarios a propósito: `modelos.ts` documenta en prosa modelos que
 * se DIERON DE BAJA o que se decidió no usar, y verificarlos sería ruido (o peor,
 * un rojo por un modelo que nadie usa).
 *
 * Si no encuentra NADA, el script falla ruidoso en vez de dar por buena una
 * verificación vacía — si alguien reestructura el archivo, esto grita en lugar de
 * pasar sin chequear nada, que sería el peor modo de falla para un guard.
 *
 * Exportada para test (scripts/verificar-modelos.test.mjs).
 */
export function extraerIdsDeModelo(fuente) {
  const ids = new Set();
  for (const m of sinComentarios(fuente).matchAll(/['"`]([a-z0-9][\w.-]*\/[\w.-]+|gemini-[\w.-]+)['"`]/gi)) {
    if (!PREFIJOS_NO_MODELO.test(m[1])) ids.add(m[1]);
  }
  return [...ids];
}

/**
 * El modelo del cliente-agente del harness. Se extrae con un patrón ANCLADO a su
 * constante en vez de escanear el archivo entero: `probar-bot.mjs` está lleno de
 * strings con barra que no son modelos. Devuelve `null` si no lo encuentra.
 * Exportada para test.
 */
export function extraerModeloCliente(fuente) {
  const m = fuente.match(/PROBAR_MODELO_CLIENTE\s*\|\|\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1] : null;
}

/** Groq y Google se distinguen por el id (misma regla que `proveedorDeModelo`). */
export function proveedorDe(id) {
  return id.startsWith('gemini') ? 'google' : 'groq';
}

async function idsVigentesGroq(apiKey) {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error(`Groq respondió ${r.status} al listar modelos`);
  const j = await r.json();
  return (j.data ?? []).map((m) => m.id);
}

async function idsVigentesGoogle(apiKey) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`);
  if (!r.ok) throw new Error(`Google respondió ${r.status} al listar modelos`);
  const j = await r.json();
  // Vienen como "models/gemini-x"; normalizamos al id suelto que usa la cadena.
  return (j.models ?? []).map((m) => String(m.name).replace(/^models\//, ''));
}

async function main() {
  const fuenteModelos = readFileSync(RUTA_MODELOS, 'utf8');
  const fuenteHarness = readFileSync(RUTA_HARNESS, 'utf8');

  const declarados = extraerIdsDeModelo(fuenteModelos);
  if (declarados.length === 0) {
    console.error(`❌ No se encontró ningún id de modelo en ${RUTA_MODELOS}.`);
    console.error('   ¿Cambió la forma de declarar las cadenas? Actualizá extraerIdsDeModelo.');
    process.exit(1);
  }

  // El modelo del cliente-agente del harness no está en las cadenas del bot, pero
  // si se da de baja mata la suite exploratoria entera (pasó dos veces).
  const delHarness = new Set();
  const clientePorDefecto = extraerModeloCliente(fuenteHarness);
  if (clientePorDefecto) delHarness.add(clientePorDefecto);
  else console.warn(`⚠️  No se pudo leer el default de PROBAR_MODELO_CLIENTE en ${RUTA_HARNESS}.`);
  if (process.env.PROBAR_MODELO_CLIENTE) delHarness.add(process.env.PROBAR_MODELO_CLIENTE);

  const todos = [...new Set([...declarados, ...delHarness])].sort();
  const porProveedor = { groq: [], google: [] };
  for (const id of todos) porProveedor[proveedorDe(id)].push(id);

  let faltantes = 0;
  let omitidos = 0;

  for (const [proveedor, ids] of Object.entries(porProveedor)) {
    if (!ids.length) continue;

    const apiKey = proveedor === 'groq' ? process.env.GROQ_API_KEY : process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      // Sin key no se puede verificar. NO es un fallo: la cadena de Google solo
      // corre con LLM_PROVIDER=google, así que en un CI de Groq no tener la key
      // de Google es lo normal. Se avisa para que no parezca que se verificó.
      console.log(`⏭️  ${proveedor}: sin API key, no se verifican ${ids.length} id(s): ${ids.join(', ')}`);
      omitidos += ids.length;
      continue;
    }

    let vigentes;
    try {
      vigentes = proveedor === 'groq' ? await idsVigentesGroq(apiKey) : await idsVigentesGoogle(apiKey);
    } catch (error) {
      console.error(`❌ ${proveedor}: no se pudo listar los modelos — ${error.message}`);
      process.exit(1);
    }

    console.log(`\n${proveedor} (${vigentes.length} modelos vigentes):`);
    for (const id of ids) {
      const ok = vigentes.includes(id);
      console.log(`  ${ok ? '✅' : '❌'} ${id}`);
      if (!ok) faltantes++;
    }
  }

  console.log('');
  if (faltantes > 0) {
    console.error(`❌ ${faltantes} modelo(s) declarado(s) ya NO existen en su proveedor.`);
    console.error(`   Actualizá ${RUTA_MODELOS} (cadenas + tabla LIMITES_MODELO),`);
    console.error(`   ${RUTA_HARNESS} y .github/workflows/nightly-bot-test.yml.`);
    console.error('   Los ids vigentes están listados arriba de cada bloque.');
    process.exit(1);
  }

  console.log(`✅ Los ${todos.length - omitidos} modelo(s) verificados existen.`);
}

// Solo corre el chequeo cuando se invoca como script (no al importarlo desde el test).
if (process.argv[1] && process.argv[1].endsWith('verificar-modelos.mjs')) {
  await main();
}

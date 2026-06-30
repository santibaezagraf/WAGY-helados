// Minería de expresiones de clientes para ampliar los sets del short-circuit
// (CONFIRMACIONES / NEGACIONES / SALUDOS en src/lib/bot/procesar.ts).
//
// El LLM ya generaliza a expresiones nuevas; los sets son solo una optimización
// para cortar antes del LLM en casos triviales. Este script NO entrena nada:
// descubre qué formas CORTAS y FRECUENTES caen hoy al LLM y podrían sumarse al
// set. La decisión de agregarlas es HUMANA (una entrada mala en CONFIRMACIONES
// auto-confirmaría pedidos que el cliente rechaza).
//
// CÓMO CORRERLO:
//   1. npm run dev           (deja el server en localhost:3000)
//   2. npm run minar         (o: EVAL_URL=... MINAR_DIAS=30 npm run minar)
//
// Variables opcionales:
//   EVAL_URL=http://localhost:3000   base del server (misma que el eval)
//   MINAR_DIAS=90                    ventana hacia atrás
//   MINAR_MAX_PALABRAS=4             descarta mensajes más largos que esto
//   MINAR_MIN_COUNT=2                frecuencia mínima para listar

const BASE_URL = process.env.EVAL_URL || 'http://localhost:3000';
const DIAS = process.env.MINAR_DIAS || '90';
const MAX_PALABRAS = process.env.MINAR_MAX_PALABRAS || '4';
const MIN_COUNT = process.env.MINAR_MIN_COUNT || '2';

async function main() {
  const qs = new URLSearchParams({ dias: DIAS, maxPalabras: MAX_PALABRAS, minCount: MIN_COUNT });
  let data;
  try {
    const res = await fetch(`${BASE_URL}/api/dev/minar-expresiones?${qs}`);
    data = await res.json();
  } catch (e) {
    if (e?.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(String(e))) {
      console.error(`\n❌ No me pude conectar a ${BASE_URL}. ¿Está corriendo "npm run dev"?\n`);
      process.exit(1);
    }
    throw e;
  }

  if (!data.ok) {
    console.error(`\n❌ El endpoint devolvió error: ${data.error ?? 'desconocido'}${data.detalle ? ` (${data.detalle})` : ''}\n`);
    process.exit(1);
  }

  const { parametros, totalMensajesCliente, candidatos } = data;
  console.log(`\n🔎 Minería de expresiones — últimos ${parametros.dias} días contra ${BASE_URL}`);
  console.log(`   ${totalMensajesCliente} mensajes de clientes analizados · ${candidatos.length} candidatos (≥${parametros.minCount} veces, ≤${parametros.maxPalabras} palabras)\n`);

  if (candidatos.length === 0) {
    console.log('   (Sin candidatos: o ya está todo cubierto, o no hay suficientes datos.)\n');
    return;
  }

  const anchoForma = Math.max(...candidatos.map(c => c.forma.length), 'expresión'.length);
  console.log(`   ${'#'.padStart(4)}  ${'expresión'.padEnd(anchoForma)}  ${'veces'.padStart(5)}  sugerencia`);
  console.log(`   ${'─'.repeat(4)}  ${'─'.repeat(anchoForma)}  ${'─'.repeat(5)}  ──────────`);
  candidatos.forEach((c, i) => {
    console.log(`   ${String(i + 1).padStart(4)}  ${c.forma.padEnd(anchoForma)}  ${String(c.count).padStart(5)}  ${c.sugerencia}`);
  });
  console.log(`\n   Revisá y agregá las que correspondan a los Set de src/lib/bot/procesar.ts.`);
  console.log(`   ⚠️ "sugerencia" es solo una pista; confirmá vos a qué set va cada una.\n`);
}

main();

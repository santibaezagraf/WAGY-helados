// Regenera src/types/supabase.ts desde UNO de los dos proyectos Supabase.
//
// Uso:
//   npm run update-types                    # producción (default, como siempre)
//   npm run update-types -- --solo=staging  # staging
//   npm run update-types -- --solo=prod
//   npm run update-types -- --dry-run       # genera y compara, pero NO escribe
//
// Por qué un script y no el `npx ... > archivo` de antes:
//
//  1. El ref del proyecto estaba hardcodeado en package.json apuntando SIEMPRE a
//     producción. Si migrabas staging primero y corrías update-types, te
//     regeneraba los tipos desde prod (que todavía no tenía las columnas nuevas)
//     y pisabas en silencio lo que estabas por usar.
//  2. La redirección `> src/types/supabase.ts` del shell **trunca el archivo
//     antes** de ejecutar el comando: si el CLI fallaba (sin login, sin red, ref
//     mal), te quedabas sin tipos y con el build roto. Acá capturamos la salida
//     y solo escribimos si el comando terminó bien y devolvió algo razonable.
//
// Requiere estar logueado en el CLI de Supabase (`npx supabase login`): `gen
// types --project-id` usa el access token, no la password de la base.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buscarProyecto, leerSolo } from './proyectos.mjs';

const DESTINO = 'src/types/supabase.ts';
const dryRun = process.argv.includes('--dry-run');
// Un archivo de tipos válido siempre es bastante más largo que esto; sirve para
// detectar una salida vacía o un mensaje de error corto que se coló por stdout.
const MINIMO_BYTES = 200;

// Default: prod. Mantiene el comportamiento histórico de `npm run update-types`
// para no romper la costumbre ni nada que lo invoque sin flag.
const clave = leerSolo(process.argv) ?? 'prod';
const proyecto = buscarProyecto(clave);

console.log(`\n=== Generando tipos desde ${proyecto.nombre} ${dryRun ? '(dry-run)' : ''} ===`);
console.log(`  project-id: ${proyecto.ref}  →  ${dryRun ? '(no se escribe nada)' : DESTINO}`);

const res = spawnSync(
  'npx',
  ['supabase', 'gen', 'types', 'typescript', '--project-id', proyecto.ref, '--schema', 'public'],
  {
    encoding: 'utf8',
    // stdout capturado; stderr directo a la consola para ver el error del CLI.
    stdio: ['inherit', 'pipe', 'inherit'],
    shell: process.platform === 'win32', // npx.cmd en Windows
  },
);

if (res.status !== 0) {
  console.error(`\n✗ Falló la generación de tipos (exit ${res.status}). ${DESTINO} quedó intacto.`);
  process.exit(1);
}

const salida = res.stdout ?? '';
if (salida.trim().length < MINIMO_BYTES) {
  console.error(
    `\n✗ La salida del CLI es sospechosamente corta (${salida.trim().length} bytes). ` +
      `No se escribió nada: ${DESTINO} quedó intacto.`,
  );
  console.error(salida);
  process.exit(1);
}

// El dry-run SÍ ejecuta la generación (así verifica de verdad que el CLI anda y
// que el proyecto responde); lo único que no hace es escribir el archivo.
if (dryRun) {
  const actual = existsSync(DESTINO) ? readFileSync(DESTINO, 'utf8') : null;
  console.log(`\n✔ Generación OK (${salida.length} bytes). NO se escribió ${DESTINO}.`);
  if (actual === null) {
    console.log(`  ${DESTINO} todavía no existe: un run real lo crearía.`);
  } else if (actual === salida) {
    console.log(`  Sin cambios: el archivo actual ya coincide con ${proyecto.nombre}.`);
  } else {
    console.log(
      `  DIFIERE del archivo actual (${actual.length} bytes) — un run real lo reemplazaría.`,
    );
  }
  process.exit(0);
}

writeFileSync(DESTINO, salida, 'utf8');
console.log(`\n✔ ${DESTINO} regenerado desde ${proyecto.nombre}.`);

if (clave !== 'prod') {
  console.log(
    `\n⚠ OJO: los tipos quedaron generados desde ${proyecto.nombre}, no desde producción.\n` +
      `  Antes de commitear, verificá que ambas bases tengan las mismas migraciones aplicadas.`,
  );
}

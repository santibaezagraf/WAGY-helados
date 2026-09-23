// Aplica las migraciones pendientes a AMBOS proyectos Supabase (prod + staging)
// en un solo comando, sin tener que relinkear entre uno y otro.
//
// Usa `supabase db push --db-url <conn>` para apuntar a cada base por
// connection string (session pooler, puerto 5432), en vez de `--linked`.
//
// Passwords: se leen de variables de entorno para no hardcodearlas.
//   WAGY_DB_PASSWORD_PROD      -> password de la base de producción
//   WAGY_DB_PASSWORD_STAGING   -> password de la base de staging
// (la "Database password" de cada proyecto en Supabase → Settings → Database)
//
// Uso (PowerShell):
//   $env:WAGY_DB_PASSWORD_PROD="..."; $env:WAGY_DB_PASSWORD_STAGING="..."
//   npm run migrar-todo                        # aplica a los dos, prod primero
//   npm run migrar-todo -- --dry-run           # solo muestra qué aplicaría
//   npm run migrar-todo -- --solo=staging      # SOLO staging (no pide la pass de prod)
//   npm run migrar-todo -- --solo=prod
//
// Notas:
// - Corre PROD primero y, si falla, NO toca staging (corta con exit 1).
// - Con --solo=<clave> se aplica a un único proyecto: sirve para probar una
//   migración riesgosa en staging antes de tocar producción.
// - La password se url-encodea (encodeURIComponent) por si tiene símbolos.
// - El host del pooler es el mismo para ambos (sa-east-1); solo cambia el ref.

import { spawnSync } from 'node:child_process';
import { PROYECTOS, leerSolo } from './proyectos.mjs';

const POOLER_HOST = 'aws-1-sa-east-1.pooler.supabase.com';
const POOLER_PORT = 5432; // session mode — el que usa `db push`

const dryRun = process.argv.includes('--dry-run');

// --solo=staging | --solo=prod: aplica a UN solo proyecto.
// Sirve para probar una migración riesgosa en staging antes de tocar producción
// (el default corre los dos, y prod primero).
const solo = leerSolo(process.argv);

// Filtramos ANTES del chequeo de passwords: con --solo=staging no debe pedir la
// de producción.
const objetivosAplicar = solo ? PROYECTOS.filter((p) => p.clave === solo) : PROYECTOS;

function construirDbUrl(ref, password) {
  const user = `postgres.${ref}`;
  const pass = encodeURIComponent(password);
  return `postgresql://${user}:${pass}@${POOLER_HOST}:${POOLER_PORT}/postgres`;
}

function ocultarPassword(url) {
  return url.replace(/:([^:@/]+)@/, ':****@');
}

let huboError = false;

for (const objetivo of objetivosAplicar) {
  const password = process.env[objetivo.envPassword];
  if (!password) {
    console.error(
      `\n✗ Falta la variable de entorno ${objetivo.envPassword} (password de ${objetivo.nombre}). Abortando.`,
    );
    process.exit(1);
  }

  const dbUrl = construirDbUrl(objetivo.ref, password);
  const args = ['supabase', 'db', 'push', '--db-url', dbUrl, '--yes'];
  if (dryRun) args.push('--dry-run');

  console.log(`\n=== ${objetivo.nombre} ${dryRun ? '(dry-run)' : ''} ===`);
  console.log(`  ${ocultarPassword(`db push --db-url ${dbUrl}`)}`);

  const res = spawnSync('npx', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32', // npx.cmd en Windows
  });

  if (res.status !== 0) {
    console.error(`\n✗ Falló el push contra ${objetivo.nombre} (exit ${res.status}).`);
    huboError = true;
    break; // no seguimos al siguiente si el primero falló
  }
  console.log(`✓ ${objetivo.nombre} al día.`);
}

if (huboError) process.exit(1);
console.log(`\n✔ Migraciones aplicadas en: ${objetivosAplicar.map((o) => o.nombre).join(' + ')}.`);

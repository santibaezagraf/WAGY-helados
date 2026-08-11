// Reconcilia el HISTORIAL de migraciones de prod y staging con el esquema real,
// sin re-ejecutar DDL que ya existe (lo que hace explotar a `db push` con
// "already exists"). Estado detectado el 2026-08-10 por inspección en vivo:
//
//   PROD    -> historial hasta 20260728; el DDL de agosto YA está aplicado a
//              mano. Fix: marcar las 6 de agosto como `applied` (repair), sin
//              correr SQL. No necesita db push.
//   STAGING -> NO existe la tabla de historial; el esquema es un clon
//              contiguo hasta 20260721. Faltan 11 migraciones (0722 -> 0806).
//              Fix: baseline (repair applied) del prefijo <=0721, y despues
//              `db push` aplica de VERDAD las 11 restantes.
//
// Verificado objeto por objeto antes de escribir estas listas (ver informe).
// Idempotente: repetir `repair applied` sobre versiones ya registradas es
// inofensivo, y `db push` solo corre lo que falte.
//
// Uso (PowerShell, desde una red que NO bloquee el puerto 5432 -> hotspot):
//   npm run reconciliar-migraciones -- --dry-run   # muestra el plan, no toca nada
//   npm run reconciliar-migraciones -- --si         # EJECUTA (prod + staging)
//   npm run reconciliar-migraciones -- --si --solo prod
//   npm run reconciliar-migraciones -- --si --solo staging
//
// Passwords: WAGY_DB_PASSWORD_PROD / WAGY_DB_PASSWORD_STAGING en .env.local
// (el npm script las inyecta con --env-file).

import { spawnSync } from 'node:child_process';

const HOST = 'aws-1-sa-east-1.pooler.supabase.com';
const PORT = 5432;

const PROD_REF = 'bhexbncbuieuxklegnjm';
const STAGING_REF = 'oqrufwtuwvogdfhojips';

// Prefijo del esquema que YA existe en staging (clon contiguo hasta 0721).
// Se marca como `applied` para que db push no intente re-crearlo.
const STAGING_BASELINE = [
  '20260113192925', '20260121020123', '20260130184329', '20260522120000',
  '20260610030000', '20260630120000', '20260630130000', '20260630140000',
  '20260712120000', '20260713120000', '20260713130000', '20260714120000',
  '20260714120100', '20260714120200', '20260714120300', '20260720120000',
  '20260721120000',
];

// En prod, el esquema ya tiene el DDL de agosto pero el historial no lo
// registra: se marca como applied, sin re-ejecutar.
const PROD_APLICADAS_SIN_REGISTRAR = [
  '20260804120000', '20260804175500', '20260805120200',
  '20260805130000', '20260805140000', '20260806120000',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const ejecutar = args.includes('--si');
const soloIdx = args.indexOf('--solo');
const solo = soloIdx >= 0 ? args[soloIdx + 1] : null; // 'prod' | 'staging' | null

if (!dryRun && !ejecutar) {
  console.error('Falta --dry-run (ver el plan) o --si (ejecutar). Abortando.');
  process.exit(1);
}

function dbUrl(ref, password) {
  return `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${HOST}:${PORT}/postgres`;
}
function ocultar(url) {
  return url.replace(/:([^:@/]+)@/, ':****@');
}

function correr(descripcion, argv) {
  console.log(`\n→ ${descripcion}`);
  const mostrado = argv.map((a) => (a.startsWith('postgresql://') ? ocultar(a) : a));
  console.log(`  npx ${mostrado.join(' ')}`);
  if (dryRun) {
    console.log('  (dry-run: no se ejecuta)');
    return true;
  }
  const res = spawnSync('npx', argv, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`  ✗ Falló (exit ${res.status}).`);
    return false;
  }
  console.log('  ✓ OK');
  return true;
}

function reqPassword(envName, nombre) {
  const pw = process.env[envName];
  if (!pw) {
    console.error(`Falta ${envName} (password de ${nombre}) en el entorno / .env.local. Abortando.`);
    process.exit(1);
  }
  return pw;
}

let ok = true;

// ---------- PROD ----------
if (!solo || solo === 'prod') {
  const url = dbUrl(PROD_REF, reqPassword('WAGY_DB_PASSWORD_PROD', 'PROD'));
  console.log('\n============== PROD ==============');
  ok = correr(
    'Marcar las 6 migraciones de agosto como APLICADAS (sin re-ejecutar SQL)',
    ['supabase', 'migration', 'repair', '--db-url', url, '--status', 'applied', ...PROD_APLICADAS_SIN_REGISTRAR],
  ) && ok;
}

// ---------- STAGING ----------
if (ok && (!solo || solo === 'staging')) {
  const url = dbUrl(STAGING_REF, reqPassword('WAGY_DB_PASSWORD_STAGING', 'STAGING'));
  console.log('\n============== STAGING ==============');
  ok = correr(
    `Baseline: marcar el prefijo <=0721 (${STAGING_BASELINE.length} migraciones) como APLICADO`,
    ['supabase', 'migration', 'repair', '--db-url', url, '--status', 'applied', ...STAGING_BASELINE],
  ) && ok;

  if (ok) {
    ok = correr(
      'db push: aplicar de VERDAD las 11 migraciones faltantes (0722 -> 0806)',
      ['supabase', 'db', 'push', '--db-url', url, '--yes'],
    ) && ok;
  }
}

if (!ok) {
  console.error('\n✗ Reconciliación incompleta — revisá el error de arriba.');
  process.exit(1);
}
console.log(`\n✔ ${dryRun ? 'Plan mostrado (dry-run).' : 'Reconciliación completa.'}`);

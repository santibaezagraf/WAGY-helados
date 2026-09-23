// Fuente ÚNICA de los dos proyectos Supabase del sistema.
//
// La comparten `db-push-todos.mjs` (aplicar migraciones) y `gen-types.mjs`
// (regenerar src/types/supabase.ts). Antes los refs estaban hardcodeados en cada
// script: duplicarlos es justo la clase de dato que se desincroniza y termina
// apuntando una herramienta a la base equivocada.

export const PROYECTOS = [
  {
    clave: 'prod',
    nombre: 'PRODUCCIÓN (WAGY helados)',
    ref: 'bhexbncbuieuxklegnjm',
    envPassword: 'WAGY_DB_PASSWORD_PROD',
  },
  {
    clave: 'staging',
    nombre: 'STAGING (wagy-helados-staging)',
    ref: 'oqrufwtuwvogdfhojips',
    envPassword: 'WAGY_DB_PASSWORD_STAGING',
  },
];

export const CLAVES = PROYECTOS.map((p) => p.clave);

/**
 * Lee `--solo=<clave>` de argv.
 * Devuelve la clave, o `null` si no vino el flag. Aborta con un mensaje claro si
 * la clave no existe (un typo silencioso acá apuntaría a la base equivocada).
 */
export function leerSolo(argv) {
  const arg = argv.find((a) => a.startsWith('--solo='));
  if (!arg) return null;

  const clave = arg.slice('--solo='.length);
  if (!CLAVES.includes(clave)) {
    console.error(`\n✗ --solo=${clave} no existe. Opciones: ${CLAVES.join(', ')}.`);
    process.exit(1);
  }
  return clave;
}

/** Proyecto por clave. Aborta si no existe. */
export function buscarProyecto(clave) {
  const proyecto = PROYECTOS.find((p) => p.clave === clave);
  if (!proyecto) {
    console.error(`\n✗ No existe el proyecto "${clave}". Opciones: ${CLAVES.join(', ')}.`);
    process.exit(1);
  }
  return proyecto;
}

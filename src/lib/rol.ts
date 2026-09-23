/**
 * Roles de usuario del dashboard y qué puede hacer cada uno.
 *
 * Módulo PURO a propósito: sin imports, sin I/O. Lo consumen tanto el servidor
 * (auth-rol.ts, proxy.ts, los server actions) como los componentes cliente, que
 * necesitan la misma tabla de permisos para ocultar lo que el rol no puede usar.
 * La lectura de la sesión (que sí es I/O) vive en auth-rol.ts.
 *
 * EL ROL VIVE EN `auth.users.raw_app_meta_data.rol`, no en `user_metadata`:
 * este último lo puede escribir el propio usuario desde el browser con
 * `supabase.auth.updateUser({ data: ... })` usando la anon key (que va en el
 * bundle), o sea sería auto-escalada de privilegios en una línea. `app_metadata`
 * solo se escribe con service-role.
 *
 * EL NOMBRE VISIBLE SALE DEL MAIL (`juan@wagy.local` -> `juan`), no de
 * app_metadata: el nombre ES el login, y tenerlo en dos lugares los deja
 * desincronizados apenas alguien se renombra desde /perfil.
 */

export type Rol = 'admin' | 'mensajero'

export const ROLES = ['admin', 'mensajero'] as const

/**
 * Dominio del mail sintético con el que se dan de alta los usuarios. El staff
 * se loguea escribiendo solo el nombre ("juan") y el formulario arma el mail.
 * NO es un dominio real y no recibe correo: cualquier flujo de Supabase que
 * dependa de mandar un mail de confirmación NO va a funcionar (por eso
 * actions/perfil.ts usa `auth.admin.updateUserById`, que lo aplica directo).
 */
export const DOMINIO_INTERNO = '@wagy.local'

/**
 * Fail-closed: solo el literal exacto 'admin' es admin. Cualquier otra cosa
 * (undefined, null, '', 'Admin', un rol futuro que este código no conoce)
 * cae a `mensajero`, que es el rol sin privilegios. Un usuario recién creado
 * al que se le olvidó poner el rol entra como mensajero, no como admin.
 */
export function normalizarRol(crudo: unknown): Rol {
    return crudo === 'admin' ? 'admin' : 'mensajero'
}

/** Rol de un usuario de Supabase; null si no hay sesión. */
export function rolDeUser(
    user: { app_metadata?: { rol?: unknown } | null } | null | undefined,
): Rol | null {
    if (!user) return null
    return normalizarRol(user.app_metadata?.rol)
}

export type Accion =
    // Lectura
    | 'pedidos.ver'
    | 'balances.ver'
    | 'modelos.ver'
    | 'chat.ver'
    | 'actividad.ver'
    // Escritura
    | 'pedidos.escribir'
    | 'envio.escribir'
    | 'gastos.escribir'
    | 'precios.escribir'
    | 'chat.escribir'
    | 'chat.moderar'
    | 'alertas.resolver'
    | 'perfil.editar'

/**
 * Tabla de permisos: la fuente ÚNICA que comparten la UI y los gates del
 * servidor. Sumar un tercer rol es editar datos acá, no agregar `if`s repartidos
 * por el código.
 *
 * El mensajero es de solo lectura EXCEPTO por `envio.escribir`: puede editar el
 * costo de envío de un pedido, y nada más. Como la RLS de Postgres no puede
 * restringir por columna, esa escritura no pasa por RLS sino por un server
 * action con cliente service-role explícitamente gateado (ver
 * `actualizarCostoEnvioPedido`).
 */
const PERMISOS: Record<Accion, readonly Rol[]> = {
    'pedidos.ver': ['admin', 'mensajero'],
    'envio.escribir': ['admin', 'mensajero'],
    'perfil.editar': ['admin', 'mensajero'],

    'balances.ver': ['admin'],
    'modelos.ver': ['admin'],
    'chat.ver': ['admin'],
    'actividad.ver': ['admin'],
    'pedidos.escribir': ['admin'],
    'gastos.escribir': ['admin'],
    'precios.escribir': ['admin'],
    'chat.escribir': ['admin'],
    'chat.moderar': ['admin'],
    'alertas.resolver': ['admin'],
}

/** Sin rol (sin sesión) no se puede nada. */
export function puede(rol: Rol | null | undefined, accion: Accion): boolean {
    if (!rol) return false
    return PERMISOS[accion].includes(rol)
}

/**
 * Rutas que exigen admin. `/perfil` NO está acá: entran los dos roles y el
 * contenido de adentro se gatea con `puede(rol, 'actividad.ver')`.
 */
const RUTAS_ADMIN = ['/balances', '/modelos', '/conversaciones']

/**
 * Mismo criterio de matcheo que `esRutaPublica` en proxy.ts: exacto o por
 * prefijo seguido de "/", así "/balances-falsos" NO matchea "/balances".
 */
export function rutaExigeAdmin(pathname: string): boolean {
    return RUTAS_ADMIN.some((ruta) => pathname === ruta || pathname.startsWith(ruta + '/'))
}

/**
 * Nombre de usuario -> mail con el que se autentica contra Supabase.
 * Si ya viene un mail (tiene "@") se respeta tal cual, para poder tener alguna
 * cuenta con mail real conviviendo con las internas.
 */
export function aMailInterno(nombre: string): string {
    const limpio = nombre.trim().toLowerCase()
    return limpio.includes('@') ? limpio : limpio + DOMINIO_INTERNO
}

/** Mail -> nombre visible ("juan@wagy.local" -> "juan"). */
export function nombreDeMail(mail: string | null | undefined): string {
    if (!mail) return ''
    const arroba = mail.indexOf('@')
    return (arroba === -1 ? mail : mail.slice(0, arroba)).toLowerCase()
}

export const NOMBRE_MIN = 3
export const NOMBRE_MAX = 30

/**
 * Valida un nombre de usuario. Devuelve el mensaje de error, o null si está OK.
 * Restrictivo a propósito: el nombre termina siendo la parte local de un mail.
 */
export function validarNombreUsuario(nombre: string): string | null {
    const limpio = nombre.trim().toLowerCase()
    if (limpio.length === 0) return 'Escribí un nombre de usuario.'
    if (limpio.length < NOMBRE_MIN) return `El nombre tiene que tener al menos ${NOMBRE_MIN} caracteres.`
    if (limpio.length > NOMBRE_MAX) return `El nombre no puede superar los ${NOMBRE_MAX} caracteres.`
    if (!/^[a-z0-9._-]+$/.test(limpio)) {
        return 'Usá solo letras, números, puntos, guiones y guiones bajos (sin espacios ni acentos).'
    }
    return null
}

export const PASSWORD_MIN = 8

/** Valida una contraseña nueva. Devuelve el mensaje de error, o null si está OK. */
export function validarPassword(password: string): string | null {
    if (password.length < PASSWORD_MIN) {
        return `La contraseña tiene que tener al menos ${PASSWORD_MIN} caracteres.`
    }
    return null
}

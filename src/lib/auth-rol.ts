import { createClient } from '@/lib/supabase-server'
import { normalizarRol, nombreDeMail, puede, type Accion, type Rol } from '@/lib/rol'

/**
 * Lectura de la sesión y gates de permiso para el servidor.
 *
 * La contraparte con I/O de rol.ts (que es puro y no puede importar
 * `next/headers`). Nombre calcado de auth-cron.ts, el otro gate del sistema.
 *
 * Reemplaza las cuatro copias locales e idénticas de `exigirUsuario()` que había
 * en actions/{mensajes,conversaciones,alertas-modelo,uso-modelo}.ts.
 *
 * SIEMPRE `auth.getUser()`, NUNCA `auth.getSession()`: getUser valida el token
 * contra Supabase y devuelve la fila real del usuario, así que el rol que se lee
 * acá está fresco (un cambio de rol pega en la request siguiente). getSession
 * lee la cookie sin validarla.
 */

export type Sesion = {
    userId: string
    rol: Rol
    /** Nombre visible, derivado del mail. Es lo que se guarda en la auditoría. */
    nombre: string
    /** Mail interno real, por si hace falta reautenticar (ver actions/perfil.ts). */
    mail: string
}

/** Sesión actual, o null si no hay. Para las páginas, que redirigen en vez de tirar. */
export async function sesionActual(): Promise<Sesion | null> {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null

    const mail = user.email ?? ''
    return {
        userId: user.id,
        rol: normalizarRol(user.app_metadata?.rol),
        nombre: nombreDeMail(mail),
        mail,
    }
}

/**
 * Exige sesión. Reemplazo directo de los viejos `exigirUsuario()` locales.
 * Los server actions son invocables por su cuenta (no alcanza con que la página
 * valide), así que cada uno tiene que gatear por las suyas.
 */
export async function exigirUsuario(): Promise<Sesion> {
    const sesion = await sesionActual()
    if (!sesion) throw new Error('No autenticado')
    return sesion
}

/**
 * Exige sesión Y permiso para la acción. Fail-closed vía `puede`: una acción que
 * el rol no tiene declarada explícitamente se rechaza.
 */
export async function exigirPermiso(accion: Accion): Promise<Sesion> {
    const sesion = await exigirUsuario()
    if (!puede(sesion.rol, accion)) throw new Error('No autorizado')
    return sesion
}

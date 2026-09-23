'use server'

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { exigirPermiso } from '@/lib/auth-rol'
import { aMailInterno, nombreDeMail, validarNombreUsuario, validarPassword } from '@/lib/rol'

/**
 * Acciones del perfil del usuario: cambiar su propio nombre y su contraseña.
 * Las pueden usar los dos roles, siempre sobre SU PROPIA cuenta — el id sale de
 * la sesión, nunca de un parámetro.
 *
 * Cliente admin sin sesión propia: escribe sobre auth.users con la API admin de
 * GoTrue. `persistSession: false` para que no intente guardar nada.
 */
const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
)

export type ResultadoPerfil = { ok: true } | { ok: false; error: string }

/**
 * Cambia el nombre del usuario, que es TAMBIÉN su login: se actualiza el mail
 * interno (`juan@wagy.local` -> `juancito@wagy.local`).
 *
 * Tres cosas que no son obvias y que hacen que esto funcione:
 *
 *  1. Escribe SOLO el mail, nunca `app_metadata`. Ahí vive el rol, y esta acción
 *     la puede llamar cualquiera sobre su propia cuenta: si aceptara metadata
 *     del cliente sería escalada de privilegios directa. Por eso el nombre sale
 *     del mail y no de metadata — acá no hay ningún campo que proteger.
 *  2. Usa `auth.admin.updateUserById`, NO `supabase.auth.updateUser`. Esta
 *     última dispara el flujo de confirmación por mail, y @wagy.local no existe
 *     ni recibe correo: el cambio quedaría pendiente para siempre.
 *  3. Después hay que volver a iniciar sesión: el JWT vigente lleva el mail
 *     viejo adentro. Lo indica `debeReloguear` en el resultado.
 */
export async function cambiarNombre(nuevoNombre: string): Promise<ResultadoPerfil> {
    const sesion = await exigirPermiso('perfil.editar')

    const errorValidacion = validarNombreUsuario(nuevoNombre)
    if (errorValidacion) return { ok: false, error: errorValidacion }

    const nuevoMail = aMailInterno(nuevoNombre)
    if (nuevoMail === sesion.mail) {
        return { ok: false, error: 'Ese ya es tu nombre de usuario.' }
    }

    // Chequeo previo solo para dar un mensaje lindo. La garantía real es el
    // índice único de auth.users, que atajamos abajo: entre este chequeo y la
    // escritura otro usuario podría tomar el nombre.
    const { data: listado } = await admin.auth.admin.listUsers({ perPage: 200 })
    const ocupado = listado?.users.some(
        (u) => u.id !== sesion.userId && (u.email ?? '').toLowerCase() === nuevoMail,
    )
    if (ocupado) return { ok: false, error: 'Ese nombre de usuario ya está en uso.' }

    const { error } = await admin.auth.admin.updateUserById(sesion.userId, { email: nuevoMail })

    if (error) {
        // El índice único de auth.users es la última palabra (carrera con el
        // chequeo de arriba).
        const yaExiste = /already|registered|duplicate|unique/i.test(error.message)
        return {
            ok: false,
            error: yaExiste
                ? 'Ese nombre de usuario ya está en uso.'
                : 'No se pudo cambiar el nombre. Probá de nuevo.',
        }
    }

    return { ok: true }
}

/**
 * Cambia la contraseña del usuario.
 *
 * Revalida la contraseña ACTUAL antes de escribir la nueva. Sin ese paso,
 * cualquiera que agarre un dispositivo con la sesión abierta (la tablet del
 * local) se queda con la cuenta sin haber sabido nunca la contraseña.
 */
export async function cambiarPassword(
    actual: string,
    nueva: string,
): Promise<ResultadoPerfil> {
    const sesion = await exigirPermiso('perfil.editar')

    const errorValidacion = validarPassword(nueva)
    if (errorValidacion) return { ok: false, error: errorValidacion }
    if (actual === nueva) return { ok: false, error: 'La contraseña nueva tiene que ser distinta.' }

    // Reautenticación con un cliente AISLADO, no con el de la sesión.
    //
    // `signInWithPassword` abre una sesión nueva: hecho con el cliente ligado a
    // cookies, rotaba la sesión del usuario como efecto colateral de una simple
    // verificación, y el render siguiente se encontraba con cookies desfasadas e
    // intentaba reescribirlas (lo que en un Server Component tira
    // "Cookies can only be modified in a Server Action or Route Handler").
    //
    // Con `persistSession: false` la verificación no toca ninguna cookie: solo
    // pregunta "¿esta contraseña es válida?" y descarta la sesión resultante.
    // Va con la ANON key, no la service-role: verificar credenciales es
    // justamente lo que la anon key puede hacer, y no queremos más privilegio
    // del necesario.
    const verificador = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } },
    )
    const { error: errorReauth } = await verificador.auth.signInWithPassword({
        email: sesion.mail,
        password: actual,
    })
    if (errorReauth) return { ok: false, error: 'La contraseña actual no es correcta.' }

    const { error } = await admin.auth.admin.updateUserById(sesion.userId, { password: nueva })
    if (error) return { ok: false, error: 'No se pudo cambiar la contraseña. Probá de nuevo.' }

    return { ok: true }
}

/** Datos que muestra la cabecera de /perfil. */
export async function getMiPerfil(): Promise<{ nombre: string; rol: string }> {
    const sesion = await exigirPermiso('perfil.editar')
    return { nombre: nombreDeMail(sesion.mail), rol: sesion.rol }
}

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase-server'

/**
 * Cierre de sesión.
 *
 * Es un ROUTE HANDLER y no un server action a propósito. Como server action con
 * `redirect('/login')` adentro, el cliente de Next reintentaba la acción contra
 * la ruta destino (se veía un `POST /login` en el log) y ahí ese action no está
 * registrado, así que la respuesta no era la que el runtime esperaba:
 * "An unexpected response was received from the server". Un POST → 303 común no
 * pasa por el protocolo de server actions y no tiene ese problema; además
 * funciona aunque el browser no tenga JS.
 */
export async function POST(req: NextRequest) {
    // Same-origin: sin esto, cualquier sitio podría desloguearte con un form
    // remoto. Es CSRF de bajo impacto (solo molesta), pero el chequeo es trivial.
    // Los server actions traen esta protección de fábrica; un route handler no.
    const origin = req.headers.get('origin')
    if (origin) {
        try {
            if (new URL(origin).host !== req.nextUrl.host) {
                return new NextResponse('Origen inválido', { status: 403 })
            }
        } catch {
            return new NextResponse('Origen inválido', { status: 403 })
        }
    }

    const supabase = await createClient()
    // Sin sesión es un no-op: igual mandamos al login, que es lo que se quiere.
    await supabase.auth.signOut()

    // 303 y NO el 307 que devuelve NextResponse.redirect por defecto: 307
    // preserva el método y el browser volvería a hacer POST contra /login.
    return NextResponse.redirect(new URL('/login', req.url), { status: 303 })
}

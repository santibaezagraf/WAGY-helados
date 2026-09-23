import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { normalizarRol, rutaExigeAdmin } from "@/lib/rol";

// Rutas accesibles SIN sesión. Todo lo demás exige usuario autenticado.
//  - /login: el propio formulario de acceso.
//  - /precios: landing pública (link en el perfil de WhatsApp Business).
//  - /auth/cerrar-sesion: el logout. Va acá para que, si la sesión YA venció, el
//    gate no intercepte el POST con un redirect 307 (que preserva el método y
//    terminaría posteando contra /login). Sin sesión el signOut es un no-op y
//    el handler te manda al login igual, que es lo que se quiere.
const RUTAS_PUBLICAS = ["/login", "/precios", "/auth/cerrar-sesion"];

function esRutaPublica(pathname: string): boolean {
    // Algunos endpoints /api/* no llevan sesión de usuario y se autentican por
    // otros medios (firma de Meta/QStash, CRON_SECRET). Solo esos deben evitar
    // el redirect a /login.
    const API_PUBLICAS = [
        "/api/webhook",
        "/api/procesar-pendientes",
        "/api/reenviar-resumenes",
        "/api/gestionar-borradores",
        // /api/dev/*: endpoints SOLO de desarrollo, ya bloqueados en producción por
        // su propia guarda NODE_ENV (devuelven 403). Se eximen del gate de sesión
        // para que el harness de testeo (next dev, sin cookie) pueda usarlos; en
        // prod siguen siendo inaccesibles.
        "/api/dev",
    ];
    if (API_PUBLICAS.some((ruta) => pathname === ruta || pathname.startsWith(ruta + "/"))) {
        return true;
    }
    return RUTAS_PUBLICAS.some(
        (ruta) => pathname === ruta || pathname.startsWith(ruta + "/"),
    );
}

export async function proxy(req: NextRequest) {
    let response = NextResponse.next({
        request: {
            headers: req.headers,
        }
    });

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {

                getAll() {
                    return req.cookies.getAll();
                },

                setAll(cookiesToSet) {

                    response = NextResponse.next({
                        request: {
                            headers: req.headers,
                        }
                    })
                    cookiesToSet.forEach(({ name, value, options }) => {
                        // const modifiedOptions = {
                        // ...options,
                        // maxAge: 60 * 60 * 8,
                        // expires: undefined,
                        // sameSite: 'lax' as const,
                        // path: '/',
                        // // httpOnly: true,
                        // }

                        req.cookies.set( name, value );
                        
                        response.cookies.set(name, value, options as CookieOptions);
                    })
                },

            }
        }   
    );

    const {
        data: { user },
    } = await supabase.auth.getUser();

    // Gate de autenticación: sin sesión y fuera de las rutas públicas → /login.
    // La página del dashboard también valida getUser() (defensa en profundidad),
    // pero acá cubrimos TODAS las rutas de una (p. ej. /balances es un client
    // component que no chequeaba sesión por su cuenta).
    if (!user && !esRutaPublica(req.nextUrl.pathname)) {
        const urlLogin = req.nextUrl.clone();
        urlLogin.pathname = "/login";
        return NextResponse.redirect(urlLogin);
    }

    // Gate de ROL: las rutas de admin (balances, modelos, conversaciones) no son
    // para el mensajero. Reusa el `user` que ya trajimos arriba, así que no
    // cuesta ninguna consulta extra. Las páginas vuelven a validar por su cuenta
    // (defensa en profundidad) y cada server action tiene su propio permiso: esto
    // es solo para que una URL escrita a mano no muestre una pantalla vacía.
    if (user && rutaExigeAdmin(req.nextUrl.pathname) && normalizarRol(user.app_metadata?.rol) !== "admin") {
        const urlInicio = req.nextUrl.clone();
        urlInicio.pathname = "/";
        urlInicio.search = "";
        return NextResponse.redirect(urlInicio);
    }

    return response;
}

export const config = {
    matcher: '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
}
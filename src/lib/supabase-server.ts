import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { Database } from "@/types/supabase";

export async function createClient () {
    const cookieStore = await cookies();

    return createServerClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) => {
                            cookieStore.set( name, value, options as CookieOptions );
                        });
                    } catch {
                        // En el RENDER de un Server Component las cookies son de
                        // solo lectura y `set` tira ("Cookies can only be modified
                        // in a Server Action or Route Handler").
                        //
                        // Se puede ignorar: este mismo cliente se usa desde páginas
                        // (donde solo leemos la sesión) y desde server actions
                        // (donde sí se puede escribir). Cuando el token hay que
                        // refrescarlo, el que lo hace y persiste la cookie nueva es
                        // el middleware de proxy.ts, que corre en CADA request antes
                        // del render. Sin este catch, cualquier render que caiga
                        // justo cuando el token necesita refresco revienta la página
                        // entera — es el patrón que recomienda @supabase/ssr.
                    }
                },
            }
        }   
    )
}
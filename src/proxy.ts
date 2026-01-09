import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

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

    await supabase.auth.getUser();

    return response;
}

export const config = {
    matcher: '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
}
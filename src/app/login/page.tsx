'use client'
import * as React from 'react'
import { createClient } from '@/lib/supabase-client'
import { useRouter } from 'next/navigation'
import { aMailInterno } from '@/lib/rol'

export default function Login() {
    const [usuario, setUsuario] = React.useState('')
    const [password, setPassword] = React.useState('')
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const router = useRouter()
    const supabase = createClient()

    const handleLogin = React.useCallback(async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        // El staff se loguea con su NOMBRE; el mail interno es un detalle de
        // implementación que nunca ve (aMailInterno le pega el dominio). Si
        // alguien escribe un mail con "@", se respeta tal cual.
        const { error: errorLogin } = await supabase.auth.signInWithPassword({
            email: aMailInterno(usuario),
            password,
        })

        if (errorLogin) {
            // No repetimos el mensaje de Supabase: habla de "email" y acá nadie
            // usa uno. Además no conviene distinguir "usuario inexistente" de
            // "contraseña incorrecta".
            setError('Usuario o contraseña incorrectos.')
        } else {
            router.push('/')
            router.refresh()
        }
        setLoading(false)
    }, [usuario, password, router, supabase])

    return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 text-black">
            <div className="w-full max-w-md space-y-8 rounded-lg bg-white p-8 shadow-md">
                <div>
                    <h1 className="text-3xl font-bold text-center">WAGY Helados</h1>
                    <p className="text-sm text-gray-600 text-center mt-2">Sistema de Gestión</p>
                </div>
                
                <form onSubmit={handleLogin} className="space-y-4">
                    <div>
                        <label htmlFor="usuario" className="block text-sm font-medium text-gray-700 mb-1">
                            Usuario
                        </label>
                        <input
                            id="usuario"
                            type="text"
                            autoComplete="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder="tu nombre"
                            value={usuario}
                            onChange={(e) => setUsuario(e.target.value)}
                            required
                            className="w-full rounded border border-gray-300 p-2 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                        />
                    </div>

                    <div>
                        <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                            Contraseña
                        </label>
                        <input
                            id="password"
                            type="password"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="w-full rounded border border-gray-300 p-2 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                        />
                    </div>
                    
                    {error && (
                        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
                            {error}
                        </p>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full rounded bg-blue-600 p-3 text-white font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                        {loading ? 'Iniciando sesión...' : 'Iniciar Sesión'}
                    </button>
                </form>
                
                <p className="text-xs text-gray-500 text-center">
                    Acceso solo para usuarios autorizados
                </p>
            </div>
        </div>
    )
}
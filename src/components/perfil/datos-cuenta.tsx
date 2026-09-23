"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UserRound, KeyRound } from "lucide-react"
import { cambiarNombre, cambiarPassword } from "@/lib/actions/perfil"
import { validarNombreUsuario, validarPassword } from "@/lib/rol"

/**
 * Los dos formularios del perfil: nombre de usuario y contraseña.
 * Los usan los DOS roles — es lo único que ve el mensajero en esta página.
 */
export function DatosCuenta({ nombreActual }: { nombreActual: string }) {
    return (
        <div className="grid gap-4 md:grid-cols-2">
            <FormNombre nombreActual={nombreActual} />
            <FormPassword />
        </div>
    )
}

type Estado = { tipo: "ok" | "error"; texto: string } | null

function Tarjeta({
    titulo,
    icono,
    children,
}: {
    titulo: string
    icono: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700">
                <span className="rounded-lg bg-gray-100 p-1.5 text-gray-700">{icono}</span>
                {titulo}
            </h2>
            {children}
        </section>
    )
}

function Aviso({ estado }: { estado: Estado }) {
    if (!estado) return null
    const ok = estado.tipo === "ok"
    return (
        <p
            role="alert"
            className={`mt-3 rounded border p-2 text-sm ${
                ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-red-200 bg-red-50 text-red-700"
            }`}
        >
            {estado.texto}
        </p>
    )
}

function FormNombre({ nombreActual }: { nombreActual: string }) {
    const [nombre, setNombre] = React.useState(nombreActual)
    const [estado, setEstado] = React.useState<Estado>(null)
    const [guardando, setGuardando] = React.useState(false)
    const router = useRouter()

    const enviar = async (e: React.FormEvent) => {
        e.preventDefault()
        setEstado(null)

        // Validación local para no ir y volver al servidor por un error obvio.
        // La del servidor igual corre: es la que vale.
        const errorLocal = validarNombreUsuario(nombre)
        if (errorLocal) return setEstado({ tipo: "error", texto: errorLocal })

        setGuardando(true)
        const r = await cambiarNombre(nombre)
        setGuardando(false)

        if (!r.ok) return setEstado({ tipo: "error", texto: r.error })
        setEstado({
            tipo: "ok",
            // El nombre ES el login y el JWT vigente lleva el viejo adentro:
            // hay que volver a entrar.
            texto: "Listo. Cerrá sesión y volvé a entrar con tu nombre nuevo.",
        })
        router.refresh()
    }

    return (
        <Tarjeta titulo="Nombre de usuario" icono={<UserRound className="h-4 w-4" />}>
            <form onSubmit={enviar} className="grid gap-3">
                <div className="grid gap-1.5">
                    <Label htmlFor="nombre">Tu nombre</Label>
                    <Input
                        id="nombre"
                        value={nombre}
                        onChange={(e) => setNombre(e.target.value)}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={guardando}
                        required
                    />
                    <p className="text-xs text-gray-500">
                        Es también con lo que iniciás sesión. Si lo cambiás, vas a tener que entrar
                        con el nuevo.
                    </p>
                </div>
                <Button
                    type="submit"
                    disabled={guardando || nombre.trim().toLowerCase() === nombreActual}
                    className="justify-self-start bg-cyan-600 text-white hover:bg-cyan-700"
                >
                    {guardando ? "Guardando..." : "Guardar nombre"}
                </Button>
                <Aviso estado={estado} />
            </form>
        </Tarjeta>
    )
}

function FormPassword() {
    const [actual, setActual] = React.useState("")
    const [nueva, setNueva] = React.useState("")
    const [repetir, setRepetir] = React.useState("")
    const [estado, setEstado] = React.useState<Estado>(null)
    const [guardando, setGuardando] = React.useState(false)

    const enviar = async (e: React.FormEvent) => {
        e.preventDefault()
        setEstado(null)

        if (nueva !== repetir) {
            return setEstado({ tipo: "error", texto: "Las contraseñas nuevas no coinciden." })
        }
        const errorLocal = validarPassword(nueva)
        if (errorLocal) return setEstado({ tipo: "error", texto: errorLocal })

        setGuardando(true)
        const r = await cambiarPassword(actual, nueva)
        setGuardando(false)

        if (!r.ok) return setEstado({ tipo: "error", texto: r.error })
        setActual("")
        setNueva("")
        setRepetir("")
        setEstado({ tipo: "ok", texto: "Contraseña actualizada." })
    }

    return (
        <Tarjeta titulo="Contraseña" icono={<KeyRound className="h-4 w-4" />}>
            <form onSubmit={enviar} className="grid gap-3">
                <div className="grid gap-1.5">
                    <Label htmlFor="actual">Contraseña actual</Label>
                    <Input
                        id="actual"
                        type="password"
                        autoComplete="current-password"
                        value={actual}
                        onChange={(e) => setActual(e.target.value)}
                        disabled={guardando}
                        required
                    />
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="nueva">Contraseña nueva</Label>
                    <Input
                        id="nueva"
                        type="password"
                        autoComplete="new-password"
                        value={nueva}
                        onChange={(e) => setNueva(e.target.value)}
                        disabled={guardando}
                        required
                    />
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="repetir">Repetir la nueva</Label>
                    <Input
                        id="repetir"
                        type="password"
                        autoComplete="new-password"
                        value={repetir}
                        onChange={(e) => setRepetir(e.target.value)}
                        disabled={guardando}
                        required
                    />
                </div>
                <Button
                    type="submit"
                    disabled={guardando || !actual || !nueva || !repetir}
                    className="justify-self-start bg-cyan-600 text-white hover:bg-cyan-700"
                >
                    {guardando ? "Guardando..." : "Cambiar contraseña"}
                </Button>
                <Aviso estado={estado} />
            </form>
        </Tarjeta>
    )
}

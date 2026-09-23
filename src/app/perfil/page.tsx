import { redirect } from 'next/navigation'
import { Header } from '@/components/ui/header'
import { sesionActual } from '@/lib/auth-rol'
import { puede } from '@/lib/rol'
import { inicioMesAR, sumarMesesAR, formatearFechaAR } from '@/lib/zona-horaria'
import { DatosCuenta } from '@/components/perfil/datos-cuenta'
import { PanelActividad } from '@/components/perfil/panel-actividad'
import {
    getActividadPorDia,
    getHistorialActividad,
    getRankingActividad,
    getUsuariosResumen,
} from '@/lib/actions/actividad'

/**
 * Perfil del usuario.
 *
 * Entran los dos roles, pero ven cosas distintas:
 *  - mensajero: solo su nombre y su contraseña.
 *  - admin: además el dashboard de actividad (ranking, heatmap, historial) y la
 *    última conexión de la mensajería.
 *
 * Por eso /perfil NO está en las rutas de admin del proxy: el gate fino es este.
 */
export default async function PerfilPage() {
    const sesion = await sesionActual()
    if (!sesion) redirect('/login')

    const verActividad = puede(sesion.rol, 'actividad.ver')

    return (
        <div className="flex min-h-screen flex-col bg-slate-50">
            <Header rol={sesion.rol} />
            <main className="mx-auto w-full max-w-5xl flex-1 px-3 py-4 sm:px-5">
                <h1 className="mb-1 text-xl font-bold text-gray-900">Mi perfil</h1>
                <p className="mb-4 text-sm text-gray-600">
                    Estás como <strong>{sesion.nombre}</strong>
                    {sesion.rol === 'mensajero' && ' (mensajería)'}.
                </p>

                <DatosCuenta nombreActual={sesion.nombre} />

                {verActividad && <ActividadDelMes />}
            </main>
        </div>
    )
}

/** El bloque de actividad: mes en curso para el ranking, 6 meses para el heatmap. */
async function ActividadDelMes() {
    const ahora = new Date()
    const desdeMes = inicioMesAR(ahora)
    const hastaMes = sumarMesesAR(desdeMes, 1)
    // El heatmap mira más atrás que el ranking (cubre las 26 semanas que dibuja).
    const desdeHeatmap = sumarMesesAR(desdeMes, -6)

    const [ranking, dias, historial, usuarios] = await Promise.all([
        getRankingActividad(desdeMes.toISOString(), hastaMes.toISOString()),
        getActividadPorDia(desdeHeatmap.toISOString(), hastaMes.toISOString()),
        getHistorialActividad(1),
        getUsuariosResumen(),
    ])

    const etiqueta = formatearFechaAR(desdeMes, { month: 'long', year: 'numeric' })

    return (
        <div className="mt-4">
            <PanelActividad
                ranking={ranking}
                dias={dias}
                historial={historial.items}
                usuarios={usuarios}
                etiquetaPeriodo={etiqueta}
            />
        </div>
    )
}

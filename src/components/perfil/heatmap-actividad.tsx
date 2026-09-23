import { fechaISOAR, formatearFechaAR } from "@/lib/zona-horaria"
import type { DiaActividad } from "@/lib/actions/actividad"

/**
 * Calendario de contribuciones estilo GitHub: un cuadradito por día, más oscuro
 * cuanto más actividad.
 *
 * Es una grilla CSS pura — no hace falta ninguna librería de gráficos (el
 * proyecto no tiene ninguna y no vale sumar una por esto).
 *
 * Los días vienen agrupados en calendario ARGENTINO desde la RPC: agrupar en UTC
 * correría un día toda la actividad hecha después de las 21:00 (el mismo bug que
 * motivó zona-horaria.ts).
 */

const SEMANAS = 26 // ~6 meses: entra cómodo y se lee bien en una pantalla
const DIAS_POR_SEMANA = 7

/** Los cinco niveles de intensidad, de vacío a máximo. */
function nivel(acciones: number, maximo: number): number {
    if (acciones <= 0) return 0
    if (maximo <= 1) return 4
    const proporcion = acciones / maximo
    if (proporcion > 0.75) return 4
    if (proporcion > 0.5) return 3
    if (proporcion > 0.25) return 2
    return 1
}

const COLORES = [
    "bg-slate-100",
    "bg-cyan-200",
    "bg-cyan-400",
    "bg-cyan-600",
    "bg-cyan-800",
]

export function HeatmapActividad({ dias }: { dias: DiaActividad[] }) {
    const porDia = new Map(dias.map((d) => [d.dia, d.acciones]))
    const maximo = dias.reduce((m, d) => Math.max(m, d.acciones), 0)

    // Construimos hacia atrás desde hoy (AR) para que la última columna sea la
    // semana en curso, igual que GitHub.
    const hoy = new Date()
    const total = SEMANAS * DIAS_POR_SEMANA
    const celdas: { clave: string; acciones: number }[] = []
    for (let i = total - 1; i >= 0; i--) {
        const fecha = new Date(hoy.getTime() - i * 24 * 60 * 60 * 1000)
        const clave = fechaISOAR(fecha)
        celdas.push({ clave, acciones: porDia.get(clave) ?? 0 })
    }

    return (
        <div className="overflow-x-auto">
            <div
                className="grid grid-flow-col gap-1"
                style={{ gridTemplateRows: `repeat(${DIAS_POR_SEMANA}, minmax(0, 1fr))` }}
            >
                {celdas.map((celda) => (
                    <div
                        key={celda.clave}
                        title={`${formatearFechaAR(new Date(celda.clave + "T12:00:00Z"), {
                            day: "numeric",
                            month: "long",
                        })}: ${celda.acciones} ${celda.acciones === 1 ? "acción" : "acciones"}`}
                        className={`h-3 w-3 rounded-[2px] ${COLORES[nivel(celda.acciones, maximo)]}`}
                    />
                ))}
            </div>
            <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-gray-500">
                <span>Menos</span>
                {COLORES.map((color) => (
                    <span key={color} className={`h-3 w-3 rounded-[2px] ${color}`} />
                ))}
                <span>Más</span>
            </div>
        </div>
    )
}

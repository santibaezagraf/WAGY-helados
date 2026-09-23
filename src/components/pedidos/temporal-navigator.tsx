"use client"

import * as React from "react"
import { Button } from "../ui/button"
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react"
import {
    type Periodo,
    parseAncla,
    formatAncla,
    desplazarAncla,
    puedeAvanzar,
    etiquetaPeriodo,
} from "@/lib/periodo-utils"

interface TemporalNavigatorProps {
    periodo: Periodo
    /** ancla en formato `YYYY-MM-DD`; '' = hoy */
    ancla: string
    /** Cambiar período resetea el ancla a hoy; navegar solo cambia el ancla. */
    onChange: (periodo: Periodo, ancla: string) => void
    /** Última fecha de entrega cargada (ISO). Marca hasta dónde se puede avanzar:
     *  con pedidos programados el futuro ya no está vacío. null = solo hasta hoy. */
    maxFechaEntregaISO?: string | null
}

const PERIODOS: { value: Periodo; label: string; labelCorto: string }[] = [
    { value: 'dia', label: 'Día', labelCorto: 'Día' },
    { value: 'semana', label: 'Semana', labelCorto: 'Sem' },
    { value: 'mes', label: 'Mes', labelCorto: 'Mes' },
    { value: 'todos', label: 'Todos', labelCorto: 'Todo' },
]

export const TemporalNavigator = React.memo(function TemporalNavigator({
    periodo,
    ancla,
    onChange,
    maxFechaEntregaISO = null,
}: TemporalNavigatorProps) {
    // `new Date()` en render del cliente: el navegador refleja "ahora" del usuario.
    const fecha = parseAncla(ancla)
    const etiqueta = etiquetaPeriodo(periodo, fecha)

    const maxEntrega = React.useMemo(() => {
        if (!maxFechaEntregaISO) return null
        const d = new Date(maxFechaEntregaISO)
        return Number.isNaN(d.getTime()) ? null : d
    }, [maxFechaEntregaISO])

    // El tope ya no es "el período actual": con pedidos programados hay que poder
    // llegar hasta el último que haya cargado. Ver `puedeAvanzar`.
    const haySiguiente = puedeAvanzar(periodo, fecha, maxEntrega)

    const navegar = (dir: -1 | 1) => {
        if (dir === 1 && !haySiguiente) return
        onChange(periodo, formatAncla(desplazarAncla(periodo, fecha, dir)))
    }

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-0.5 rounded-md border bg-background p-0.5">
                {PERIODOS.map(({ value, label, labelCorto }) => (
                    <Button
                        key={value}
                        size="sm"
                        variant={periodo === value ? 'default' : 'ghost'}
                        // Cambiar de período vuelve a hoy (ancla vacía).
                        onClick={() => onChange(value, '')}
                        className="h-7 px-2.5 text-xs"
                    >
                        {value === 'dia' && <Calendar className="h-3 w-3" />}
                        <span className="hidden sm:inline">{label}</span>
                        <span className="sm:hidden">{labelCorto}</span>
                    </Button>
                ))}
            </div>

            {periodo !== 'todos' && (
                <div className="flex items-center gap-0.5">
                    <Button
                        size="icon-sm"
                        variant="outline"
                        onClick={() => navegar(-1)}
                        aria-label="Período anterior"
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="min-w-[7.5rem] text-center text-xs font-medium text-foreground sm:text-sm">
                        {etiqueta}
                    </span>
                    <Button
                        size="icon-sm"
                        variant="outline"
                        onClick={() => navegar(1)}
                        disabled={!haySiguiente}
                        aria-label="Período siguiente"
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            )}
        </div>
    )
})

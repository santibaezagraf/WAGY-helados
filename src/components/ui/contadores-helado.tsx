import { IceCream, Truck, Clock } from "lucide-react"
import type { ContadoresHelados } from "@/lib/data/pedidos-listado"

/**
 * Los tres contadores de helados del header: totales, entregados y los que
 * faltan entregar, sobre el período y los filtros que muestra la tabla.
 *
 * Deliberadamente chico: el `MetricTile` de /balances (p-4, valor text-xl) es
 * un tile de dashboard y no entra en una barra que ya tiene cuatro botones.
 * `tabular-nums` para que los números no bailen al cambiar de período.
 */
export function ContadoresHelado({ total, entregados, faltan }: ContadoresHelados) {
    return (
        <div className="flex items-center gap-1.5 sm:gap-2">
            <Contador icono={<IceCream className="h-3.5 w-3.5" />} valor={total} etiqueta="Totales" />
            <Contador icono={<Truck className="h-3.5 w-3.5" />} valor={entregados} etiqueta="Entregados" />
            <Contador icono={<Clock className="h-3.5 w-3.5" />} valor={faltan} etiqueta="Faltan" />
        </div>
    )
}

function Contador({
    icono,
    valor,
    etiqueta,
}: {
    icono: React.ReactNode
    valor: number
    etiqueta: string
}) {
    return (
        <div
            // El título da el significado completo donde el label no entra (mobile).
            title={`${etiqueta}: ${valor} helados`}
            className="flex items-center gap-1 rounded-md bg-cyan-700/40 px-2 py-1 text-white"
        >
            <span className="shrink-0 opacity-90">{icono}</span>
            <span className="text-sm font-semibold tabular-nums leading-none">{valor}</span>
            {/* Igual que los botones de al lado: el texto se cae en pantallas chicas. */}
            <span className="hidden text-[11px] uppercase tracking-wide opacity-90 lg:inline">
                {etiqueta}
            </span>
        </div>
    )
}

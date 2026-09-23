import { Trophy, History, Bike } from "lucide-react"
import { formatearFechaAR, formatearHoraAR } from "@/lib/zona-horaria"
import { HeatmapActividad } from "@/components/perfil/heatmap-actividad"
import type {
    DiaActividad,
    EntradaHistorial,
    FilaRanking,
    UsuarioResumen,
} from "@/lib/actions/actividad"

/**
 * Dashboard de actividad de /perfil — SOLO admin.
 *
 * Del mensajero se muestra únicamente la última conexión: no participa del
 * ranking ni del historial porque sus únicas acciones posibles son mirar y tocar
 * el costo de envío.
 */
export function PanelActividad({
    ranking,
    dias,
    historial,
    usuarios,
    etiquetaPeriodo,
}: {
    ranking: FilaRanking[]
    dias: DiaActividad[]
    historial: EntradaHistorial[]
    usuarios: UsuarioResumen[]
    etiquetaPeriodo: string
}) {
    const mensajeros = usuarios.filter((u) => u.rol === "mensajero")

    return (
        <div className="grid gap-4">
            <Seccion titulo={`Ranking · ${etiquetaPeriodo}`} icono={<Trophy className="h-4 w-4" />}>
                {ranking.length === 0 ? (
                    <Vacio>Todavía no hay actividad registrada en este período.</Vacio>
                ) : (
                    <ol className="grid gap-2">
                        {ranking.map((fila, i) => (
                            <li key={fila.usuarioId} className="grid gap-1">
                                <div className="flex items-baseline justify-between gap-2 text-sm">
                                    <span className="truncate font-medium text-gray-800">
                                        {i === 0 && "🥇 "}
                                        {i === 1 && "🥈 "}
                                        {i === 2 && "🥉 "}
                                        {fila.nombre}
                                    </span>
                                    <span className="shrink-0 tabular-nums text-gray-600">
                                        {fila.porcentaje}% ·{" "}
                                        <strong className="text-gray-900">{fila.acciones}</strong>{" "}
                                        {fila.acciones === 1 ? "acción" : "acciones"}
                                    </span>
                                </div>
                                {/* Barra en CSS puro, sin librería de gráficos. */}
                                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                                    <div
                                        className="h-full rounded-full bg-cyan-600"
                                        style={{ width: `${fila.porcentaje}%` }}
                                    />
                                </div>
                                <p className="text-[11px] text-gray-500">
                                    {fila.pedidosTocados} {fila.pedidosTocados === 1 ? "pedido" : "pedidos"} tocados
                                </p>
                            </li>
                        ))}
                    </ol>
                )}
                <p className="mt-3 text-[11px] text-gray-500">
                    Una acción masiva (marcar varios pedidos de una) cuenta como <strong>una</strong>{" "}
                    acción; los pedidos tocados van aparte.
                </p>
            </Seccion>

            <Seccion titulo="Actividad de los últimos meses" icono={<History className="h-4 w-4" />}>
                <HeatmapActividad dias={dias} />
            </Seccion>

            {mensajeros.length > 0 && (
                <Seccion titulo="Mensajería" icono={<Bike className="h-4 w-4" />}>
                    <ul className="grid gap-2">
                        {mensajeros.map((m) => (
                            <li
                                key={m.id}
                                className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm"
                            >
                                <span className="font-medium text-gray-800">{m.nombre}</span>
                                <span className="text-xs text-gray-500">
                                    {m.ultimaConexion
                                        ? `Última conexión: ${fechaHora(m.ultimaConexion)}`
                                        : "Nunca se conectó"}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Seccion>
            )}

            <Seccion titulo="Últimas actividades" icono={<History className="h-4 w-4" />}>
                {historial.length === 0 ? (
                    <Vacio>Todavía no hay nada registrado.</Vacio>
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {historial.map((e) => (
                            <li key={e.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                                <span className="min-w-0">
                                    <strong className="font-medium text-gray-800">{e.nombre}</strong>{" "}
                                    <span className="text-gray-600">{e.texto}</span>
                                </span>
                                <span className="shrink-0 text-[11px] tabular-nums text-gray-500">
                                    {fechaHora(e.createdAt)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Seccion>
        </div>
    )
}

function fechaHora(iso: string): string {
    const d = new Date(iso)
    return `${formatearFechaAR(d, { day: "numeric", month: "short" })} ${formatearHoraAR(d)}`
}

function Seccion({
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

function Vacio({ children }: { children: React.ReactNode }) {
    return <p className="py-4 text-center text-sm text-gray-500">{children}</p>
}

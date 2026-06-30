/**
 * Utilidades de período temporal para el navegador del listado.
 *
 * El listado se filtra por un período (`dia`/`semana`/`mes`/`todos`) anclado en
 * una fecha (`ancla`). El navegador permite moverse hacia atrás/adelante de a un
 * período, con tope en el período actual (nunca hay pedidos a futuro).
 *
 * Todo se calcula en hora local — igual que el resto del dashboard — para que el
 * borde del día/semana/mes coincida con lo que ve el staff. Las mismas funciones
 * corren en el servidor (resolver desde/hasta a ISO) y en el cliente (etiqueta,
 * tope y navegación), así ambos lados coinciden.
 */

export type Periodo = 'dia' | 'semana' | 'mes' | 'todos'

/** ISO de día (`YYYY-MM-DD`) → Date a medianoche local. Vacío/invalido → hoy. */
export function parseAncla(ancla: string | null | undefined, ahora: Date = new Date()): Date {
    if (ancla) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ancla)
        if (m) {
            const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
            d.setHours(0, 0, 0, 0)
            return d
        }
    }
    const d = new Date(ahora)
    d.setHours(0, 0, 0, 0)
    return d
}

/** Date → `YYYY-MM-DD` en hora local (para guardar en la URL). */
export function formatAncla(fecha: Date): string {
    const y = fecha.getFullYear()
    const m = String(fecha.getMonth() + 1).padStart(2, '0')
    const d = String(fecha.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/** Inicio (inclusivo) del período que contiene `fecha`. */
export function inicioPeriodo(periodo: Periodo, fecha: Date): Date {
    const d = new Date(fecha)
    d.setHours(0, 0, 0, 0)
    if (periodo === 'semana') {
        d.setDate(d.getDate() - d.getDay()) // domingo como inicio de semana
    } else if (periodo === 'mes') {
        return new Date(d.getFullYear(), d.getMonth(), 1)
    }
    return d
}

/** Fin (exclusivo) del período que contiene `fecha` = inicio del siguiente. */
export function finPeriodo(periodo: Periodo, fecha: Date): Date {
    const ini = inicioPeriodo(periodo, fecha)
    const f = new Date(ini)
    if (periodo === 'dia') f.setDate(f.getDate() + 1)
    else if (periodo === 'semana') f.setDate(f.getDate() + 7)
    else if (periodo === 'mes') f.setMonth(f.getMonth() + 1)
    return f
}

/** Corre el ancla un período hacia atrás (dir=-1) o adelante (dir=1). */
export function desplazarAncla(periodo: Periodo, fecha: Date, dir: -1 | 1): Date {
    const d = new Date(fecha)
    if (periodo === 'dia') d.setDate(d.getDate() + dir)
    else if (periodo === 'semana') d.setDate(d.getDate() + 7 * dir)
    else if (periodo === 'mes') d.setMonth(d.getMonth() + dir)
    return d
}

/** True si el período anclado en `fecha` contiene a `ahora` (es el período actual). */
export function esPeriodoActual(periodo: Periodo, fecha: Date, ahora: Date = new Date()): boolean {
    if (periodo === 'todos') return true
    return ahora >= inicioPeriodo(periodo, fecha) && ahora < finPeriodo(periodo, fecha)
}

/** Etiqueta legible del período anclado en `fecha` ("Hoy", "29 jun – 5 jul", "junio 2026"…). */
export function etiquetaPeriodo(periodo: Periodo, fecha: Date, ahora: Date = new Date()): string {
    if (periodo === 'todos') return 'Todos'

    const ini = inicioPeriodo(periodo, fecha)

    if (periodo === 'dia') {
        if (esPeriodoActual('dia', fecha, ahora)) return 'Hoy'
        const ayer = new Date(ahora)
        ayer.setHours(0, 0, 0, 0)
        ayer.setDate(ayer.getDate() - 1)
        if (ini.getTime() === ayer.getTime()) return 'Ayer'
        const mismoAnio = ini.getFullYear() === ahora.getFullYear()
        return ini.toLocaleDateString('es-AR', {
            day: 'numeric',
            month: 'short',
            ...(mismoAnio ? {} : { year: 'numeric' }),
        })
    }

    if (periodo === 'semana') {
        if (esPeriodoActual('semana', fecha, ahora)) return 'Esta semana'
        const finIncl = finPeriodo('semana', fecha)
        finIncl.setDate(finIncl.getDate() - 1)
        const opts = { day: 'numeric', month: 'short' } as const
        return `${ini.toLocaleDateString('es-AR', opts)} – ${finIncl.toLocaleDateString('es-AR', opts)}`
    }

    // mes
    if (esPeriodoActual('mes', fecha, ahora)) return 'Este mes'
    return ini.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })
}

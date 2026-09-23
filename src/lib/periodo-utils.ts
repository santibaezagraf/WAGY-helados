/**
 * Utilidades de período temporal para el navegador del listado.
 *
 * El listado se filtra por un período (`dia`/`semana`/`mes`/`todos`) anclado en
 * una fecha (`ancla`). El navegador permite moverse hacia atrás/adelante de a un
 * período, con tope en el período actual (nunca hay pedidos a futuro).
 *
 * Todo el calendario se calcula en la zona horaria de Argentina (vía `zona-horaria`),
 * NO en la hora local del runtime. Las mismas funciones corren en el servidor
 * (resolver desde/hasta a ISO en `page.tsx`) y en el cliente (etiqueta, tope y
 * navegación), y ahora ambos lados coinciden aunque el servidor esté en UTC.
 */

import {
    partesAR,
    instanteAR,
    inicioDelDiaAR,
    inicioSemanaAR,
    inicioMesAR,
    sumarDiasAR,
    sumarMesesAR,
    claveDiaAR,
    fechaISOAR,
    formatearFechaAR,
} from './zona-horaria'

export type Periodo = 'dia' | 'semana' | 'mes' | 'todos'

/** ISO de día (`YYYY-MM-DD`) → Date a medianoche AR. Vacío/invalido → hoy (AR). */
export function parseAncla(ancla: string | null | undefined, ahora: Date = new Date()): Date {
    if (ancla) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ancla)
        if (m) {
            return instanteAR(Number(m[1]), Number(m[2]), Number(m[3]))
        }
    }
    return inicioDelDiaAR(ahora)
}

/** Date → `YYYY-MM-DD` en hora AR (para guardar en la URL). */
export function formatAncla(fecha: Date): string {
    return fechaISOAR(fecha)
}

/** Inicio (inclusivo) del período que contiene `fecha`, en calendario AR. */
export function inicioPeriodo(periodo: Periodo, fecha: Date): Date {
    if (periodo === 'semana') return inicioSemanaAR(fecha)
    if (periodo === 'mes') return inicioMesAR(fecha)
    return inicioDelDiaAR(fecha)
}

/** Fin (exclusivo) del período que contiene `fecha` = inicio del siguiente. */
export function finPeriodo(periodo: Periodo, fecha: Date): Date {
    const ini = inicioPeriodo(periodo, fecha)
    if (periodo === 'dia') return sumarDiasAR(ini, 1)
    if (periodo === 'semana') return sumarDiasAR(ini, 7)
    if (periodo === 'mes') return sumarMesesAR(ini, 1)
    return ini
}

/** Corre el ancla un período hacia atrás (dir=-1) o adelante (dir=1), en calendario AR. */
export function desplazarAncla(periodo: Periodo, fecha: Date, dir: -1 | 1): Date {
    if (periodo === 'dia') return sumarDiasAR(fecha, dir)
    if (periodo === 'semana') return sumarDiasAR(fecha, 7 * dir)
    if (periodo === 'mes') return sumarMesesAR(fecha, dir)
    return fecha
}

/** True si el período anclado en `fecha` contiene a `ahora` (es el período actual). */
export function esPeriodoActual(periodo: Periodo, fecha: Date, ahora: Date = new Date()): boolean {
    if (periodo === 'todos') return true
    return ahora >= inicioPeriodo(periodo, fecha) && ahora < finPeriodo(periodo, fecha)
}

/**
 * ¿Se puede avanzar al período siguiente?
 *
 * Antes la flecha se apagaba en el período actual, con el supuesto de que "no
 * hay pedidos a futuro". Con los pedidos programados eso dejó de ser cierto: si
 * hay uno para la semana que viene, tiene que poder llegarse a esa semana.
 *
 * El tope es el MÁS TARDÍO entre ahora y la última fecha de entrega cargada, así
 * que al período actual siempre se puede volver aunque no haya nada programado.
 *
 * `finPeriodo` es el fin EXCLUSIVO, o sea el arranque del período siguiente: si
 * el tope lo alcanza, el período siguiente tiene algo (o es el actual). Esto hace
 * que la comparación funcione igual para día, semana y mes sin casos especiales
 * — un pedido para el martes que viene habilita "semana siguiente" completa, no
 * solo ese día.
 */
export function puedeAvanzar(
    periodo: Periodo,
    fecha: Date,
    maxFechaEntrega: Date | null,
    ahora: Date = new Date(),
): boolean {
    if (periodo === 'todos') return false
    const tope = maxFechaEntrega && maxFechaEntrega > ahora ? maxFechaEntrega : ahora
    return finPeriodo(periodo, fecha) <= tope
}

/** Etiqueta legible del período anclado en `fecha` ("Hoy", "29 jun – 5 jul", "junio 2026"…). */
export function etiquetaPeriodo(periodo: Periodo, fecha: Date, ahora: Date = new Date()): string {
    if (periodo === 'todos') return 'Todos'

    const ini = inicioPeriodo(periodo, fecha)

    if (periodo === 'dia') {
        if (esPeriodoActual('dia', fecha, ahora)) return 'Hoy'
        const ayer = sumarDiasAR(inicioDelDiaAR(ahora), -1)
        if (claveDiaAR(ini) === claveDiaAR(ayer)) return 'Ayer'
        const mismoAnio = partesAR(ini).anio === partesAR(ahora).anio
        return formatearFechaAR(ini, {
            day: 'numeric',
            month: 'short',
            ...(mismoAnio ? {} : { year: 'numeric' }),
        })
    }

    if (periodo === 'semana') {
        if (esPeriodoActual('semana', fecha, ahora)) return 'Esta semana'
        const finIncl = sumarDiasAR(finPeriodo('semana', fecha), -1)
        const opts = { day: 'numeric', month: 'short' } as const
        return `${formatearFechaAR(ini, opts)} – ${formatearFechaAR(finIncl, opts)}`
    }

    // mes
    if (esPeriodoActual('mes', fecha, ahora)) return 'Este mes'
    return formatearFechaAR(ini, { month: 'long', year: 'numeric' })
}

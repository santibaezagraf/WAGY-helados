/**
 * Capa única de zona horaria: TODO el cálculo y formateo de CALENDARIO del sistema
 * (bordes de día/semana/mes, "mismo día", "Hoy/Ayer", fechas/horas visibles) pasa
 * por acá y se resuelve en la hora de Argentina — sin importar dónde corra el código.
 *
 * Por qué existe: el runtime del servidor (Vercel) es UTC, así que `new Date()` +
 * `getHours/getDate/setHours` calculaban el "día" a medianoche UTC = 21:00 AR. Un
 * pedido de las 22:00 AR caía en el día calendario siguiente, y el listado (servidor)
 * y los balances (navegador) podían asignar el mismo pedido a días distintos.
 *
 * NO cubre la lógica RELATIVA (diffs de ms: debounce, rate-limit, ventanas de toma
 * humana / 12h / 24h de Meta, etc.): esos son instantes y ya son inmunes al huso.
 *
 * Implementación sin dependencias: `Intl.DateTimeFormat` con `timeZone` resuelve el
 * offset real del huso (hoy AR es UTC-3 fijo, pero esto sigue siendo correcto si
 * alguna vez se reinstaura el horario de verano).
 */

export const TZ_ARGENTINA = 'America/Argentina/Buenos_Aires'

/** Partes del reloj de pared en Argentina para un instante dado. */
export interface PartesAR {
    anio: number
    mes: number // 1-12
    dia: number // 1-31
    hora: number // 0-23
    min: number
    seg: number
    diaSemana: number // 0=domingo … 6=sábado (igual criterio que Date.getDay)
}

// en-CA + hour12:false da campos numéricos estables (YYYY-MM-DD, 00-23).
const FORMATO_PARTES = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_ARGENTINA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
})

/** Descompone un instante en su reloj de pared de Argentina. */
export function partesAR(fecha: Date): PartesAR {
    const partes = FORMATO_PARTES.formatToParts(fecha)
    const leer = (tipo: string) => Number(partes.find((p) => p.type === tipo)!.value)
    const anio = leer('year')
    const mes = leer('month')
    const dia = leer('day')
    // Algunos motores devuelven "24" para la medianoche con hour12:false.
    const hora = leer('hour') % 24
    const min = leer('minute')
    const seg = leer('second')
    // El día de la semana de una fecha calendario es el mismo en cualquier huso.
    const diaSemana = new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay()
    return { anio, mes, dia, hora, min, seg, diaSemana }
}

/** Offset del huso AR en ms para ese instante (negativo: AR está detrás de UTC). */
function offsetARms(fecha: Date): number {
    const p = partesAR(fecha)
    const comoUTC = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.min, p.seg)
    // Redondeo al minuto: cancela los ms y evita ruido de segundos.
    return Math.round((comoUTC - fecha.getTime()) / 60000) * 60000
}

/**
 * Instante (UTC) cuyo reloj de pared en Argentina es exactamente la fecha/hora dada.
 * Los campos overflow se normalizan como en `Date.UTC` (día 32 → mes siguiente, etc.),
 * lo que permite usarlo para aritmética de calendario (sumar/restar días o meses).
 */
export function instanteAR(
    anio: number,
    mes: number, // 1-12
    dia: number,
    hora = 0,
    min = 0,
    seg = 0,
    ms = 0,
): Date {
    const tentativa = Date.UTC(anio, mes - 1, dia, hora, min, seg, ms)
    const off = offsetARms(new Date(tentativa))
    return new Date(tentativa - off)
}

/** 00:00:00.000 AR del día que contiene `fecha` (inicio inclusivo). */
export function inicioDelDiaAR(fecha: Date): Date {
    const p = partesAR(fecha)
    return instanteAR(p.anio, p.mes, p.dia, 0, 0, 0, 0)
}

/** 23:59:59.999 AR del día que contiene `fecha` (fin inclusivo). */
export function finDelDiaAR(fecha: Date): Date {
    const p = partesAR(fecha)
    return instanteAR(p.anio, p.mes, p.dia, 23, 59, 59, 999)
}

/** 00:00 AR del día siguiente (fin EXCLUSIVo, para filtros medio-abiertos). */
export function inicioDiaSiguienteAR(fecha: Date): Date {
    const p = partesAR(fecha)
    return instanteAR(p.anio, p.mes, p.dia + 1, 0, 0, 0, 0)
}

/** 00:00 AR del domingo que abre la semana que contiene `fecha`. */
export function inicioSemanaAR(fecha: Date): Date {
    const p = partesAR(fecha)
    return instanteAR(p.anio, p.mes, p.dia - p.diaSemana, 0, 0, 0, 0)
}

/** 00:00 AR del primer día del mes que contiene `fecha`. */
export function inicioMesAR(fecha: Date): Date {
    const p = partesAR(fecha)
    return instanteAR(p.anio, p.mes, 1, 0, 0, 0, 0)
}

/** Suma `n` días de calendario AR (puede ser negativo), preservando la hora de pared. */
export function sumarDiasAR(fecha: Date, n: number): Date {
    const p = partesAR(fecha)
    return instanteAR(p.anio, p.mes, p.dia + n, p.hora, p.min, p.seg)
}

/** Suma `n` meses de calendario AR (puede ser negativo), preservando día/hora de pared. */
export function sumarMesesAR(fecha: Date, n: number): Date {
    const p = partesAR(fecha)
    return instanteAR(p.anio, p.mes + n, p.dia, p.hora, p.min, p.seg)
}

/** Clave comparable del día AR: anio*10000 + mes*100 + dia. `===` ⇒ mismo día AR. */
export function claveDiaAR(fecha: Date): number {
    const p = partesAR(fecha)
    return p.anio * 10000 + p.mes * 100 + p.dia
}

/** `YYYY-MM-DD` del día AR (para URLs, `<input type="date">`, etc.). */
export function fechaISOAR(fecha: Date): string {
    const p = partesAR(fecha)
    return `${p.anio}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`
}

/** Formatea la fecha visible en es-AR con el huso de Argentina siempre forzado. */
export function formatearFechaAR(fecha: Date, opts: Intl.DateTimeFormatOptions): string {
    return fecha.toLocaleDateString('es-AR', { timeZone: TZ_ARGENTINA, ...opts })
}

/** Formatea la hora visible (HH:mm por defecto) en es-AR con el huso de Argentina. */
export function formatearHoraAR(fecha: Date, opts?: Intl.DateTimeFormatOptions): string {
    return fecha.toLocaleTimeString('es-AR', {
        timeZone: TZ_ARGENTINA,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        ...opts,
    })
}

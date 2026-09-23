import { claveDiaAR, fechaISOAR, inicioDelDiaAR, instanteAR, sumarMesesAR } from '@/lib/zona-horaria'

/**
 * Pedidos programados: cargar hoy un pedido para entregar otro día.
 *
 * `pedidos.fecha_entrega` es CUÁNDO hay que entregarlo; `created_at` es cuándo
 * se cargó. Si no se especifica, la DB le pone `now()` — o sea, un pedido normal
 * tiene fecha_entrega ≈ created_at y todo se comporta como antes.
 *
 * El listado, los contadores del header y los balances bucketean por
 * `fecha_entrega`, no por `created_at`: al abrir el día de mañana querés ver lo
 * que hay que repartir mañana. Para los pedidos que ya existían la migración
 * copió `created_at`, así que los números históricos no cambian.
 *
 * Módulo PURO (solo calendario AR, sin I/O) para poder testearlo.
 */

/** Tope de anticipación. Más allá de un mes no tiene sentido comprometerse. */
export const MAX_MESES_PROGRAMACION = 1

/**
 * Valida la fecha de entrega elegida en el modal (`YYYY-MM-DD` de un
 * `<input type="date">`). Devuelve el mensaje de error, o null si está OK.
 *
 * Se compara por DÍA ARGENTINO y no por instante: si no, un pedido cargado a las
 * 22:00 AR (ya día siguiente en UTC) vería "hoy" como pasado y se rechazaría
 * solo. Es el mismo bug que motivó zona-horaria.ts.
 */
export function validarFechaEntrega(iso: string, ahora: Date = new Date()): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    if (!m) return 'Elegí una fecha de entrega válida.'

    const elegida = instanteAR(Number(m[1]), Number(m[2]), Number(m[3]))
    const claveElegida = claveDiaAR(elegida)
    const claveHoy = claveDiaAR(ahora)

    if (claveElegida < claveHoy) return 'La fecha de entrega no puede ser anterior a hoy.'

    const tope = sumarMesesAR(inicioDelDiaAR(ahora), MAX_MESES_PROGRAMACION)
    if (claveElegida > claveDiaAR(tope)) {
        return `Como mucho se puede programar con ${MAX_MESES_PROGRAMACION} mes de anticipación.`
    }
    return null
}

/**
 * `YYYY-MM-DD` (día AR) → instante que se guarda en `fecha_entrega`.
 *
 * Se ancla al MEDIODÍA argentino, no a las 00:00, a propósito: el día es lo
 * único que el operador elige, y el mediodía deja el instante lejos de los dos
 * bordes del día, así ningún corrimiento de huso lo empuja a la jornada vecina.
 */
export function fechaEntregaDesdeISO(iso: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    if (!m) throw new Error(`Fecha de entrega inválida: ${iso}`)
    return instanteAR(Number(m[1]), Number(m[2]), Number(m[3]), 12)
}

/** El valor para el `<input type="date">` a partir de lo guardado. */
export function isoDesdeFechaEntrega(fecha: string | Date | null | undefined): string {
    if (!fecha) return ''
    const d = typeof fecha === 'string' ? new Date(fecha) : fecha
    if (Number.isNaN(d.getTime())) return ''
    return fechaISOAR(d)
}

/** Rango de fechas seleccionables en el modal: [hoy, hoy + MAX] en día AR. */
export function rangoFechasEntrega(ahora: Date = new Date()): { min: string; max: string } {
    const hoy = inicioDelDiaAR(ahora)
    return {
        min: fechaISOAR(hoy),
        max: fechaISOAR(sumarMesesAR(hoy, MAX_MESES_PROGRAMACION)),
    }
}

/**
 * ¿Es un pedido programado, o sea, se entrega un día distinto del que se cargó?
 *
 * Se compara por día AR: un pedido cargado a las 23:50 para entregar "hoy"
 * guarda fecha_entrega al mediodía de ese mismo día, y no debe marcarse como
 * programado solo porque los instantes difieren en horas.
 */
export function esPedidoProgramado(pedido: {
    created_at?: string | null
    fecha_entrega?: string | null
}): boolean {
    if (!pedido.created_at || !pedido.fecha_entrega) return false
    const creado = new Date(pedido.created_at)
    const entrega = new Date(pedido.fecha_entrega)
    if (Number.isNaN(creado.getTime()) || Number.isNaN(entrega.getTime())) return false
    return claveDiaAR(entrega) !== claveDiaAR(creado)
}

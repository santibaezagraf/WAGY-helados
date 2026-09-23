import { describe, it, expect } from 'vitest'
import {
    MAX_MESES_PROGRAMACION,
    esPedidoProgramado,
    fechaEntregaDesdeISO,
    isoDesdeFechaEntrega,
    rangoFechasEntrega,
    validarFechaEntrega,
} from './entrega'
import { claveDiaAR } from './zona-horaria'

// Instantes UTC explícitos: así los tests valen igual corra donde corra (el
// runtime de Vercel es UTC, el de acá no). El caso crítico es la franja
// 21:00–23:59 AR, que en UTC ya cayó al día siguiente.
const MEDIODIA_22_SEP = new Date('2026-09-22T15:00:00.000Z') // 12:00 AR del 22
const NOCHE_22_SEP = new Date('2026-09-23T02:00:00.000Z')    // 23:00 AR del 22

describe('validarFechaEntrega', () => {
    it('acepta hoy', () => {
        expect(validarFechaEntrega('2026-09-22', MEDIODIA_22_SEP)).toBeNull()
    })

    it('acepta hasta el tope de anticipación', () => {
        expect(validarFechaEntrega('2026-10-22', MEDIODIA_22_SEP)).toBeNull() // +1 mes
    })

    it('rechaza más allá del tope', () => {
        expect(validarFechaEntrega('2026-10-23', MEDIODIA_22_SEP)).toBeTruthy() // +1 mes y 1 día
    })

    it('rechaza fechas pasadas', () => {
        expect(validarFechaEntrega('2026-09-21', MEDIODIA_22_SEP)).toBeTruthy()
    })

    it('rechaza basura', () => {
        expect(validarFechaEntrega('', MEDIODIA_22_SEP)).toBeTruthy()
        expect(validarFechaEntrega('22/09/2026', MEDIODIA_22_SEP)).toBeTruthy()
        expect(validarFechaEntrega('2026-9-2', MEDIODIA_22_SEP)).toBeTruthy()
    })

    // EL caso de zona horaria: a las 23:00 AR del 22, en UTC ya es el 23. Si la
    // comparación se hiciera en UTC, "hoy" (22) se leería como pasado y el
    // operador no podría cargar un pedido para el día en curso.
    it('a las 23:00 AR sigue aceptando "hoy" (y no se corre el tope)', () => {
        expect(validarFechaEntrega('2026-09-22', NOCHE_22_SEP)).toBeNull()
        expect(validarFechaEntrega('2026-10-22', NOCHE_22_SEP)).toBeNull()
        expect(validarFechaEntrega('2026-10-23', NOCHE_22_SEP)).toBeTruthy()
        expect(validarFechaEntrega('2026-09-21', NOCHE_22_SEP)).toBeTruthy()
    })
})

describe('rangoFechasEntrega', () => {
    it('va de hoy a hoy + el tope', () => {
        expect(rangoFechasEntrega(MEDIODIA_22_SEP)).toEqual({
            min: '2026-09-22',
            max: '2026-10-22',
        })
    })

    it('a las 23:00 AR el mínimo sigue siendo el día en curso', () => {
        expect(rangoFechasEntrega(NOCHE_22_SEP).min).toBe('2026-09-22')
    })

    it('el rango cubre exactamente MAX_MESES_PROGRAMACION meses calendario', () => {
        const { min, max } = rangoFechasEntrega(MEDIODIA_22_SEP)
        expect(min).toBe('2026-09-22')
        expect(max).toBe('2026-10-22')
        expect(MAX_MESES_PROGRAMACION).toBe(1)
    })
})

describe('fechaEntregaDesdeISO / isoDesdeFechaEntrega', () => {
    it('ida y vuelta conserva el día AR', () => {
        expect(isoDesdeFechaEntrega(fechaEntregaDesdeISO('2026-09-29'))).toBe('2026-09-29')
    })

    // Anclar al mediodía es lo que evita que un corrimiento de huso empuje el
    // pedido al día vecino: desde las 12:00 AR sobran 12 horas para cada borde.
    it('ancla al mediodía AR, lejos de los bordes del día', () => {
        const d = fechaEntregaDesdeISO('2026-09-29')
        expect(claveDiaAR(d)).toBe(20260929)
        expect(d.toISOString()).toBe('2026-09-29T15:00:00.000Z')
    })

    it('tolera valores vacíos al leer', () => {
        expect(isoDesdeFechaEntrega(null)).toBe('')
        expect(isoDesdeFechaEntrega(undefined)).toBe('')
        expect(isoDesdeFechaEntrega('')).toBe('')
        expect(isoDesdeFechaEntrega('no es fecha')).toBe('')
    })

    it('rechaza un ISO mal formado al escribir', () => {
        expect(() => fechaEntregaDesdeISO('29/09/2026')).toThrow()
    })
})

describe('esPedidoProgramado', () => {
    it('es programado cuando se entrega otro día', () => {
        expect(esPedidoProgramado({
            created_at: '2026-09-22T15:00:00.000Z',
            fecha_entrega: '2026-09-29T15:00:00.000Z',
        })).toBe(true)
    })

    // Un pedido normal cargado a las 23:50 tiene created_at y fecha_entrega con
    // horas distintas pero el MISMO día AR: no es programado.
    it('no es programado si es el mismo día AR aunque difieran las horas', () => {
        expect(esPedidoProgramado({
            created_at: '2026-09-23T02:50:00.000Z', // 23:50 AR del 22
            fecha_entrega: '2026-09-22T15:00:00.000Z', // 12:00 AR del 22
        })).toBe(false)
    })

    it('sin datos no marca nada (filas viejas)', () => {
        expect(esPedidoProgramado({})).toBe(false)
        expect(esPedidoProgramado({ created_at: '2026-09-22T15:00:00.000Z' })).toBe(false)
        expect(esPedidoProgramado({ created_at: 'x', fecha_entrega: 'y' })).toBe(false)
    })
})

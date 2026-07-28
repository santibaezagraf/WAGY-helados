import { describe, it, expect } from 'vitest'
import {
    partesAR,
    instanteAR,
    inicioDelDiaAR,
    inicioDiaSiguienteAR,
    inicioSemanaAR,
    inicioMesAR,
    sumarDiasAR,
    sumarMesesAR,
    claveDiaAR,
    fechaISOAR,
    formatearFechaAR,
    formatearHoraAR,
} from './zona-horaria'

// Estos tests NO dependen del TZ del runtime: construyen instantes UTC explícitos
// (Date.UTC / ISO con Z) y afirman el resultado en hora de Argentina (UTC-3).
// AR va 3h detrás de UTC, así que un instante 21:00–23:59 UTC ya es el día siguiente
// en UTC pero sigue siendo el día "anterior" en AR — el caso que rompía el sistema.

describe('partesAR', () => {
    it('descompone un instante en el reloj de pared AR (UTC-3)', () => {
        // 2026-07-15T15:00:00Z = 12:00 del 15/07 en AR
        const p = partesAR(new Date('2026-07-15T15:00:00Z'))
        expect(p).toMatchObject({ anio: 2026, mes: 7, dia: 15, hora: 12, min: 0 })
        expect(p.diaSemana).toBe(3) // miércoles
    })

    it('la medianoche UTC pertenece al día ANTERIOR en AR', () => {
        // 2026-07-16T00:00:00Z = 21:00 del 15/07 en AR
        const p = partesAR(new Date('2026-07-16T00:00:00Z'))
        expect(p).toMatchObject({ anio: 2026, mes: 7, dia: 15, hora: 21 })
    })
})

describe('instanteAR / inicioDelDiaAR', () => {
    it('inicio del día AR = 03:00 UTC de ese día', () => {
        // Un pedido de las 22:00 AR del 15/07 = 2026-07-16T01:00:00Z
        const pedido = new Date('2026-07-16T01:00:00Z')
        const inicio = inicioDelDiaAR(pedido)
        // 00:00 del 15/07 AR = 2026-07-15T03:00:00Z (NO el 16)
        expect(inicio.toISOString()).toBe('2026-07-15T03:00:00.000Z')
    })

    it('un pedido de las 22:00 AR cae en el día AR correcto, no en el siguiente', () => {
        const pedido = new Date('2026-07-16T01:00:00Z') // 22:00 AR del 15/07
        expect(claveDiaAR(pedido)).toBe(20260715)
    })

    it('instanteAR reconstruye el instante exacto', () => {
        expect(instanteAR(2026, 7, 15, 0, 0, 0, 0).toISOString()).toBe('2026-07-15T03:00:00.000Z')
        expect(instanteAR(2026, 7, 15, 22, 0, 0, 0).toISOString()).toBe('2026-07-16T01:00:00.000Z')
    })
})

describe('bordes de calendario AR', () => {
    it('inicioDiaSiguienteAR es el fin exclusivo (00:00 AR del día siguiente)', () => {
        const f = new Date('2026-07-15T15:00:00Z')
        expect(inicioDiaSiguienteAR(f).toISOString()).toBe('2026-07-16T03:00:00.000Z')
    })

    it('inicioSemanaAR ancla en el domingo AR', () => {
        // 15/07/2026 es miércoles → domingo de esa semana = 12/07
        const f = new Date('2026-07-15T15:00:00Z')
        expect(fechaISOAR(inicioSemanaAR(f))).toBe('2026-07-12')
    })

    it('inicioMesAR ancla en el día 1 AR', () => {
        const f = new Date('2026-07-15T15:00:00Z')
        expect(fechaISOAR(inicioMesAR(f))).toBe('2026-07-01')
    })

    it('inicioMesAR usa el mes AR aun cerca del borde UTC', () => {
        // 2026-08-01T01:00:00Z = 31/07 22:00 AR → el mes AR sigue siendo julio
        const f = new Date('2026-08-01T01:00:00Z')
        expect(fechaISOAR(inicioMesAR(f))).toBe('2026-07-01')
    })
})

describe('aritmética de calendario AR', () => {
    it('sumarDiasAR cruza fin de mes', () => {
        expect(fechaISOAR(sumarDiasAR(new Date('2026-07-31T15:00:00Z'), 1))).toBe('2026-08-01')
        expect(fechaISOAR(sumarDiasAR(new Date('2026-07-01T15:00:00Z'), -1))).toBe('2026-06-30')
    })

    it('sumarMesesAR cruza fin de año', () => {
        expect(fechaISOAR(sumarMesesAR(new Date('2026-12-15T15:00:00Z'), 1))).toBe('2027-01-15')
        expect(fechaISOAR(sumarMesesAR(new Date('2026-01-15T15:00:00Z'), -1))).toBe('2025-12-15')
    })
})

describe('fechaISOAR', () => {
    it('devuelve el día AR, no el UTC', () => {
        // 22:00 AR del 15/07 = 01:00 UTC del 16/07
        expect(fechaISOAR(new Date('2026-07-16T01:00:00Z'))).toBe('2026-07-15')
    })
})

describe('formateo forzado a AR', () => {
    it('formatearFechaAR usa el huso de Argentina', () => {
        const f = new Date('2026-07-16T01:00:00Z') // 15/07 22:00 AR
        expect(formatearFechaAR(f, { day: 'numeric', month: 'short' })).toMatch(/15/)
    })

    it('formatearHoraAR devuelve la hora de pared AR', () => {
        const f = new Date('2026-07-15T15:00:00Z') // 12:00 AR
        expect(formatearHoraAR(f)).toBe('12:00')
    })
})

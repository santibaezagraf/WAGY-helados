import { describe, it, expect } from 'vitest'
import { puedeAvanzar, parseAncla, desplazarAncla, formatAncla } from './periodo-utils'

/**
 * Instantes UTC explícitos para que los tests valgan igual corra donde corra.
 * El 22/09/2026 es martes, así que la semana AR (lunes a domingo) va del 21 al 27.
 */
const MARTES_22 = new Date('2026-09-22T15:00:00.000Z') // 12:00 AR del martes 22
const anclaDe = (iso: string) => parseAncla(iso)

describe('puedeAvanzar', () => {
    describe('sin nada programado', () => {
        it('no deja pasar del día de hoy', () => {
            expect(puedeAvanzar('dia', anclaDe('2026-09-22'), null, MARTES_22)).toBe(false)
        })

        it('sí deja volver hacia adelante desde un día pasado', () => {
            expect(puedeAvanzar('dia', anclaDe('2026-09-20'), null, MARTES_22)).toBe(true)
        })

        it('no deja pasar de la semana ni del mes en curso', () => {
            expect(puedeAvanzar('semana', anclaDe('2026-09-22'), null, MARTES_22)).toBe(false)
            expect(puedeAvanzar('mes', anclaDe('2026-09-22'), null, MARTES_22)).toBe(false)
        })
    })

    describe('con un pedido programado para pasado mañana (jueves 24)', () => {
        const MAX = new Date('2026-09-24T15:00:00.000Z')

        it('deja avanzar día a día hasta ese día, y no más', () => {
            expect(puedeAvanzar('dia', anclaDe('2026-09-22'), MAX, MARTES_22)).toBe(true)
            expect(puedeAvanzar('dia', anclaDe('2026-09-23'), MAX, MARTES_22)).toBe(true)
            expect(puedeAvanzar('dia', anclaDe('2026-09-24'), MAX, MARTES_22)).toBe(false)
        })

        // Cae dentro de la semana en curso: no habilita la semana siguiente.
        it('no habilita la semana siguiente', () => {
            expect(puedeAvanzar('semana', anclaDe('2026-09-22'), MAX, MARTES_22)).toBe(false)
        })
    })

    // El caso que pidió el cliente: un pedido para un día de la semana que viene
    // tiene que dejar llegar a esa semana entera, no solo a ese día.
    describe('con un pedido para el martes de la semana siguiente (29)', () => {
        const MAX = new Date('2026-09-29T15:00:00.000Z')

        it('habilita la semana siguiente, y ahí se corta', () => {
            expect(puedeAvanzar('semana', anclaDe('2026-09-22'), MAX, MARTES_22)).toBe(true)
            expect(puedeAvanzar('semana', anclaDe('2026-09-29'), MAX, MARTES_22)).toBe(false)
        })

        it('en vista día deja caminar hasta el 29', () => {
            expect(puedeAvanzar('dia', anclaDe('2026-09-27'), MAX, MARTES_22)).toBe(true)
            expect(puedeAvanzar('dia', anclaDe('2026-09-28'), MAX, MARTES_22)).toBe(true)
            expect(puedeAvanzar('dia', anclaDe('2026-09-29'), MAX, MARTES_22)).toBe(false)
        })

        // Sigue siendo septiembre: el mes no se mueve.
        it('no habilita el mes siguiente', () => {
            expect(puedeAvanzar('mes', anclaDe('2026-09-22'), MAX, MARTES_22)).toBe(false)
        })
    })

    describe('con un pedido para el mes que viene', () => {
        const MAX = new Date('2026-10-02T15:00:00.000Z')

        it('habilita octubre, y ahí se corta', () => {
            expect(puedeAvanzar('mes', anclaDe('2026-09-22'), MAX, MARTES_22)).toBe(true)
            expect(puedeAvanzar('mes', anclaDe('2026-10-02'), MAX, MARTES_22)).toBe(false)
        })

        it('también habilita la semana que cruza el fin de mes', () => {
            expect(puedeAvanzar('semana', anclaDe('2026-09-22'), MAX, MARTES_22)).toBe(true)
        })
    })

    it('un máximo en el pasado no habilita nada más allá de hoy', () => {
        const VIEJO = new Date('2026-09-10T15:00:00.000Z')
        expect(puedeAvanzar('dia', anclaDe('2026-09-22'), VIEJO, MARTES_22)).toBe(false)
        // Pero desde un día pasado se sigue pudiendo volver al presente.
        expect(puedeAvanzar('dia', anclaDe('2026-09-19'), VIEJO, MARTES_22)).toBe(true)
    })

    it("'todos' no navega", () => {
        expect(puedeAvanzar('todos', anclaDe('2026-09-22'), null, MARTES_22)).toBe(false)
    })

    // Invariante: caminar hacia adelante mientras `puedeAvanzar` diga que sí
    // siempre termina — no hay forma de quedarse en un bucle.
    it('avanzar hasta el tope termina y llega al período del máximo', () => {
        const MAX = new Date('2026-09-29T15:00:00.000Z')
        let fecha = anclaDe('2026-09-22')
        let pasos = 0
        while (puedeAvanzar('dia', fecha, MAX, MARTES_22) && pasos < 50) {
            fecha = desplazarAncla('dia', fecha, 1)
            pasos++
        }
        expect(pasos).toBe(7)
        expect(formatAncla(fecha)).toBe('2026-09-29')
    })
})

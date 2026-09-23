import { describe, it, expect } from 'vitest'
import { crearMensajeWpp, lineaDePago } from './mensaje-utils'
import type { Pedido } from '@/types/pedidos'

function pedido(parcial: Partial<Pedido>): Pedido {
    return {
        id: 1,
        direccion: 'Mitre 951',
        aclaracion: null,
        telefono: '5491122334455',
        cantidad_agua: 0,
        cantidad_crema: 0,
        metodo_pago: 'efectivo',
        precio_total: 24000,
        ...parcial,
    } as Pedido
}

describe('lineaDePago', () => {
    // La regla del cliente: transferencia y efectivo son EXCLUYENTES.
    // Si es transferencia, el cadete no cobra nada y el monto no debe aparecer.
    it('transferencia: dice solo "Transferencia", sin monto', () => {
        const linea = lineaDePago({ metodo_pago: 'transferencia', precio_total: 24000 })
        expect(linea).toBe('Transferencia.')
        expect(linea).not.toMatch(/24|\$/)
    })

    it('efectivo: dice el monto y no menciona transferencia', () => {
        const linea = lineaDePago({ metodo_pago: 'efectivo', precio_total: 24000 })
        expect(linea).toMatch(/24\.000/)
        expect(linea.toLowerCase()).not.toContain('transferencia')
    })

    // precio_total es una columna GENERADA: puede venir null si el pedido todavía
    // no tiene precio calculado. Mostrar "$0" haría que el cadete no cobre.
    it('efectivo sin precio: "a confirmar" en vez de $0', () => {
        expect(lineaDePago({ metodo_pago: 'efectivo', precio_total: null })).toBe('Cobrar: a confirmar.')
        expect(lineaDePago({ metodo_pago: 'efectivo', precio_total: 0 })).toBe('Cobrar: a confirmar.')
    })

    it('transferencia sin precio sigue sin mostrar monto', () => {
        expect(lineaDePago({ metodo_pago: 'transferencia', precio_total: null })).toBe('Transferencia.')
    })
})

describe('crearMensajeWpp', () => {
    // Las cantidades van en CAJAS: 50 por caja de agua, 30 por caja de crema.
    // Este redondeo es el corazón del mensaje y no debe cambiar.
    it('convierte unidades a cajas redondeando para arriba', () => {
        expect(crearMensajeWpp(pedido({ cantidad_agua: 50, cantidad_crema: 30 })))
            .toContain('1 de agua y 1 de crema.')
        expect(crearMensajeWpp(pedido({ cantidad_agua: 51, cantidad_crema: 31 })))
            .toContain('2 de agua y 2 de crema.')
        expect(crearMensajeWpp(pedido({ cantidad_agua: 100, cantidad_crema: 0 })))
            .toContain('2 de agua')
    })

    it('omite el tipo que no se pidió', () => {
        const soloCrema = crearMensajeWpp(pedido({ cantidad_agua: 0, cantidad_crema: 30 }))
        expect(soloCrema).toContain('1 de crema.')
        expect(soloCrema).not.toContain('de agua')
    })

    it('incluye dirección, aclaración y teléfono', () => {
        const m = crearMensajeWpp(pedido({ aclaracion: 'timbre 2', cantidad_crema: 30 }))
        expect(m).toContain('Mitre 951')
        expect(m).toContain('timbre 2')
        expect(m).toContain('5491122334455')
    })

    it('sin aclaración no deja una coma suelta de más', () => {
        const m = crearMensajeWpp(pedido({ aclaracion: null, cantidad_crema: 30 }))
        expect(m).toContain('Mitre 951, 5491122334455')
    })

    it('termina con la línea de pago según el método', () => {
        expect(crearMensajeWpp(pedido({ cantidad_crema: 30, metodo_pago: 'efectivo', precio_total: 24000 })))
            .toMatch(/Cobrar: \$\s?24\.000\.$/)
        expect(crearMensajeWpp(pedido({ cantidad_crema: 30, metodo_pago: 'transferencia' })))
            .toMatch(/Transferencia\.$/)
    })
})

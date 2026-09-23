import { describe, it, expect } from 'vitest'
import { armarTextoActividad, type FilaActividad } from './actividad-texto'

function fila(parcial: Partial<FilaActividad>): FilaActividad {
    return {
        id: 1,
        usuarioNombre: 'juan',
        accion: 'pedido.crear',
        cantidad: 1,
        pedidoId: null,
        detalle: null,
        createdAt: '2026-09-17T18:00:00.000Z',
        ...parcial,
    }
}

describe('armarTextoActividad', () => {
    it('pedido puntual: usa el número de pedido', () => {
        expect(armarTextoActividad(fila({ accion: 'pedido.crear', pedidoId: 412 })))
            .toBe('cargó el pedido #412')
        expect(armarTextoActividad(fila({ accion: 'pedido.editar', pedidoId: 7 })))
            .toBe('editó el pedido #7')
    })

    // Lo masivo no tiene un pedido puntual: se describe por cantidad, y el
    // adjetivo tiene que concordar en número con ella.
    it('acción masiva: usa la cantidad, con el plural correcto', () => {
        expect(armarTextoActividad(fila({ accion: 'pedido.enviar', cantidad: 20 })))
            .toBe('marcó 20 pedidos como enviados')
        expect(armarTextoActividad(fila({ accion: 'pedido.enviar', cantidad: 1 })))
            .toBe('marcó 1 pedido como enviado')
        expect(armarTextoActividad(fila({
            accion: 'pedido.pago', cantidad: 5, detalle: { pagado: true },
        }))).toBe('marcó 5 pedidos como pagados')
    })

    it('estado: incluye el estado cuando está en el detalle', () => {
        expect(armarTextoActividad(fila({
            accion: 'pedido.estado', pedidoId: 3, detalle: { estado: 'enviado' },
        }))).toBe('cambió el pedido #3 a "enviado"')
    })

    // "de el pedido" es incorrecto: tiene que contraerse a "del pedido".
    it('estado: sin detalle cae a un texto genérico, contrayendo "del"', () => {
        expect(armarTextoActividad(fila({ accion: 'pedido.estado', pedidoId: 3 })))
            .toBe('cambió el estado del pedido #3')
        expect(armarTextoActividad(fila({ accion: 'pedido.estado', cantidad: 4 })))
            .toBe('cambió el estado de 4 pedidos')
    })

    it('pago: distingue pagado de no pagado', () => {
        expect(armarTextoActividad(fila({
            accion: 'pedido.pago', pedidoId: 9, detalle: { pagado: true },
        }))).toBe('marcó el pedido #9 como pagado')
        expect(armarTextoActividad(fila({
            accion: 'pedido.pago', pedidoId: 9, detalle: { pagado: false },
        }))).toBe('marcó el pedido #9 como no pagado')
    })

    it('enviar: distingue marcar de desmarcar', () => {
        expect(armarTextoActividad(fila({
            accion: 'pedido.enviar', pedidoId: 9, detalle: { enviado: false },
        }))).toBe('desmarcó el pedido #9 como enviado')
        expect(armarTextoActividad(fila({
            accion: 'pedido.enviar', pedidoId: 9, detalle: { enviado: true },
        }))).toBe('marcó el pedido #9 como enviado')
    })

    it('costo de envío: formatea el monto', () => {
        expect(armarTextoActividad(fila({
            accion: 'pedido.costo_envio', pedidoId: 5, detalle: { costo: 2500 },
        }))).toBe('puso el envío del pedido #5 en $2.500')
    })

    it('gasto: monto y concepto opcional', () => {
        expect(armarTextoActividad(fila({
            accion: 'gasto.registrar', detalle: { monto: 12000 },
        }))).toBe('registró un gasto de $12.000')
        expect(armarTextoActividad(fila({
            accion: 'gasto.registrar', detalle: { monto: 12000, concepto: 'nafta' },
        }))).toBe('registró un gasto de $12.000 (nafta)')
        expect(armarTextoActividad(fila({ accion: 'gasto.registrar' })))
            .toBe('registró un gasto')
        expect(armarTextoActividad(fila({ accion: 'gasto.eliminar' })))
            .toBe('eliminó un gasto')
    })

    // El historial es informativo: una fila vieja o de una versión más nueva no
    // debe romper la pantalla.
    it('acción desconocida devuelve el nombre crudo, sin romper', () => {
        expect(armarTextoActividad(fila({ accion: 'algo.nuevo' })))
            .toBe('algo.nuevo')
    })

    it('ignora detalles con el tipo equivocado', () => {
        expect(armarTextoActividad(fila({
            accion: 'pedido.costo_envio', pedidoId: 5, detalle: { costo: 'dos mil' },
        }))).toBe('cambió el costo de envío del pedido #5')
        expect(armarTextoActividad(fila({
            accion: 'gasto.registrar', detalle: { monto: null, concepto: '' },
        }))).toBe('registró un gasto')
    })
})

import { Pedido } from "@/types/pedidos";

// Formateador propio en vez de importar `formatearPesos` de precios-publico.ts:
// ese módulo arrastra `@supabase/supabase-js` y una referencia a la service-role
// key, y este archivo lo importan componentes CLIENTE (data-table, columns), así
// que iría a parar al bundle del navegador. Misma configuración que aquél.
const pesos = new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
});

/**
 * Mensaje que se le copia al cadete para cada reparto.
 *
 * Las cantidades van en CAJAS, no en unidades: 50 helados por caja de agua y 30
 * por caja de crema (de ahí los Math.ceil).
 *
 * La última línea depende del método de pago, y es excluyente:
 *  - transferencia -> solo dice "Transferencia" (el cadete no cobra nada).
 *  - efectivo      -> solo dice cuánto cobrar.
 *
 * El monto es `precio_total` TAL CUAL, sin sumarle `costo_envio`: el envío es un
 * costo del negocio, no algo que se le cobre al cliente arriba del precio (es
 * como lo trata `obtener_balance`, que lo RESTA del efectivo). Si algún día se
 * empieza a cobrar el envío aparte, hay que cambiar las dos cosas juntas.
 */
export function crearMensajeWpp(pedido: Pedido): string {
    const { direccion, aclaracion, telefono, cantidad_agua, cantidad_crema } = pedido

    const mensaje = `${direccion},${aclaracion ? ` ${aclaracion},` : ''} ${telefono}, ${cantidad_agua ? `${Math.ceil(cantidad_agua / 50)} de agua ${cantidad_crema ? 'y ' : ''}` : ''}${cantidad_crema ? `${Math.ceil(cantidad_crema / 30)} de crema.` : ''}`

    return `${mensaje} ${lineaDePago(pedido)}`
}

/**
 * Pura y exportada para testear: la línea de pago del mensaje.
 * `precio_total` es una columna generada y puede venir null (pedido sin precio
 * calculado todavía); ahí avisamos "a confirmar" en vez de mostrar $0, mismo
 * criterio que `construirResumenPedido` en el resumen del bot.
 */
export function lineaDePago(pedido: Pick<Pedido, 'metodo_pago' | 'precio_total'>): string {
    if (pedido.metodo_pago === 'transferencia') return 'Transferencia.'

    const total = pedido.precio_total
    if (total == null || total <= 0) return 'Cobrar: a confirmar.'
    return `Cobrar: ${pesos.format(total)}.`
}

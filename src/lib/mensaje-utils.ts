import { Pedido } from "@/types/pedidos";

export function crearMensajeWpp (pedido: Pedido) : string {
    const { direccion, aclaracion, telefono, cantidad_agua, cantidad_crema } = pedido

    let mensaje = `${direccion},${aclaracion ? ` ${aclaracion},` : ''} ${telefono}, ${ cantidad_agua ? `${Math.ceil(cantidad_agua / 50)} de agua ${ cantidad_crema ? 'y ' : ''}` : ''}${ cantidad_crema ? `${Math.ceil(cantidad_crema / 30)} de crema.` : ''}`

    return mensaje    
}
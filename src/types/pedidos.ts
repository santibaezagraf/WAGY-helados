import { Tables } from './supabase'

export type Pedido = Tables<'pedidos'>

// Tipo para insertar un nuevo pedido
export type PedidoInsert = {
    direccion: string
    telefono: string
    cantidad_agua: number
    cantidad_crema: number
    metodo_pago: string
    estado: string
    precio_unitario_agua: number
    precio_unitario_crema: number
    costo_envio: number
    aclaracion?: string | null
    observaciones?: string | null
}

// Tipo para actualizar un pedido
export type PedidoUpdate = Partial<Pedido>
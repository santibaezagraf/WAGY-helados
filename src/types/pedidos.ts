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
    costo_envio: number
    monto_total_agua: number
    monto_total_crema: number
    aclaracion?: string | null
    observaciones?: string | null
}

// Tipo para actualizar un pedido
export type PedidoUpdate = Partial<Pedido>

export type ReglaPrecio = Tables<'reglas_precios'>

export type ListaPrecios = Tables<'listas_precios'> & {
    agua: { fromQuantity: number; pricePerUnit: number }[]
    crema: { fromQuantity: number; pricePerUnit: number }[]
}
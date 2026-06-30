'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { createClient } from '@/lib/supabase-server'
import { PEDIDOS_TAG } from '@/lib/data/pedidos-listado'

/**
 * Mantiene el flag booleano `enviado` consistente con el `estado`:
 *  - estado='enviado'   → enviado=true
 *  - estado='cancelado' → enviado=false (sino una cancelación de un pedido
 *                         marcado previamente como enviado deja el flag pegado
 *                         y el bot lo trata como "pedido despachado reciente"
 *                         para respuestas contextuales).
 *  - otros estados      → no tocamos el flag (lo gestiona el dashboard a mano).
 */
function patchConEnviadoCoherente(estado: string): Record<string, unknown> {
    const patch: Record<string, unknown> = { estado }
    if (estado === 'enviado') patch.enviado = true
    if (estado === 'cancelado') patch.enviado = false
    return patch
}

/**
 * Actualiza el estado de un pedido individual
 */
export async function actualizarEstadoPedido(
    id: number,
    nuevoEstado: string
) {
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update(patchConEnviadoCoherente(nuevoEstado))
        .eq("id", id)

    if (error) throw new Error(`Error al actualizar estado: ${error.message}`)

    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

/**
 * Actualiza el estado de pago de un pedido individual
 */
export async function actualizarPagadoPedido(
    id: number,
    pagado: boolean
) {
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update({ pagado })
        .eq("id", id)

    if (error) throw new Error(`Error al actualizar pago: ${error.message}`)

    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

/**
 * Actualiza el estado de envío de mensaje WhatsApp de un pedido individual
 */
export async function actualizarEnviadoPedido(
    id: number,
    enviado: boolean
) {
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update({ enviado })
        .eq("id", id)

    if (error) throw new Error(`Error al actualizar envío: ${error.message}`)

    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

/**
 * Actualiza un pedido completo con todos sus campos
 */
export async function actualizarPedidoCompleto(
    id: number,
    datos: {
        direccion: string
        telefono: string
        cantidad_agua: number
        cantidad_crema: number
        metodo_pago: string
        estado: string
        pagado: boolean
        costo_envio: number
        aclaracion?: string | null
        observaciones?: string | null
        monto_total_agua: number
        monto_total_crema: number
    }
) {
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        // La edición manual es la fuente de verdad: colapsamos los slots por tipo
        // (observaciones_detalle) a null. El bot, en su próximo turno, resiembra
        // 'general' desde el texto plano (ver leerSlots). Sin esto, el bot
        // mergearía contra slots viejos que ya no reflejan lo que escribió el staff.
        .update({ ...datos, observaciones_detalle: null, ...patchConEnviadoCoherente(datos.estado) })
        .eq("id", id)

    if (error) throw new Error(`Error al actualizar pedido: ${error.message}`)

    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

/**
 * Actualiza masivamente el estado de múltiples pedidos
 */
export async function actualizarEstadoMasivo(
    ids: number[],
    nuevoEstado: string
) {
    if (ids.length === 0) return { success: true }

    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update(patchConEnviadoCoherente(nuevoEstado))
        .in("id", ids)

    if (error) throw new Error(`Error al actualizar estados masivamente: ${error.message}`)

    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

/**
 * Actualiza masivamente el estado de pago de múltiples pedidos
 */
export async function actualizarPagadoMasivo(
    ids: number[],
    pagado: boolean
) {
    if (ids.length === 0) return { success: true }

    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update({ pagado })
        .in("id", ids)

    if (error) throw new Error(`Error al actualizar pagos masivamente: ${error.message}`)

    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

/**
 * Actualiza masivamente el estado de envío de múltiples pedidos
 */
export async function actualizarEnviadoMasivo(
    ids: number[],
    enviado: boolean
) {
    if (ids.length === 0) return { success: true }

    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update({ enviado })
        .in("id", ids)

    if (error) throw new Error(`Error al actualizar envíos masivamente: ${error.message}`)

    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

/**
 * Crea un nuevo pedido
 */
export async function crearPedido(datos: {
    direccion: string
    telefono: string
    cantidad_agua: number
    cantidad_crema: number
    metodo_pago: string
    costo_envio: number
    aclaracion?: string | null
    observaciones?: string | null
    monto_total_agua: number
    monto_total_crema: number
}) {
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .insert([{
            ...datos,
            estado: "pendiente",
        }])

    if (error) throw new Error(`Error al crear pedido: ${error.message}`)

    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

export async function actualizarCostoEnvioPedido(
    id: number,
    nuevoCostoEnvio: number
) {
    const supabase = await createClient()

    try {
        const { error } = await supabase
            .from("pedidos")
            .update({ costo_envio: nuevoCostoEnvio })
            .eq("id", id)

        if (error) throw new Error(`Error al actualizar costo de envío: ${error.message}`)

        revalidatePath('/')
        updateTag(PEDIDOS_TAG)
        return { success: true }
    } catch (error) {
        console.error("Error al actualizar costo de envío:", error)
        throw error
    }
}
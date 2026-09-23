'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { createClient } from '@/lib/supabase-server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { Database } from '@/types/supabase'
import { PEDIDOS_TAG } from '@/lib/data/pedidos-listado'
import { patchConEnviadoCoherente, patchEnviado } from '@/lib/pedidos-estado'
import { exigirPermiso } from '@/lib/auth-rol'
import { registrarActividad } from '@/lib/actividad'
import { fechaEntregaDesdeISO, validarFechaEntrega } from '@/lib/entrega'

/**
 * Día de entrega elegido (`YYYY-MM-DD`) → instante a guardar, o `undefined` para
 * dejar que la DB ponga `now()` (pedido normal, se entrega el mismo día).
 *
 * Valida en el SERVIDOR y no solo en el modal: las actions son invocables por su
 * cuenta, y una fecha arbitraria metería el pedido en el período equivocado del
 * listado y del balance.
 */
function resolverFechaEntrega(iso: string | null | undefined): string | undefined {
    if (!iso) return undefined
    const error = validarFechaEntrega(iso)
    if (error) throw new Error(error)
    return fechaEntregaDesdeISO(iso).toISOString()
}

/**
 * Acciones de pedidos del dashboard.
 *
 * Doble capa de permiso: el `exigirPermiso` de cada action + la RLS (estas usan
 * el cliente ligado a la sesión, así que las policies aplican). La excepción es
 * `actualizarCostoEnvioPedido` — ver su comentario.
 */

// Cliente service-role SOLO para el costo de envío (ver abajo por qué).
const supabaseAdmin = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/**
 * Actualiza el estado de un pedido individual
 */
export async function actualizarEstadoPedido(
    id: number,
    nuevoEstado: string
) {
    const sesion = await exigirPermiso('pedidos.escribir')
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update(patchConEnviadoCoherente(nuevoEstado, sesion.nombre))
        .eq("id", id)

    if (error) throw new Error(`Error al actualizar estado: ${error.message}`)

    registrarActividad(sesion, 'pedido.estado', { pedidoId: id, detalle: { estado: nuevoEstado } })
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
    const sesion = await exigirPermiso('pedidos.escribir')
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update({ pagado })
        .eq("id", id)

    if (error) throw new Error(`Error al actualizar pago: ${error.message}`)

    registrarActividad(sesion, 'pedido.pago', { pedidoId: id, detalle: { pagado } })
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
    const sesion = await exigirPermiso('pedidos.escribir')
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update(patchEnviado(enviado, sesion.nombre))
        .eq("id", id)

    if (error) throw new Error(`Error al actualizar envío: ${error.message}`)

    registrarActividad(sesion, 'pedido.enviar', { pedidoId: id, detalle: { enviado } })
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
        /** Día de entrega (YYYY-MM-DD, día AR). Vacío = no se toca. */
        fecha_entrega?: string | null
    }
) {
    const sesion = await exigirPermiso('pedidos.escribir')
    const { fecha_entrega, ...resto } = datos
    const entrega = resolverFechaEntrega(fecha_entrega)
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        // La edición manual es la fuente de verdad: colapsamos los slots por tipo
        // (observaciones_detalle) a null. El bot, en su próximo turno, resiembra
        // 'general' desde el texto plano (ver leerSlots). Sin esto, el bot
        // mergearía contra slots viejos que ya no reflejan lo que escribió el staff.
        // aviso_precio_sobreescrito=false: cualquier edición explícita del
        // operador significa que ya revisó el pedido (con precio manual o sin).
        .update({
            ...resto,
            observaciones_detalle: null,
            aviso_precio_sobreescrito: false,
            ...(entrega ? { fecha_entrega: entrega } : {}),
            ...patchConEnviadoCoherente(datos.estado, sesion.nombre),
        })
        .eq("id", id)

    if (error) throw new Error(`Error al actualizar pedido: ${error.message}`)

    registrarActividad(sesion, 'pedido.editar', { pedidoId: id })
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

    const sesion = await exigirPermiso('pedidos.escribir')
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update(patchConEnviadoCoherente(nuevoEstado, sesion.nombre))
        .in("id", ids)

    if (error) throw new Error(`Error al actualizar estados masivamente: ${error.message}`)

    registrarActividad(sesion, 'pedido.estado', { cantidad: ids.length, detalle: { estado: nuevoEstado } })
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

    const sesion = await exigirPermiso('pedidos.escribir')
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update({ pagado })
        .in("id", ids)

    if (error) throw new Error(`Error al actualizar pagos masivamente: ${error.message}`)

    registrarActividad(sesion, 'pedido.pago', { cantidad: ids.length, detalle: { pagado } })
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

    const sesion = await exigirPermiso('pedidos.escribir')
    const supabase = await createClient()

    const { error } = await supabase
        .from("pedidos")
        .update(patchEnviado(enviado, sesion.nombre))
        .in("id", ids)

    if (error) throw new Error(`Error al actualizar envíos masivamente: ${error.message}`)

    registrarActividad(sesion, 'pedido.enviar', { cantidad: ids.length, detalle: { enviado } })
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
    /** Día de entrega (YYYY-MM-DD, día AR). Vacío = se entrega hoy. */
    fecha_entrega?: string | null
}) {
    const sesion = await exigirPermiso('pedidos.escribir')
    const { fecha_entrega, ...resto } = datos
    const entrega = resolverFechaEntrega(fecha_entrega)
    const supabase = await createClient()

    const { data, error } = await supabase
        .from("pedidos")
        .insert([{
            ...resto,
            estado: "pendiente",
            creado_por_nombre: sesion.nombre,
            // Omitido cuando no se programó: la DB pone now().
            ...(entrega ? { fecha_entrega: entrega } : {}),
        }])
        .select('id')
        .single()

    if (error) throw new Error(`Error al crear pedido: ${error.message}`)

    registrarActividad(sesion, 'pedido.crear', { pedidoId: data?.id })
    revalidatePath('/')
    updateTag(PEDIDOS_TAG)
    return { success: true }
}

/**
 * Actualiza el costo de envío de un pedido.
 *
 * ÚNICA acción de escritura que también puede hacer el MENSAJERO, y por eso es
 * la única que NO usa el cliente de la sesión: la RLS de Postgres no puede
 * restringir por columna, así que no hay forma de escribir una policy que diga
 * "el mensajero puede UPDATE, pero solo costo_envio". La policy le niega al
 * mensajero todo UPDATE sobre pedidos, y esta escritura puntual va por
 * service-role detrás del gate explícito de `envio.escribir`.
 */
export async function actualizarCostoEnvioPedido(
    id: number,
    nuevoCostoEnvio: number
) {
    const sesion = await exigirPermiso('envio.escribir')

    try {
        const { error } = await supabaseAdmin
            .from("pedidos")
            .update({ costo_envio: nuevoCostoEnvio })
            .eq("id", id)

        if (error) throw new Error(`Error al actualizar costo de envío: ${error.message}`)

        registrarActividad(sesion, 'pedido.costo_envio', {
            pedidoId: id,
            detalle: { costo: nuevoCostoEnvio },
        })
        revalidatePath('/')
        updateTag(PEDIDOS_TAG)
        return { success: true }
    } catch (error) {
        console.error("Error al actualizar costo de envío:", error)
        throw error
    }
}

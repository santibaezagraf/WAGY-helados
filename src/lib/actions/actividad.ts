'use server'

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { exigirPermiso } from '@/lib/auth-rol'
import { normalizarRol, nombreDeMail, type Rol } from '@/lib/rol'
import { armarTextoActividad, type FilaActividad } from '@/lib/actividad-texto'

/**
 * Lecturas de la actividad de los usuarios: alimentan el ranking, el heatmap y
 * el historial de /perfil. TODAS exigen `actividad.ver` (solo admin): el
 * mensajero no ve la actividad de nadie, ni la propia.
 *
 * Cliente service-role SIN tipar, mismo criterio que alertas.ts / conversaciones.ts:
 * mientras la migración de roles no esté aplicada en TODAS las bases, un
 * `update-types` contra una que no la tenga borraría `actividad_usuario` y sus
 * RPCs de los tipos y rompería el build.
 * El gate de la action es la ÚNICA protección acá (service-role bypassea RLS).
 */
const supabaseAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
)

const PAGINA_HISTORIAL = 30

export type FilaRanking = {
    usuarioId: string
    nombre: string
    acciones: number
    /** Pedidos realmente tocados: una acción masiva cuenta 1 arriba y N acá. */
    pedidosTocados: number
    /** Porcentaje sobre el total de acciones del período (0-100). */
    porcentaje: number
}

export type DiaActividad = {
    /** YYYY-MM-DD en calendario argentino (la RPC ya convierte el huso). */
    dia: string
    acciones: number
}

export type EntradaHistorial = {
    id: number
    nombre: string
    texto: string
    createdAt: string
}

export type UsuarioResumen = {
    id: string
    nombre: string
    rol: Rol
    ultimaConexion: string | null
}

/**
 * Ranking de acciones del período. El porcentaje se calcula acá (y no en SQL)
 * para que sume exactamente 100 entre los que aparecen.
 */
export async function getRankingActividad(
    desdeISO: string,
    hastaISO: string,
): Promise<FilaRanking[]> {
    await exigirPermiso('actividad.ver')

    const { data, error } = await supabaseAdmin.rpc('obtener_ranking_actividad', {
        desde: desdeISO,
        hasta: hastaISO,
    })
    if (error) {
        console.error('⚠️ No se pudo leer el ranking de actividad:', error.message)
        return []
    }

    const filas = (data ?? []) as {
        usuario_id: string
        usuario_nombre: string
        acciones: number
        pedidos_tocados: number
    }[]

    const total = filas.reduce((acc, f) => acc + Number(f.acciones), 0)

    return filas.map((f) => ({
        usuarioId: f.usuario_id,
        nombre: f.usuario_nombre,
        acciones: Number(f.acciones),
        pedidosTocados: Number(f.pedidos_tocados),
        porcentaje: total > 0 ? Math.round((Number(f.acciones) / total) * 100) : 0,
    }))
}

/**
 * Acciones por día para el heatmap. `usuarioId` opcional para filtrar a uno.
 * La agrupación por día argentino la hace la RPC (ver la migración): agrupar en
 * UTC correría los cuadraditos un día para todo lo hecho después de las 21:00.
 */
export async function getActividadPorDia(
    desdeISO: string,
    hastaISO: string,
    nombreUsuario?: string,
): Promise<DiaActividad[]> {
    await exigirPermiso('actividad.ver')

    const { data, error } = await supabaseAdmin.rpc('obtener_actividad_por_dia', {
        desde: desdeISO,
        hasta: hastaISO,
    })
    if (error) {
        console.error('⚠️ No se pudo leer la actividad por día:', error.message)
        return []
    }

    const filas = (data ?? []) as { dia: string; usuario_nombre: string; acciones: number }[]
    const porDia = new Map<string, number>()
    for (const f of filas) {
        if (nombreUsuario && f.usuario_nombre !== nombreUsuario) continue
        porDia.set(f.dia, (porDia.get(f.dia) ?? 0) + Number(f.acciones))
    }

    return [...porDia.entries()]
        .map(([dia, acciones]) => ({ dia, acciones }))
        .sort((a, b) => a.dia.localeCompare(b.dia))
}

/** Últimas actividades, paginadas. El texto se arma con el helper puro. */
export async function getHistorialActividad(page = 1): Promise<{
    items: EntradaHistorial[]
    hayMas: boolean
}> {
    await exigirPermiso('actividad.ver')

    const pageNum = Math.max(1, page)
    const from = (pageNum - 1) * PAGINA_HISTORIAL
    // Pedimos uno de más para saber si hay página siguiente sin un count caro.
    const to = from + PAGINA_HISTORIAL

    const { data, error } = await supabaseAdmin
        .from('actividad_usuario')
        .select('id, usuario_nombre, accion, cantidad, pedido_id, detalle, created_at')
        .order('created_at', { ascending: false })
        .range(from, to)

    if (error) {
        console.error('⚠️ No se pudo leer el historial de actividad:', error.message)
        return { items: [], hayMas: false }
    }

    const filas = (data ?? []) as {
        id: number
        usuario_nombre: string
        accion: string
        cantidad: number
        pedido_id: number | null
        detalle: Record<string, unknown> | null
        created_at: string
    }[]

    const hayMas = filas.length > PAGINA_HISTORIAL
    const visibles = hayMas ? filas.slice(0, PAGINA_HISTORIAL) : filas

    return {
        items: visibles.map((f) => {
            const fila: FilaActividad = {
                id: f.id,
                usuarioNombre: f.usuario_nombre,
                accion: f.accion,
                cantidad: f.cantidad,
                pedidoId: f.pedido_id,
                detalle: f.detalle,
                createdAt: f.created_at,
            }
            return {
                id: f.id,
                nombre: f.usuario_nombre,
                texto: armarTextoActividad(fila),
                createdAt: f.created_at,
            }
        }),
        hayMas,
    }
}

/**
 * Usuarios del sistema con su última conexión.
 *
 * `last_sign_in_at` lo mantiene Supabase solo: no hace falta registrarlo. Es
 * todo lo que se muestra del mensajero — sin métricas ni historial.
 */
export async function getUsuariosResumen(): Promise<UsuarioResumen[]> {
    await exigirPermiso('actividad.ver')

    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 })
    if (error) {
        console.error('⚠️ No se pudieron listar los usuarios:', error.message)
        return []
    }

    return (data?.users ?? [])
        .map((u) => ({
            id: u.id,
            nombre: nombreDeMail(u.email),
            rol: normalizarRol((u.app_metadata as { rol?: unknown } | null)?.rol),
            ultimaConexion: u.last_sign_in_at ?? null,
        }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre))
}

import { unstable_cache } from 'next/cache'
import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/supabase'

// Cliente service-role server-only (igual que el bot). El listado es el mismo
// para todo el staff y la página ya valida getUser() antes de llamar acá, así
// que la lectura no necesita la sesión del usuario; usar el cliente ligado a
// cookies es imposible dentro de unstable_cache (no se puede leer cookies ahí).
const supabaseAdmin = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Cliente service-role SIN el genérico <Database>: para la RPC
// `obtener_contadores_helados`. Va sin tipar a propósito aunque los tipos ya la
// incluyan — mientras la migración de roles no esté aplicada en TODAS las bases,
// un `update-types` corrido contra una que no la tenga borraría la RPC de los
// tipos y rompería el build. Sin el genérico, compila igual.
const supabaseAdminSinTipar = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** Tag para invalidar el cache del listado desde las server actions. */
export const PEDIDOS_TAG = 'pedidos'

export type FiltrosPedidos = {
    estado: string[]
    /** booleano único cuando el filtro tiene un solo valor seleccionado; null = no filtrar */
    pagado: boolean | null
    mensaje_enviado: boolean | null
    direccion: string | null
    telefono: string | null
    /** límite inferior temporal ya resuelto a ISO (inicio del día/semana/mes); null = sin filtro */
    fechaDesdeISO: string | null
    /** límite superior temporal exclusivo ya resuelto a ISO (inicio del período siguiente); null = sin filtro */
    fechaHastaISO: string | null
    from: number
    to: number
}

export type PedidosListado = {
    pedidos: Database['public']['Tables']['pedidos']['Row'][]
    count: number
}

/**
 * Fetch del listado de pedidos cacheado por filtros.
 *
 * Los argumentos (el objeto `filtros`) forman parte de la clave de cache de
 * unstable_cache, así que cada combinación de filtros/paginación tiene su
 * propia entrada. `fechaDesdeISO` se resuelve afuera (en la página) para que la
 * función sea pura: el valor es estable dentro del día/semana/mes, por lo que
 * la clave solo cambia al cruzar ese borde.
 *
 * revalidate: 30 → un pedido creado por el bot (que escribe directo en Supabase,
 * por fuera de Next, y no dispara revalidateTag) aparece en ≤30s. Las ediciones
 * del dashboard invalidan al instante vía revalidateTag(PEDIDOS_TAG).
 */
export const getPedidosListado = unstable_cache(
    async (filtros: FiltrosPedidos): Promise<PedidosListado> => {
        let query = supabaseAdmin
            .from('pedidos')
            .select('*', { count: 'exact' })
            // Por fecha_entrega y no por created_at: la pantalla se usa para ver
            // QUÉ HAY QUE REPARTIR en el período, y un pedido programado se
            // entrega otro día del que se cargó. Ver lib/entrega.ts.
            .order('fecha_entrega', { ascending: false })

        if (filtros.estado.length > 0) {
            query = query.in('estado', filtros.estado)
        }
        if (filtros.pagado !== null) {
            query = query.eq('pagado', filtros.pagado)
        }
        if (filtros.mensaje_enviado !== null) {
            query = query.eq('mensaje_enviado', filtros.mensaje_enviado)
        }
        if (filtros.direccion) {
            query = query.ilike('direccion', `%${filtros.direccion}%`)
        }
        if (filtros.telefono) {
            query = query.ilike('telefono', `%${filtros.telefono}%`)
        }
        if (filtros.fechaDesdeISO) {
            query = query.gte('fecha_entrega', filtros.fechaDesdeISO)
        }
        if (filtros.fechaHastaISO) {
            query = query.lt('fecha_entrega', filtros.fechaHastaISO)
        }

        const { data, error, count } = await query.range(filtros.from, filtros.to)

        // Lanzamos en vez de retornar el error: así un fallo no queda cacheado.
        if (error) throw new Error(error.message)

        return { pedidos: data ?? [], count: count ?? 0 }
    },
    ['pedidos-listado'],
    { revalidate: 30, tags: [PEDIDOS_TAG] }
)

/**
 * Última `fecha_entrega` cargada (ISO), o null si no hay pedidos.
 *
 * Es lo que deja navegar el listado hacia adelante: sin esto la flecha se
 * apagaba en el período actual, y un pedido programado para la semana que viene
 * quedaba inalcanzable. Ver `puedeAvanzar` en periodo-utils.ts.
 *
 * Excluye cancelados a propósito: un pedido que se dio de baja no debería
 * habilitar semanas enteras de navegación vacía.
 *
 * Fail-soft: ante error devuelve null y la navegación queda como antes (hasta
 * hoy), que es el comportamiento seguro.
 */
export const getMaxFechaEntrega = unstable_cache(
    async (): Promise<string | null> => {
        const { data, error } = await supabaseAdmin
            .from('pedidos')
            .select('fecha_entrega')
            .neq('estado', 'cancelado')
            .order('fecha_entrega', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (error) {
            console.error('⚠️ No se pudo leer la última fecha de entrega:', error.message)
            return null
        }
        return data?.fecha_entrega ?? null
    },
    ['pedidos-max-entrega'],
    { revalidate: 30, tags: [PEDIDOS_TAG] }
)

/** Filtros de los contadores: los mismos del listado menos pagado/mensaje_enviado. */
export type FiltrosContadores = Pick<
    FiltrosPedidos,
    'estado' | 'direccion' | 'telefono' | 'fechaDesdeISO' | 'fechaHastaISO'
>

export type ContadoresHelados = {
    /** Helados (agua + crema) del período filtrado. */
    total: number
    /** Los que ya salieron. */
    entregados: number
    /** total - entregados. */
    faltan: number
}

/**
 * Contadores de helados del header, sobre TODO el conjunto filtrado (no sobre
 * la página que se ve).
 *
 * Agrega en Postgres vía RPC en vez de sumar acá: un select sin agregar tiene el
 * tope de 1000 filas de PostgREST, así que con periodo='todos' se cortaría en
 * silencio y los números darían mal SIN ningún error.
 *
 * NO aplica los filtros pagado/mensaje_enviado del listado a propósito: filtrar
 * por `mensaje_enviado` dejaría uno de los dos buckets siempre en cero, que es justo la
 * partición que los contadores muestran. Sí respeta `estado`, porque el default
 * del listado excluye borradores y cancelados, y si no los números no cuadrarían
 * con la tabla de abajo.
 *
 * Fail-soft: ante error devuelve ceros. Son informativos; no vale romper el
 * dashboard entero por ellos.
 */
export const getContadoresHelados = unstable_cache(
    async (filtros: FiltrosContadores): Promise<ContadoresHelados> => {
        const { data, error } = await supabaseAdminSinTipar.rpc('obtener_contadores_helados', {
            fecha_desde: filtros.fechaDesdeISO,
            fecha_hasta: filtros.fechaHastaISO,
            estados: filtros.estado.length > 0 ? filtros.estado : null,
            direccion_filtro: filtros.direccion,
            telefono_filtro: filtros.telefono,
        })

        if (error) {
            console.error('⚠️ No se pudieron leer los contadores de helados:', error.message)
            return { total: 0, entregados: 0, faltan: 0 }
        }

        const fila = (Array.isArray(data) ? data[0] : data) as
            | { total: number | null; entregados: number | null }
            | undefined
        const total = Number(fila?.total ?? 0)
        const entregados = Number(fila?.entregados ?? 0)
        return { total, entregados, faltan: Math.max(0, total - entregados) }
    },
    ['pedidos-contadores'],
    { revalidate: 30, tags: [PEDIDOS_TAG] }
)

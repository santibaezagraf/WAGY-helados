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

/** Tag para invalidar el cache del listado desde las server actions. */
export const PEDIDOS_TAG = 'pedidos'

export type FiltrosPedidos = {
    estado: string[]
    /** booleano único cuando el filtro tiene un solo valor seleccionado; null = no filtrar */
    pagado: boolean | null
    enviado: boolean | null
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
            .order('created_at', { ascending: false })

        if (filtros.estado.length > 0) {
            query = query.in('estado', filtros.estado)
        }
        if (filtros.pagado !== null) {
            query = query.eq('pagado', filtros.pagado)
        }
        if (filtros.enviado !== null) {
            query = query.eq('enviado', filtros.enviado)
        }
        if (filtros.direccion) {
            query = query.ilike('direccion', `%${filtros.direccion}%`)
        }
        if (filtros.telefono) {
            query = query.ilike('telefono', `%${filtros.telefono}%`)
        }
        if (filtros.fechaDesdeISO) {
            query = query.gte('created_at', filtros.fechaDesdeISO)
        }
        if (filtros.fechaHastaISO) {
            query = query.lt('created_at', filtros.fechaHastaISO)
        }

        const { data, error, count } = await query.range(filtros.from, filtros.to)

        // Lanzamos en vez de retornar el error: así un fallo no queda cacheado.
        if (error) throw new Error(error.message)

        return { pedidos: data ?? [], count: count ?? 0 }
    },
    ['pedidos-listado'],
    { revalidate: 30, tags: [PEDIDOS_TAG] }
)

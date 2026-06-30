import { createClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import { DataTable } from '@/components/pedidos/data-table'
import { Header } from '@/components/ui/header'
import { getPedidosListado } from '@/lib/data/pedidos-listado'
import { getConversacionesRecientes } from '@/lib/actions/mensajes'
import { type Conversacion } from '@/lib/conversaciones-utils'
import { parseAncla, inicioPeriodo, finPeriodo, type Periodo } from '@/lib/periodo-utils'


export default async function Home({
    searchParams,
}: {
    searchParams: Promise<{
        limit?: string, 
        page?: string, 
        estado?: string, 
        pagado?: string, 
        enviado? :string, 
        periodo?: string,
        ancla?: string,
        direccion?: string,
        telefono?: string,
    }>
}) {
    const supabase = await createClient();

    const  {data: { user } } = await supabase.auth.getUser();

    if (!user) {
        redirect('/login')
    }

    const params = await searchParams;
    const page = Math.max(1, parseInt(params.page || '1'))
    // const pageSize = Math.max(1, parseInt(params.limit || '20'))
    const pageSize = Math.min(Number(params.limit) || 20, 50)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    // Filtros de la URL
    const estado = params.estado ? params.estado.split(',') : ["pendiente", "enviado"]
    const pagado = params.pagado ? params.pagado.split(',').map(p => p === 'true') : [true, false]
    const enviado = params.enviado ? params.enviado.split(',').map(e => e === 'true') : [true, false]
    const periodo = (params.periodo as Periodo) || 'semana'
    const direccion = params.direccion || null
    const telefono = params.telefono || null

    // Resolvemos el borde temporal acá (fuera del cache) para que la función
    // cacheada sea pura: estos ISO son estables dentro del período anclado, así
    // que la clave de cache solo cambia al navegar a otro día/semana/mes (o al
    // cruzar el borde del período actual).
    let fechaDesdeISO: string | null = null
    let fechaHastaISO: string | null = null
    if (periodo !== 'todos') {
        const ancla = parseAncla(params.ancla)
        fechaDesdeISO = inicioPeriodo(periodo, ancla).toISOString()
        fechaHastaISO = finPeriodo(periodo, ancla).toISOString()
    }

    let pedidos
    let count
    try {
        ({ pedidos, count } = await getPedidosListado({
            estado,
            pagado: pagado.length === 1 ? pagado[0] : null,
            enviado: enviado.length === 1 ? enviado[0] : null,
            direccion,
            telefono,
            fechaDesdeISO,
            fechaHastaISO,
            from,
            to,
        }))
    } catch (error) {
        return (
            <div>Error al cargar los pedidos: {error instanceof Error ? error.message : 'error desconocido'}</div>
        );
    }

    const pageCount = count ? Math.ceil(count / pageSize) : 0;

    // Conversaciones recientes (para el menú de chats del header) + de ahí
    // derivamos qué teléfonos esperan intervención (badge en la tabla). Se trae
    // acá (fuera del cache de getPedidosListado) porque cambia más seguido y no
    // debe quedar pegado a la entrada cacheada de los pedidos.
    let conversaciones: Conversacion[] = []
    try {
        conversaciones = await getConversacionesRecientes()
    } catch {
        // Si falla, simplemente no mostramos avisos; no rompemos el listado.
    }
    const telefonosRequierenAtencion = conversaciones
        .filter((c) => c.requiereAtencion)
        .map((c) => c.telefono)

    return (
        <div className="flex h-screen flex-col overflow-hidden">
            <Header conversacionesIniciales={conversaciones} />
            <main className="flex flex-1 min-h-0 flex-col px-3 py-3 sm:px-5 lg:px-6 bg-slate-50">
                <DataTable
                    data={pedidos || []}
                    pageIndex={page - 1}
                    pageSize={pageSize}
                    pageCount={pageCount}
                    rowCount={pedidos ? pedidos.length : 0}
                    telefonosRequierenAtencion={telefonosRequierenAtencion}
                />
            </main>
        </div>
    )
}
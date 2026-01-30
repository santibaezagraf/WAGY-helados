import { createClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import { DataTable } from '@/components/pedidos/data-table'
import { Header } from '@/components/ui/header'


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
    const periodo = (params.periodo as 'dia' | 'semana' | 'mes' | 'todos') || 'semana'
    const direccion = params.direccion || null
    const telefono = params.telefono || null

    let query = supabase
        .from('pedidos')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        
    // Aplicar filtros a la query
    if (estado.length > 0) {
        query = query.in('estado', estado)
    }
    if (pagado.length === 1) {
        query = query.eq('pagado', pagado[0])
    }
    if (enviado.length === 1) {
        query = query.eq('enviado', enviado[0])
    }
    if (direccion) {
        query = query.ilike('direccion', `%${direccion}%`)
    }
    if (telefono) {
        query = query.ilike('telefono', `%${telefono}%`)
    }

    // Filtro temporal
    if (periodo !== 'todos') {
        const ahora = new Date()
        let fecha: Date

        if (periodo === 'dia') {
            fecha = new Date(ahora)
            fecha.setHours(0, 0, 0, 0)
        } else if (periodo === 'semana') {
            const dayOfWeek = ahora.getDay()
            fecha = new Date(ahora)
            fecha.setDate(ahora.getDate() - dayOfWeek)
            fecha.setHours(0, 0, 0, 0)
        } else { // 'mes'
            fecha = new Date(ahora.getFullYear(), ahora.getMonth(), 1)
            fecha.setHours(0, 0, 0, 0)
        }

        query = query.gte('created_at', fecha.toISOString())
    }

    const { data: pedidos, error, count } = await query.range(from, to)

    if (error) {
        return ( 
            <div>Error al cargar los pedidos: {error.message}</div>
        );
    }

    const pageCount = count ? Math.ceil(count / pageSize) : 0;

    return (
        <div className="flex min-h-screen flex-col">
            <Header />
            <main className="flex-1 p-6 sm:p-8 lg:p-12 bg-slate-50">
                <div className="max-w-7xl mx-auto">
                    <DataTable 
                        data={pedidos || []} 
                        pageIndex={page - 1} 
                        pageSize={pageSize} 
                        pageCount={pageCount}
                        rowCount={pedidos ? pedidos.length : 0}
                    />
                </div>
            </main>
        </div>
    )
}
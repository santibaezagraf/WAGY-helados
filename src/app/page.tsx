import { redirect } from 'next/navigation'
import { DataTable } from '@/components/pedidos/data-table'
import { Header } from '@/components/ui/header'
import { getPedidosListado, getContadoresHelados, getMaxFechaEntrega } from '@/lib/data/pedidos-listado'
import { getConversacionesRecientes } from '@/lib/actions/mensajes'
import { type Conversacion } from '@/lib/conversaciones-utils'
import { parseAncla, inicioPeriodo, finPeriodo, type Periodo } from '@/lib/periodo-utils'
import { sesionActual } from '@/lib/auth-rol'
import { puede } from '@/lib/rol'


export default async function Home({
    searchParams,
}: {
    searchParams: Promise<{
        limit?: string, 
        page?: string, 
        estado?: string,
        pagado?: string,
        mensaje_enviado?: string,
        periodo?: string,
        ancla?: string,
        direccion?: string,
        telefono?: string,
    }>
}) {
    const sesion = await sesionActual();

    if (!sesion) {
        redirect('/login')
    }

    const esAdmin = puede(sesion.rol, 'pedidos.escribir')

    const params = await searchParams;
    const page = Math.max(1, parseInt(params.page || '1'))
    // const pageSize = Math.max(1, parseInt(params.limit || '20'))
    const pageSize = Math.min(Number(params.limit) || 20, 50)
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    // Filtros de la URL
    const estado = params.estado ? params.estado.split(',') : ["pendiente", "enviado"]
    const pagado = params.pagado ? params.pagado.split(',').map(p => p === 'true') : [true, false]
    const mensajeEnviado = params.mensaje_enviado ? params.mensaje_enviado.split(',').map(e => e === 'true') : [true, false]
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
            mensaje_enviado: mensajeEnviado.length === 1 ? mensajeEnviado[0] : null,
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
    if (esAdmin) {
        try {
            conversaciones = await getConversacionesRecientes()
        } catch {
            // Si falla, simplemente no mostramos avisos; no rompemos el listado.
        }
    }

    // Contadores del período, sobre TODO el conjunto filtrado (no la página).
    // Sin los toggles pagado/mensaje_enviado: filtrar por `mensaje_enviado`
    // dejaría uno de los buckets siempre en cero. Ver getContadoresHelados.
    const contadores = await getContadoresHelados({
        estado,
        direccion,
        telefono,
        fechaDesdeISO,
        fechaHastaISO,
    })

    // Hasta dónde deja avanzar el navegador temporal: con pedidos programados el
    // futuro ya no está vacío y el tope no puede ser "hoy".
    const maxFechaEntregaISO = await getMaxFechaEntrega()
    const telefonosRequierenAtencion = conversaciones
        .filter((c) => c.requiereAtencion)
        .map((c) => c.telefono)
    // Subconjunto pausado por el rate-limit anti-DoS: aviso distinto del
    // genérico "requiere intervención humana" (ver columns.tsx).
    const telefonosRateLimit = conversaciones
        .filter((c) => c.motivoAtencion === "rate_limit")
        .map((c) => c.telefono)

    return (
        <div className="flex min-h-screen flex-col">
            <Header conversacionesIniciales={conversaciones} rol={sesion.rol} contadores={contadores} />
            <main className="flex flex-1 flex-col px-3 py-3 sm:px-5 lg:px-6 bg-slate-50">
                <DataTable
                    data={pedidos || []}
                    pageIndex={page - 1}
                    pageSize={pageSize}
                    pageCount={pageCount}
                    rowCount={pedidos ? pedidos.length : 0}
                    telefonosRequierenAtencion={telefonosRequierenAtencion}
                    telefonosRateLimit={telefonosRateLimit}
                    soloLectura={!esAdmin}
                    maxFechaEntregaISO={maxFechaEntregaISO}
                />
            </main>
        </div>
    )
}
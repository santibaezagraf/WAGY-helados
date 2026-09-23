/**
 * Vocabulario de acciones registradas y armado del texto del historial de
 * /perfil. Módulo PURO (sin I/O) para poder testearlo: la escritura vive en
 * actividad.ts y la lectura en actions/actividad.ts.
 */

export type AccionActividad =
    | 'pedido.crear'
    | 'pedido.editar'
    | 'pedido.estado'
    | 'pedido.pago'
    | 'pedido.enviar'
    | 'pedido.costo_envio'
    | 'gasto.registrar'
    | 'gasto.eliminar'

/** Fila de actividad tal como la devuelve la consulta del historial. */
export type FilaActividad = {
    id: number
    usuarioNombre: string
    accion: string
    cantidad: number
    pedidoId: number | null
    detalle: Record<string, unknown> | null
    createdAt: string
}

/** "1 pedido" / "20 pedidos" — el plural se equivoca seguido, así que va testeado. */
function pluralPedidos(n: number): string {
    return n === 1 ? '1 pedido' : `${n} pedidos`
}

/** Referencia al pedido: "el pedido #412", o la cantidad si fue masiva. */
function referencia(fila: FilaActividad): string {
    if (fila.pedidoId != null) return `el pedido #${fila.pedidoId}`
    return pluralPedidos(fila.cantidad)
}

/** Igual que `referencia` pero precedida de "de", contrayendo "de el" -> "del". */
function referenciaDe(fila: FilaActividad): string {
    if (fila.pedidoId != null) return `del pedido #${fila.pedidoId}`
    return `de ${pluralPedidos(fila.cantidad)}`
}

/**
 * Si la referencia es plural, los adjetivos que la acompañan tienen que
 * concordar: "20 pedidos como enviadOS" vs "el pedido #9 como enviadO".
 */
function esPlural(fila: FilaActividad): boolean {
    return fila.pedidoId == null && fila.cantidad !== 1
}

/** Concuerda un adjetivo en número con la referencia de la fila. */
function concordar(fila: FilaActividad, adjetivo: string): string {
    return esPlural(fila) ? `${adjetivo}s` : adjetivo
}

function texto(detalle: Record<string, unknown> | null, clave: string): string | null {
    const v = detalle?.[clave]
    return typeof v === 'string' && v.length > 0 ? v : null
}

function numero(detalle: Record<string, unknown> | null, clave: string): number | null {
    const v = detalle?.[clave]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Una línea del historial, en pasado y sin el nombre del usuario adelante (la UI
 * lo muestra aparte). Devuelve algo legible incluso para una acción desconocida:
 * el historial es informativo, nunca debe romper la pantalla por un dato viejo.
 */
export function armarTextoActividad(fila: FilaActividad): string {
    switch (fila.accion) {
        case 'pedido.crear':
            return `cargó ${referencia(fila)}`

        case 'pedido.editar':
            return `editó ${referencia(fila)}`

        case 'pedido.estado': {
            const estado = texto(fila.detalle, 'estado')
            return estado
                ? `cambió ${referencia(fila)} a "${estado}"`
                : `cambió el estado ${referenciaDe(fila)}`
        }

        case 'pedido.pago': {
            const pagado = fila.detalle?.pagado
            if (pagado === true) return `marcó ${referencia(fila)} como ${concordar(fila, 'pagado')}`
            if (pagado === false) return `marcó ${referencia(fila)} como no ${concordar(fila, 'pagado')}`
            return `cambió el pago ${referenciaDe(fila)}`
        }

        case 'pedido.enviar': {
            const enviado = fila.detalle?.enviado
            const adj = concordar(fila, 'enviado')
            if (enviado === false) return `desmarcó ${referencia(fila)} como ${adj}`
            return `marcó ${referencia(fila)} como ${adj}`
        }

        case 'pedido.costo_envio': {
            const costo = numero(fila.detalle, 'costo')
            return costo != null
                ? `puso el envío ${referenciaDe(fila)} en $${costo.toLocaleString('es-AR')}`
                : `cambió el costo de envío ${referenciaDe(fila)}`
        }

        case 'gasto.registrar': {
            const monto = numero(fila.detalle, 'monto')
            const concepto = texto(fila.detalle, 'concepto')
            const base = monto != null
                ? `registró un gasto de $${monto.toLocaleString('es-AR')}`
                : 'registró un gasto'
            return concepto ? `${base} (${concepto})` : base
        }

        case 'gasto.eliminar':
            return 'eliminó un gasto'

        default:
            // Acción desconocida (fila vieja, o de una versión más nueva).
            return fila.accion
    }
}

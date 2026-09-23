"use client"

import * as React from "react"
import { ColumnDef, Row } from "@tanstack/react-table"
import { Pedido } from "@/types/pedidos"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { TruncatedText } from "@/components/ui/truncated-text"
import { ArrowUpDown, MoreHorizontal, Check, X, Clock, Copy, Edit, MessageCircle, Paperclip, ShieldAlert } from "lucide-react"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { crearMensajeWpp } from "@/lib/mensaje-utils"
import {
    actualizarEstadoPedido,
    actualizarPagadoPedido,
    actualizarEnviadoPedido,
} from "@/lib/actions/pedidos"
import { useRouter } from "next/navigation"
import { formatearFechaAR, formatearHoraAR } from "@/lib/zona-horaria"
import { esPedidoProgramado } from "@/lib/entrega"

export const createColumns = (config: {
    editingOrderId: number | null
    setEditingOrderId: (id: number | null) => void
    editingCostoId: number | null
    setEditingCostoId: (id: number | null) => void
    chattingOrderId: number | null
    setChattingOrderId: (id: number | null) => void
    onRowSelect: (row: Row<Pedido>, event: React.MouseEvent<HTMLButtonElement>) => void
    /** Teléfonos que esperan intervención humana (mandaron un media/ubicación, o una
     *  consulta que el bot no pudo responder). */
    telefonosAtencion: Set<string>
    /** Teléfonos pausados por el rate-limit anti-DoS (>=40 msj/hora) — aviso distinto. */
    telefonosRateLimit: Set<string>
    /** Mensajero: se sacan la selección y el menú de acciones. El costo de envío
     *  sigue siendo editable — es su única escritura permitida. */
    soloLectura?: boolean
}): ColumnDef<Pedido>[] => ([
    {
        id: "select",
        header: ({ table }) => (
            <Checkbox
                checked={
                    table.getIsAllPageRowsSelected() ||
                    (table.getIsSomePageRowsSelected() && "indeterminate")
                }
                onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
                aria-label="Seleccionar todos"
            />
        ),
        cell: ({ row }) => (
            <Checkbox
                checked={row.getIsSelected()}
                onClick={(event) => config.onRowSelect(row, event)}
                aria-label="Seleccionar fila"
            />
        ),
        enableSorting: false,
        enableHiding: false,
    },
    {
        accessorKey: "direccion",
        header: "Dirección",
        cell: ({ row }) => {
            const direccion = row.getValue("direccion") as string
            return <TruncatedText text={direccion} maxLength={25} />
        },
    },
    {
        accessorKey: "telefono",
        header: "Teléfono",
        cell: ({ row }) => {
            const telefono = row.getValue("telefono") as string
            const enRateLimit = config.telefonosRateLimit.has(telefono)
            const requiereAtencion = config.telefonosAtencion.has(telefono)
            return (
                <div className="flex items-center gap-1.5">
                    <span>{telefono}</span>
                    {enRateLimit ? (
                        <span
                            title="Alcanzó el límite de mensajes por hora — el bot se pausó automáticamente"
                            className="inline-flex items-center gap-1 rounded-full bg-orange-100 text-orange-700 px-1.5 py-0.5 text-[10px] font-medium"
                        >
                            <ShieldAlert className="h-3 w-3" />
                        </span>
                    ) : requiereAtencion && (
                        <span
                            title="Mandó un archivo o ubicación, o hizo una consulta — requiere intervención humana"
                            className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 px-1.5 py-0.5 text-[10px] font-medium"
                        >
                            <Paperclip className="h-3 w-3" />
                        </span>
                    )}
                </div>
            )
        },
    },
    {
        id: "costo_envio_mobile",
        accessorFn: (row) => row.costo_envio,
        header: () => <span className="md:hidden">Costo de Envío</span>,
        cell: ({ row }) => {
            // Leemos de row.original y no de getValue("costo_envio"): eso apuntaba
            // a la OTRA columna (la de desktop) y devolvería undefined si algún
            // día se la oculta.
            const costo_envio = row.original.costo_envio ?? 0
            const formatted = new Intl.NumberFormat("es-AR", {
                style: "currency",
                currency: "ARS",
            }).format(costo_envio)

            return (
                <Button 
                    variant="link" 
                    className="md:hidden"
                    onClick={() => config.setEditingCostoId(row.original.id)}
                >
                    {formatted}
                </Button>
            )
        },
        meta: {
            className: "md:hidden"
        }
    },
    {
        accessorKey: "observaciones",
        header: "Observaciones",
        cell: ({ row }) => {
            const observaciones = row.getValue("observaciones") as string
            return <TruncatedText text={observaciones} maxLength={25} />
        },
    },
    {
        accessorKey: "cantidad_agua",
        // header: ({ column }) => {
        //     return (
        //         <Button
        //             variant="ghost"
        //             onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        //         >
        //             Helados Agua
        //         <ArrowUpDown className="ml-2 h-4 w-4" />
        //         </Button>
        //     )
        // },
        header: "Cant. Agua",
    },
    {
        accessorKey: "cantidad_crema",
        // header: ({ column }) => {
        //     return (
        //         <Button
        //             variant="ghost"
        //             onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        //         >
        //             Helados Crema
        //         <ArrowUpDown className="ml-2 h-4 w-4" />
        //         </Button>
        //     )
        // },
        header: "Cant. Crema",
    },
    {
        accessorKey: "metodo_pago",
        header: "Método de Pago",
        cell: ({ row }) => {
            const metodo = row.getValue("metodo_pago") as string
            return <span className="capitalize">{metodo}</span>
        },
    },
    {
        accessorKey: "estado",
        header: "Estado",
        cell: ({ row }) => {
            const estado = row.getValue("estado") as string
            const variant = 
                    estado === "enviado" ? "success" :
                    estado === "pendiente" ? "secondary" :
                    "destructive"
            
            return (
                <Badge variant={variant} className="capitalize">
                    {estado}
                </Badge>
            )

        },
    },
    {
        accessorKey: "pagado",
        header: "Pagado",
        cell: ({ row }) => {
            const pagado = row.getValue("pagado") as boolean
            return (
                <div className="flex items-center justify-center">
                    <Badge 
                        variant="outline"
                        className={`flex items-center justify-center w-8 h-6 ${pagado ? 'bg-green-100' : 'bg-red-100'}`}
                    >
                        {pagado ? <Check className="text-green-600 h-6 w-6 stroke-[5]" /> : <X className="text-red-600 h-6 w-6 stroke-[5]" />}
                    </Badge>
                </div>
            )
        },
    },
    {
        accessorKey: "precio_total",
        header: "Precio",
        cell: ({ row }) => {
            const precio = parseFloat(row.getValue("precio_total") || "0")
            const formatted = new Intl.NumberFormat("es-AR", {
                style: "currency",
                currency: "ARS",
            }).format(precio)
            // Aviso: el pedido tenía precio manual y el cliente cambió las
            // cantidades por WhatsApp. El trigger retarifó con la lista (se
            // perdió el override); mostramos el ícono para que el operador
            // revise y decida si vuelve a ponerlo. Se limpia al editar el
            // pedido desde el modal (actualizarPedidoCompleto).
            const avisoPrecio = row.original.aviso_precio_sobreescrito
            return (
                <div className="font-medium flex items-center gap-1.5">
                    {formatted}
                    {avisoPrecio && (
                        <span
                            className="text-amber-600"
                            title="Este pedido tenía precio manual y se retarifó porque cambiaron las cantidades. Revisalo."
                            aria-label="Revisar precio: cambió la cantidad y se perdió el precio manual."
                        >
                            ⚠️
                        </span>
                    )}
                </div>
            )
        }
    },
    {
        accessorKey: "costo_envio",
        header: () => <span className="hidden md:inline">Costo de Envío</span>,
        // Editable también en desktop: antes solo se podía tocar desde la celda
        // móvil o abriendo el modal completo del pedido. El mensajero, cuyo
        // ÚNICO permiso de escritura es este, trabaja sobre todo en desktop.
        cell: ({ row }) => {
            const precio = row.original.costo_envio ?? 0
            const formatted = new Intl.NumberFormat("es-AR", {
                style: "currency",
                currency: "ARS",
            }).format(precio)
            return (
                <Button
                    variant="link"
                    className="hidden md:inline-flex h-auto p-0 font-medium"
                    onClick={() => config.setEditingCostoId(row.original.id)}
                >
                    {formatted}
                </Button>
            )
        },
        meta: {
            className: "hidden md:table-cell"
        }
    },
    {
        accessorKey: "mensaje_enviado",
        header: "Wpp Enviado",
        cell: ({ row }) => {
            const enviado = row.getValue("mensaje_enviado") as boolean
            return (
                <div className="flex items-center justify-center">
                    <Badge 
                        variant="outline"  //{enviado ? "success" : "destructive"}
                        className={`flex items-center justify-center w-8 h-6 ${enviado ? 'bg-green-100' : 'bg-red-100'}`}
                    >
                        {enviado ? <Check className="text-green-600 h-6 w-6 stroke-[5]" /> : <X className="text-red-600 h-6 w-6 stroke-[5]" />}
                    </Badge>
                </div>
            )
        },
    },
    {
        id: "cargado",
        accessorFn: (row) => row.created_at,
        header: () => <span className="hidden md:inline">Cargado</span>,
        // La hora en que ENTRÓ el pedido. Es un dato que no se veía en ninguna
        // parte del listado. Ojo: no es lo mismo que la fecha de ENTREGA, que es
        // por la que la tabla filtra — de ahí el badge "Programado".
        cell: ({ row }) => {
            const creado = new Date(row.original.created_at)
            const programado = esPedidoProgramado(row.original)
            return (
                <div
                    className="hidden md:block text-xs"
                    title={`Cargado el ${formatearFechaAR(creado, { dateStyle: "full" })} a las ${formatearHoraAR(creado)}`}
                >
                    <div className="font-medium tabular-nums text-slate-700">
                        {formatearHoraAR(creado)}
                    </div>
                    <div className="text-[11px] text-slate-400 tabular-nums">
                        {formatearFechaAR(creado, { day: "numeric", month: "short" })}
                    </div>
                    {programado && (
                        <span
                            className="mt-0.5 inline-block rounded bg-violet-100 px-1 py-px text-[10px] font-medium text-violet-700"
                            title={`Programado: se entrega el ${formatearFechaAR(new Date(row.original.fecha_entrega), { day: "numeric", month: "long" })}`}
                        >
                            Programado
                        </span>
                    )}
                </div>
            )
        },
        meta: {
            className: "hidden md:table-cell"
        }
    },
    {
        id: "creado_por",
        accessorFn: (row) => row.creado_por_nombre,
        header: () => <span className="hidden md:inline">Por</span>,
        cell: ({ row }) => {
            const quien = row.original.creado_por_nombre
            const cuando = row.original.enviado_at
            const despacho = row.original.enviado_por_nombre
            return (
                <div
                    className="hidden md:block text-xs text-slate-600"
                    title={
                        despacho
                            ? `Despachado por ${despacho}${cuando ? ` el ${new Date(cuando).toLocaleString("es-AR")}` : ""}`
                            : undefined
                    }
                >
                    {quien ?? "—"}
                    {despacho && <span className="block text-[10px] text-slate-400">↗ {despacho}</span>}
                </div>
            )
        },
        meta: {
            className: "hidden md:table-cell"
        }
    },
    {
        id: "actions",
        cell: ({ row }) => {
            const pedido = row.original
            const router = useRouter()

            const actualizarEstado = React.useCallback(async (nuevoEstado: string) => {
                try {
                    await actualizarEstadoPedido(pedido.id, nuevoEstado)

                } catch (error) {
                    console.error(error)
                    alert("Error al actualizar el estado")
                }
            }, [pedido.id, router])

            const actualizarPagado = React.useCallback(async (pagado: boolean) => {
                try {
                    await actualizarPagadoPedido(pedido.id, pagado)

                } catch (error) {
                    console.error(error)
                    alert("Error al actualizar el estado de pago")
                }
            }, [pedido.id, router])

            const actualizarEnviado = React.useCallback(async (enviado: boolean) => {
                try {
                    await actualizarEnviadoPedido(pedido.id, enviado)

                } catch (error) {
                    console.error(error)
                    alert("Error al actualizar el estado de envío")
                }
            }, [pedido.id, router])

            return (
                <>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-8 w-8 p-0">
                                <span className="sr-only">Abrir menú</span>
                                <MoreHorizontal className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Acciones</DropdownMenuLabel>

                            <DropdownMenuItem onClick={() => config.setEditingOrderId(pedido.id)}>
                                <Edit className="h-4 w-4 mr-2" />
                                Editar
                            </DropdownMenuItem>

                            <DropdownMenuItem onClick={() => config.setChattingOrderId(pedido.id)}>
                                <MessageCircle className="h-4 w-4 mr-2" />
                                Abrir chat
                            </DropdownMenuItem>

                            <DropdownMenuItem
                                onClick={() => {
                                    const mensaje = crearMensajeWpp(pedido)
                                    navigator.clipboard.writeText(mensaje)
                                    actualizarEnviado(true)
                                }}
                            >
                                <Copy className="h-4 w-4 mr-2" />
                                Copiar mensaje
                            </DropdownMenuItem>

                            <DropdownMenuSeparator />

                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>Cambiar estado</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem
                                        onClick={() => actualizarEstado("pendiente")}
                                        disabled={pedido.estado === "pendiente"}
                                        className="gap-2 text-gray-700 hover:text-gray-800 hover:bg-gray-50 focus:bg-gray-50 focus:text-gray-800 data-[disabled]:bg-gray-100"
                                    >
                                        <Clock className="h-4 w-4 text-gray-500" />
                                        Pendiente
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => actualizarEstado("enviado")}
                                        disabled={pedido.estado === "enviado"}
                                        className={`gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800 data-[disabled]:bg-green-50`}
                                    >
                                        <Check className="h-4 w-4" />
                                        Enviado
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => actualizarEstado("cancelado")}
                                        disabled={pedido.estado === "cancelado"}
                                        className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800 data-[disabled]:bg-red-50"
                                    >
                                        <X className="h-4 w-4" />
                                        Cancelado
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>Marcar pago como</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem
                                        onClick={() => actualizarPagado(true)}
                                        disabled={pedido.pagado === true}
                                        className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800"
                                    >
                                        <Check className="h-4 w-4" />
                                        Pagado
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => actualizarPagado(false)}
                                        disabled={pedido.pagado === false}
                                        className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800"
                                    >
                                        <X className="h-4 w-4" />
                                        No pagado
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>Marcar mensaje como</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem
                                        onClick={() => actualizarEnviado(true)}
                                        disabled={pedido.mensaje_enviado === true}
                                        className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800"
                                    >
                                        <Check className="h-4 w-4" />
                                        Enviado
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => actualizarEnviado(false)}
                                        disabled={pedido.mensaje_enviado === false}
                                        className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800"
                                    >
                                        <X className="h-4 w-4" />
                                        No enviado
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )
        },
    },
// Para el mensajero sacamos la selección masiva y el menú de acciones. El costo
// de envío NO se filtra: es lo único que puede editar.
] as ColumnDef<Pedido>[]).filter(
    (columna) => !config.soloLectura || (columna.id !== "select" && columna.id !== "actions"),
)
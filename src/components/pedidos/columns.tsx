"use client"

import * as React from "react"
import { ColumnDef, Row } from "@tanstack/react-table"
import { Pedido } from "@/types/pedidos"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { TruncatedText } from "@/components/ui/truncated-text"
import { ArrowUpDown, MoreHorizontal, Check, X, Clock, Copy, Edit } from "lucide-react"
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

export const createColumns = (config: {
    editingOrderId: number | null
    setEditingOrderId: (id: number | null) => void
    editingCostoId: number | null
    setEditingCostoId: (id: number | null) => void
    onRowSelect: (row: Row<Pedido>, event: React.MouseEvent<HTMLButtonElement>) => void
}): ColumnDef<Pedido>[] => [
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
    },
    {
        id: "costo_envio_mobile",
        accessorFn: (row) => row.costo_envio,
        header: () => <span className="md:hidden">Costo de Envío</span>,
        cell: ({ row }) => {
            const costo_envio = parseFloat(row.getValue("costo_envio") || "0")
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
            return <div className="font-medium">{formatted}</div>

        }
    },
    {
        accessorKey: "costo_envio",
        header: () => <span className="hidden md:inline">Costo de Envío</span>,
        cell: ({ row }) => {
            const precio = parseFloat(row.getValue("costo_envio") || "0")
            const formatted = new Intl.NumberFormat("es-AR", {
                style: "currency",
                currency: "ARS",
            }).format(precio)
            return <div className="font-medium hidden md:block">{formatted}</div>

        },
        meta: {
            className: "hidden md:table-cell"
        }
    },
    {
        accessorKey: "enviado",
        header: "Wpp Enviado",
        cell: ({ row }) => {
            const enviado = row.getValue("enviado") as boolean
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
                                        disabled={pedido.enviado === true}
                                        className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800"
                                    >
                                        <Check className="h-4 w-4" />
                                        Enviado
                                    </DropdownMenuItem>
                                    <DropdownMenuItem 
                                        onClick={() => actualizarEnviado(false)}
                                        disabled={pedido.enviado === false}
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
]
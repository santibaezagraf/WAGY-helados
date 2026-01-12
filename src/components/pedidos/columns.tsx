"use client"

import * as React from "react"
import { ColumnDef } from "@tanstack/react-table"
import { Pedido } from "@/types/pedidos"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { createClient } from "@/lib/supabase-client"
import { EditOrderModal } from "./edit-order-modal"
import { crearMensajeWpp } from "@/lib/mensaje-utils"

/**
 * Crea la configuración de columnas (ColumnDef<Pedido>[]) para la tabla de pedidos.
 *
 * Incluye columnas de selección, dirección, teléfono, cantidades, método de pago,
 * estado, pagado, ganancia y acciones (con menús para editar/actualizar estado y pago).
 *
 * @param onRefresh - Callback opcional que se invoca tras actualizar un pedido para refrescar los datos.
 * @returns Un arreglo de ColumnDef<Pedido> que describe las columnas y sus celdas.
 */
export const createColumns = (onRefresh?: () => void): ColumnDef<Pedido>[] => [
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
                onCheckedChange={(value) => row.toggleSelected(!!value)}
                aria-label="Seleccionar fila"
            />
        ),
        enableSorting: false,
        enableHiding: false,
    },
    {
        accessorKey: "direccion",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                >
                    Dirección
                <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            )
        },
    },
    {
        accessorKey: "telefono",
        header: "Teléfono",
    },
    {
        accessorKey: "cantidad_agua",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                >
                    Helados Agua
                <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            )
        },
    },
    {
        accessorKey: "cantidad_crema",
        header: ({ column }) => {
            return (
                <Button
                    variant="ghost"
                    onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
                >
                    Helados Crema
                <ArrowUpDown className="ml-2 h-4 w-4" />
                </Button>
            )
        },
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
                accessorKey: "ganancia",
                header: ({ column }) => {
        return (
            <Button
                variant="ghost"
                onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            >
                Ganancia
            <ArrowUpDown className="ml-2 h-4 w-4" />
            </Button>
        )
        },
        cell: ({ row }) => {
            const ganancia = parseFloat(row.getValue("ganancia"))
            const formatted = new Intl.NumberFormat("es-AR", {
                style: "currency",
                currency: "ARS",
            }).format(ganancia)
            return <div className="font-medium">{formatted}</div>
        },
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
            const [editModalOpen, setEditModalOpen] = React.useState(false)
            
            const actualizarEstado = async (nuevoEstado: string) => {
                const supabase = createClient()
                const { error } = await supabase
                    .from("pedidos")
                    .update({ estado: nuevoEstado })
                    .eq("id", pedido.id)
                
                if (error) {
                    console.error("Error al actualizar estado:", error)
                    alert("Error al actualizar el estado")
                } else {
                    onRefresh?.()
                }
            }

            const actualizarPagado = async (pagado: boolean) => {
                const supabase = createClient()
                const { error } = await supabase
                    .from("pedidos")
                    .update({ pagado })
                    .eq("id", pedido.id)
                
                if (error) {
                    console.error("Error al actualizar pagado:", error)
                    alert("Error al actualizar el estado de pago")
                } else {
                    onRefresh?.()
                }
            }

            const actualizarEnviado = async (enviado: boolean) => {
                const supabase = createClient()
                const { error } = await supabase
                    .from("pedidos")
                    .update({ enviado })
                    .eq("id", pedido.id)
                
                if (error) {
                    console.error("Error al actualizar enviado:", error)
                    alert("Error al actualizar el estado de envío")
                } else {
                    onRefresh?.()
                }
            }
        
            return (
                <>
                    <EditOrderModal 
                        open={editModalOpen}
                        onOpenChange={setEditModalOpen}
                        pedido={pedido}
                        onOrderUpdated={() => onRefresh?.()}
                    />
                    
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="h-8 w-8 p-0">
                                <span className="sr-only">Abrir menú</span>
                                <MoreHorizontal className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Acciones</DropdownMenuLabel>

                            <DropdownMenuItem onClick={() => setEditModalOpen(true)}>
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
                                        className="gap-2 text-gray-700 hover:text-gray-800 hover:bg-gray-50 focus:bg-gray-50 focus:text-gray-800"
                                    >
                                        <Clock className="h-4 w-4 text-gray-500" />
                                        Pendiente
                                    </DropdownMenuItem>
                                    <DropdownMenuItem 
                                        onClick={() => actualizarEstado("enviado")}
                                        disabled={pedido.estado === "enviado"}
                                        className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800"
                                    >
                                        <Check className="h-4 w-4" />
                                        Enviado
                                    </DropdownMenuItem>
                                    <DropdownMenuItem 
                                        onClick={() => actualizarEstado("cancelado")}
                                        disabled={pedido.estado === "cancelado"}
                                        className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800"
                                    >
                                        <X className="h-4 w-4" />
                                        Cancelado
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>Marcar como</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuItem 
                                        onClick={() => actualizarPagado(true)}
                                        disabled={pedido.pagado === true}
                                    >
                                        Pagado
                                    </DropdownMenuItem>
                                    <DropdownMenuItem 
                                        onClick={() => actualizarPagado(false)}
                                        disabled={pedido.pagado === false}
                                    >
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
                                    >
                                        Enviado
                                    </DropdownMenuItem>
                                    <DropdownMenuItem 
                                        onClick={() => actualizarEnviado(false)}
                                        disabled={pedido.enviado === false}
                                    >
                                        No enviado
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>

                            {/* <DropdownMenuSeparator /> */}
                                
                                
                            
                                
                            
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )
        },
    },
]
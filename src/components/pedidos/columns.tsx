"use client"

import { ColumnDef } from "@tanstack/react-table"
import { Pedido } from "@/types/pedidos"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArrowUpDown, MoreHorizontal } from "lucide-react"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export const columns: ColumnDef<Pedido>[] = [
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
                    estado === "enviado" ? "default" :
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
                    <Badge 
                        variant={pagado ? "default" : "destructive"}
                        className={`opacity-70 ${pagado ? "bg-green-600 hover:bg-green-700" : ""}`} 
                    >
                        {pagado ? "Sí" : "No"}
                    </Badge>
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
        id: "actions",
        cell: ({ row }) => {
            const pedido = row.original
        
            return (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                            <span className="sr-only">Abrir menú</span>
                            <MoreHorizontal className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Acciones</DropdownMenuLabel>
                        <DropdownMenuItem
                            onClick={() => navigator.clipboard.writeText(pedido.id.toString())}
                        >
                        Copiar ID
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem>Ver detalles</DropdownMenuItem>
                        <DropdownMenuItem>Editar pedido</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )
        },
    },
]
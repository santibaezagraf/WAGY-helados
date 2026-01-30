import { Button } from "@/components/ui/button"
import { Pedido } from "@/types/pedidos"
import { Table } from "@tanstack/react-table"
import { ArrowDown, Check, ChevronDown, Clock, MessageCircle, MessageSquare, Van, WalletMinimal, X } from "lucide-react"
import * as React from "react"
import {
    actualizarEstadoMasivo,
    actualizarPagadoMasivo,
    actualizarEnviadoMasivo,
} from "@/lib/actions/pedidos"
import { useRouter } from "next/navigation"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../ui/dropdown-menu"

interface SelectionBarProps {
    selectedRowsCount: number
    table: Table<any>
    generarMensajesWpp: () => Promise<void>
    setRowSelection: (selection: {}) => void
}

export const SelectionBar = React.memo(function SelectionBar({
    selectedRowsCount,
    table,
    generarMensajesWpp,
    setRowSelection
}: SelectionBarProps) {

    const router = useRouter()

    const actualizarEstadoMasivoHandler = React.useCallback(async (nuevoEstado: string) => {
        const selectedRows = table.getFilteredSelectedRowModel().rows
        const idsAActualizar = selectedRows
            .filter(row => (row.original as Pedido).estado !== nuevoEstado)
            .map(row => (row.original as Pedido).id)

        if (idsAActualizar.length === 0) {
            setRowSelection({})
            return
        }
        
        try {
            await actualizarEstadoMasivo(idsAActualizar, nuevoEstado)
            setRowSelection({})

        } catch (error) {
            console.error(error)
            alert("Error al actualizar los estados")
        }
    }, [table, setRowSelection])

    const actualizarPagadoMasivoHandler = React.useCallback(async (pagado: boolean) => {
        const selectedRows = table.getFilteredSelectedRowModel().rows
        const idsAActualizar = selectedRows
            .filter(row => (row.original as Pedido).pagado !== pagado)
            .map(row => (row.original as Pedido).id)
        
        if (idsAActualizar.length === 0) {
            setRowSelection({})
            return
        }
        
        try {
            await actualizarPagadoMasivo(idsAActualizar, pagado)
            setRowSelection({})

        } catch (error) {
            console.error(error)
            alert("Error al actualizar el estado de pago")
        }
    }, [table, setRowSelection])

    const actualizarEnviadoMasivoHandler = React.useCallback(async (enviado: boolean) => {
        const selectedRows = table.getFilteredSelectedRowModel().rows
        const idsAActualizar = selectedRows
            .filter(row => (row.original as Pedido).enviado !== enviado)
            .map(row => (row.original as Pedido).id)
    
        if (idsAActualizar.length === 0) {
            setRowSelection({})
            return
        }
        
        try {
            await actualizarEnviadoMasivo(idsAActualizar, enviado)
            setRowSelection({})

        } catch (error) {
            console.error(error)
            alert("Error al actualizar el estado de envío")
        }
    }, [table, setRowSelection])

    return (
        <div className="bg-cyan-50 border border-cyan-300 rounded-lg p-3 sm:p-4 shadow-md">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                {/* Contador y botón cancelar en móvil */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-800">
                        {selectedRowsCount} pedido(s) seleccionado(s)
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRowSelection({})}
                        className="lg:hidden text-slate-700 hover:text-slate-900 hover:bg-slate-100"
                    >
                        Cancelar
                    </Button>
                </div>

                

                {/* Contenedor de botones con wrap */}
                <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
                    {/* Dropdown: Estado */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="sm"
                                variant="outline"
                                className="text-xs sm:text-sm"
                            >
                                <Van className="h-5 w-5" /> 
                                Estado
                                <ChevronDown className="ml-1 mt-1 h-3 w-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-[160px]">
                            <DropdownMenuItem 
                                onClick={() => actualizarEstadoMasivoHandler("pendiente")}
                                className="gap-2 text-gray-700 hover:text-gray-800 hover:bg-gray-50 focus:bg-gray-50 focus:text-gray-800"
                            >
                                <Clock className="h-4 w-4 text-gray-500" />
                                Pendiente
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                                onClick={() => actualizarEstadoMasivoHandler("enviado")}
                                className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800"
                            >
                                <Check className="h-4 w-4" />
                                Enviado
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                                onClick={() => actualizarEstadoMasivoHandler("cancelado")}
                                className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800"
                            >
                                <X className="h-4 w-4" />
                                Cancelado
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <div className="hidden sm:block h-6 w-px bg-cyan-300" />

                    {/* Dropdown: Pago */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="sm"
                                variant="outline"
                                className="text-xs sm:text-sm"
                            >
                                <WalletMinimal className="h-4 w-4" />
                                Pago
                                <ChevronDown className="ml-1 mt-1 h-3 w-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-[160px]">
                            <DropdownMenuItem 
                                onClick={() => actualizarPagadoMasivoHandler(true)}
                                className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800"
                            >
                                <Check className="h-4 w-4" />
                                Pagado
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                                onClick={() => actualizarPagadoMasivoHandler(false)}
                                className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800"
                            >
                                <X className="h-4 w-4" />
                                No pagado
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <div className="hidden sm:block h-6 w-px bg-cyan-300" />


                    {/* Dropdown: Mensaje */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="sm"
                                variant="outline"
                                className="text-xs sm:text-sm"
                            >
                                <MessageCircle className="h-4 w-4" />
                                Mensaje
                                <ChevronDown className="ml-1 mt-1 h-3 w-3" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-[160px]">
                            <DropdownMenuItem 
                                onClick={() => actualizarEnviadoMasivoHandler(true)}
                                className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800"
                            >
                                <Check className="h-4 w-4" />
                                Enviado
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                                onClick={() => actualizarEnviadoMasivoHandler(false)}
                                className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800"
                            >
                                <X className="h-4 w-4" />
                                No enviado
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    
                    <div className="hidden sm:block h-6 w-px bg-cyan-300" />
                    
                    {/* WhatsApp */}
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            generarMensajesWpp() 
                        }}
                        className="gap-1 border-cyan-300 hover:bg-cyan-50 text-xs sm:text-sm"
                    >
                        <MessageSquare className="h-3 w-3 sm:h-4 sm:w-4 text-cyan-600" />
                        <span className="hidden sm:inline">Crear mensajes</span>
                        <span className="sm:hidden">WhatsApp</span>
                    </Button>
                </div>

                {/* Botón cancelar en desktop */}
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRowSelection({})}
                    className="hidden lg:block text-slate-700 hover:text-slate-900 hover:bg-slate-100"
                >
                    Cancelar
                </Button>
            </div>
        </div>
    )
})
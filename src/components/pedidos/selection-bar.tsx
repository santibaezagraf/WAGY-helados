import { Button } from "@/components/ui/button"
import { Pedido } from "@/types/pedidos"
import { Table } from "@tanstack/react-table"
import { Check, Clock, MessageSquare, X } from "lucide-react"
import * as React from "react"
import {
    actualizarEstadoMasivo,
    actualizarPagadoMasivo,
    actualizarEnviadoMasivo,
} from "@/lib/actions/pedidos"
import { useRouter } from "next/navigation"

interface SelectionBarProps {
    selectedRowsCount: number
    table: Table<any>
    generarMensajesWpp: () => Promise<void>
    setRowSelection: (selection: {}) => void
}

export function SelectionBar({
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
            router.refresh()
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
            router.refresh()
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
            router.refresh()
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
                <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                    {/* Grupo: Estados */}
                    <div className="flex gap-1 sm:gap-2">
                        <Button   
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarEstadoMasivoHandler("pendiente")}
                            className="gap-1 border-gray-300 hover:bg-gray-50 text-xs sm:text-sm"
                        >
                            <Clock className="h-3 w-3 sm:h-4 sm:w-4 text-gray-500" />
                            <span className="hidden sm:inline">Pendiente</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarEstadoMasivoHandler("enviado")}
                            className="gap-1 border-green-300 hover:bg-green-50 text-xs sm:text-sm"
                        >
                            <Check className="h-3 w-3 sm:h-4 sm:w-4 text-green-600" />
                            <span className="hidden sm:inline">Enviado</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarEstadoMasivoHandler("cancelado")}
                            className="gap-1 border-red-300 hover:bg-red-50 text-xs sm:text-sm"
                        >
                            <X className="h-3 w-3 sm:h-4 sm:w-4 text-red-600" />
                            <span className="hidden sm:inline">Cancelado</span>
                        </Button>
                    </div>
                    
                    <div className="hidden sm:block h-6 w-px bg-cyan-300" />
                    
                    {/* Grupo: Pagado */}
                    <div className="flex gap-1 sm:gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarPagadoMasivoHandler(true)}
                            className="border-green-300 hover:bg-green-50 text-xs sm:text-sm"
                        >
                            Pagado
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarPagadoMasivoHandler(false)}
                            className="border-red-300 hover:bg-red-50 text-xs sm:text-sm"
                        >
                            No pagado
                        </Button>
                    </div>
                    
                    <div className="hidden sm:block h-6 w-px bg-cyan-300" />
                    
                    {/* Grupo: Enviado */}
                    <div className="flex gap-1 sm:gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarEnviadoMasivoHandler(true)}
                            className="border-cyan-300 hover:bg-cyan-50 text-xs sm:text-sm"
                        >
                            Wpp Enviado
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarEnviadoMasivoHandler(false)}
                            className="border-slate-300 hover:bg-slate-50 text-xs sm:text-sm"
                        >
                            Wpp no enviado
                        </Button>
                    </div>
                    
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
}
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase-client"
import { Pedido } from "@/types/pedidos"
import { Table } from "@tanstack/react-table"
import { Check, Clock, MessageSquare, X } from "lucide-react"
import * as React from "react"

interface SelectionBarProps {
    selectedRowsCount: number
    table: Table<any>
    onRefresh?: () => Promise<void>
    generarMensajesWpp: () => Promise<void>
    setRowSelection: (selection: {}) => void
}

export function SelectionBar({
    selectedRowsCount,
    table,
    onRefresh,
    generarMensajesWpp,
    setRowSelection
}: SelectionBarProps) {

    /* ---- ACTUALIZACIONES MASIVAS ---- */

    const actualizarEstadoMasivo = React.useCallback(async (nuevoEstado: string) => {
        const supabase = createClient()
        const selectedRows = table.getFilteredSelectedRowModel().rows
        const idsAActualizar = selectedRows
            .filter(row => (row.original as Pedido).estado !== nuevoEstado)
            .map(row => (row.original as Pedido).id)

        if (idsAActualizar.length === 0) {
            setRowSelection({})
            return
        }
        
        const { error } = await supabase
            .from("pedidos")
            .update({ estado: nuevoEstado })
            .in("id", idsAActualizar)
        
        if (error) {
            console.error("Error al actualizar estados:", error)
            alert("Error al actualizar los estados")
        } else {
            setRowSelection({})
            onRefresh?.()
        }
    }, [table, onRefresh])

    const actualizarPagadoMasivo = React.useCallback(async (pagado: boolean) => {
        const supabase = createClient()
        const selectedRows = table.getFilteredSelectedRowModel().rows

        const idsAActualizar = selectedRows
            .filter(row => (row.original as Pedido).pagado !== pagado)
            .map(row => (row.original as Pedido).id)
        
        if (idsAActualizar.length === 0) {
            setRowSelection({})
            return
        }
        
        const { error } = await supabase
            .from("pedidos")
            .update({ pagado })
            .in("id", idsAActualizar)
        
        if (error) {
            console.error("Error al actualizar pagado:", error)
            alert("Error al actualizar el estado de pago")
        } else {
            setRowSelection({})
            onRefresh?.()
        }
    }, [table, onRefresh])

    const actualizarEnviadoMasivo = React.useCallback(async (enviado: boolean) => {
        const supabase = createClient()
        const selectedRows = table.getFilteredSelectedRowModel().rows
        
        // Filtrar solo los que necesitan actualización
        const idsAActualizar = selectedRows
            .filter(row => (row.original as Pedido).enviado !== enviado)
            .map(row => (row.original as Pedido).id)
    
        if (idsAActualizar.length === 0) {
            setRowSelection({})
            return
        }
        
        const { error } = await supabase
            .from("pedidos")
            .update({ enviado })
            .in("id", idsAActualizar)
        
        if (error) {
            console.error("Error al actualizar enviado:", error)
            alert("Error al actualizar el estado de envío")
        } else {
            setRowSelection({})
            onRefresh?.()
        }
    }, [table, onRefresh])

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
                            onClick={() => actualizarEstadoMasivo("pendiente")}
                            className="gap-1 border-gray-300 hover:bg-gray-50 text-xs sm:text-sm"
                        >
                            <Clock className="h-3 w-3 sm:h-4 sm:w-4 text-gray-500" />
                            <span className="hidden sm:inline">Pendiente</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarEstadoMasivo("enviado")}
                            className="gap-1 border-green-300 hover:bg-green-50 text-xs sm:text-sm"
                        >
                            <Check className="h-3 w-3 sm:h-4 sm:w-4 text-green-600" />
                            <span className="hidden sm:inline">Enviado</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarEstadoMasivo("cancelado")}
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
                            onClick={() => actualizarPagadoMasivo(true)}
                            className="border-green-300 hover:bg-green-50 text-xs sm:text-sm"
                        >
                            Pagado
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarPagadoMasivo(false)}
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
                            onClick={() => actualizarEnviadoMasivo(true)}
                            className="border-cyan-300 hover:bg-cyan-50 text-xs sm:text-sm"
                        >
                            Wpp Enviado
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actualizarEnviadoMasivo(false)}
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
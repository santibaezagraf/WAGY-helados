"use client"

import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { Input } from "../ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu"
import { Filter, Calendar, Clock, Check, X, Van, WalletMinimal, MessageCircle, BarChart3 } from "lucide-react"
import * as React from "react"
import { memo } from "react"
import { Table } from "@tanstack/react-table"
import { type Filters } from "./data-table"
import { useRouter } from "next/navigation"


interface FilterBarProps {
    table: Table<any>
    onFiltersChange?: (filters: Filters) => void
    onAddOrder?: () => void
    currentFilters: Filters
}

export const FilterBar = memo(function FilterBar({ 
    table,
    onFiltersChange,
    onAddOrder,
    currentFilters,
}: FilterBarProps) {
    const router = useRouter()
    // busqueda por texto
    const [searchDireccion, setSearchDireccion] = React.useState(currentFilters.direccion)
    const [searchTelefono, setSearchTelefono] = React.useState(currentFilters.telefono)

    React.useEffect(() => {
        setSearchDireccion(currentFilters.direccion)
        setSearchTelefono(currentFilters.telefono)
    }, [currentFilters.direccion, currentFilters.telefono])

    React.useEffect(() => {
        const timer = setTimeout(() => {
            if (searchDireccion !== currentFilters.direccion) {
                onFiltersChange?.({
                    ...currentFilters,
                    direccion: searchDireccion,
                })
            }
        }, 500) 
        return () => clearTimeout(timer)
    }, [searchDireccion, currentFilters, onFiltersChange])

    React.useEffect(() => {
        const timer = setTimeout(() => {
            if (searchTelefono !== currentFilters.telefono) {
                onFiltersChange?.({
                    ...currentFilters,
                    telefono: searchTelefono,
                })
            }
        }, 500) 
        return () => clearTimeout(timer)
    }, [searchTelefono, currentFilters, onFiltersChange])

    const handlePeriodoChange = React.useCallback((periodo: 'dia' | 'semana' | 'mes' | 'todos') => {
        onFiltersChange?.({
            ...currentFilters,
            periodo,
        })
    }, [currentFilters, onFiltersChange])

    const toggleEstado = React.useCallback((estado: string) => {
        const currentEstados = currentFilters.estados;

        const newEstados = currentEstados.includes(estado)
            ? currentEstados.filter(e => e !== estado)
            : [...currentEstados, estado]

        onFiltersChange?.({
            ...currentFilters,
            estados: newEstados,
        })

        
    }, [currentFilters, onFiltersChange])

    const togglePagado = React.useCallback((valor: boolean) => {
        const currentPagado = currentFilters.pagado.filter(v => v !== null) as boolean[];

        const newPagado = currentPagado.includes(valor)
            ? currentPagado.filter(p => p !== valor)
            : [...currentPagado, valor]

        onFiltersChange?.({
            ...currentFilters,
            pagado: newPagado,
        })
    }, [currentFilters, onFiltersChange])

    const toggleMensaje = React.useCallback((estado: boolean) => {
        const currentEnviado = currentFilters.enviado.filter(v => v !== null) as boolean[];
        
        const newEnviado = currentEnviado.includes(estado)
            ? currentEnviado.filter(e => e !== estado)
            : [...currentEnviado, estado]

        onFiltersChange?.({
            ...currentFilters,
            enviado: newEnviado,
        })
    }, [currentFilters, onFiltersChange])

    return (
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
            <div className="flex flex-wrap gap-1 mr-0 md:mr-2 w-full md:w-auto">
                <Button
                    size="sm"
                    variant={currentFilters.periodo === 'dia' ? 'default' : 'outline'}
                    onClick={() => handlePeriodoChange('dia')}
                    className="gap-1 text-xs md:text-sm"
                >
                    <Calendar className="h-3 w-3" />
                    <span className="hidden sm:inline">Hoy</span>
                </Button>
                <Button
                    size="sm"
                    variant={currentFilters.periodo === 'semana' ? 'default' : 'outline'}
                    onClick={() => handlePeriodoChange('semana')}
                    className="gap-1 text-xs md:text-sm"
                >
                    <span className="hidden sm:inline">Semana</span>
                    <span className="sm:hidden">Sem</span>
                </Button>
                <Button
                    size="sm"
                    variant={currentFilters.periodo === 'mes' ? 'default' : 'outline'}
                    onClick={() => handlePeriodoChange('mes')}
                    className="gap-1 text-xs md:text-sm"
                >
                    Mes
                </Button>
                <Button
                    size="sm"
                    variant={currentFilters.periodo === 'todos' ? 'default' : 'outline'}
                    onClick={() => handlePeriodoChange('todos')}
                    className="gap-1 text-xs md:text-sm"
                >
                    <span className="hidden sm:inline">Todos</span>
                    <span className="sm:hidden">Todo</span>
                </Button>
            </div>
        
            <div className="hidden md:block h-8 w-px bg-gray-300" />
        
            <div className="relative flex-1 min-w-[150px] md:max-w-sm">
                <Input
                    placeholder="Dirección..."
                    value={searchDireccion}
                    onChange={(event) => setSearchDireccion(event.target.value)}
                    className="text-sm pr-8"
                />
                {searchDireccion && (
                    <button
                        onClick={() => setSearchDireccion('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                        type="button"
                    >
                        <X className="h-4 w-4" />
                    </button>
                )}
            </div>
            
            <div className="relative flex-1 min-w-[120px] md:max-w-sm">
                <Input
                    placeholder="Teléfono..."
                    value={searchTelefono}
                    onChange={(event) => setSearchTelefono(event.target.value)}
                    className="text-sm pr-8"
                />
                {searchTelefono && (
                    <button
                        onClick={() => setSearchTelefono('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                        type="button"
                    >
                        <X className="h-4 w-4" />
                    </button>
                )}
            </div>
        
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-2 text-xs md:text-sm">
                        <Filter className="h-4 w-4" />
                        <span className="hidden sm:inline">Filtros</span>
                        <span className="sm:hidden">F</span>
                        {(currentFilters.estados.length < 3 || currentFilters.pagado.length < 2 || currentFilters.enviado.length < 2) && (
                            <span className="ml-1 rounded-full bg-cyan-600 px-2 py-0.5 text-xs text-white">
                                {3 - currentFilters.estados.length + (2 - currentFilters.pagado.length) + (2 - currentFilters.enviado.length)}
                            </span>
                        )}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel className="flex items-center gap-1">
                        <Van className="h-5 w-5" />
                        Estado del pedido
                        
                    </DropdownMenuLabel>
                    <div className="px-2 py-2 space-y-2">
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-pendiente"
                                checked={currentFilters.estados.includes("pendiente")}
                                onCheckedChange={() => toggleEstado("pendiente")}
                            />
                            <label
                                htmlFor="filter-pendiente"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <Clock className="h-4 w-4 text-gray-500 flex-shrink-0" />
                                Pendiente
                            </label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-enviado"
                                checked={currentFilters.estados.includes("enviado")}
                                onCheckedChange={() => toggleEstado("enviado")}
                            />
                            <label
                                htmlFor="filter-enviado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
                                Enviado
                            </label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-cancelado"
                                checked={currentFilters.estados.includes("cancelado")}
                                onCheckedChange={() => toggleEstado("cancelado")}
                            />
                            <label
                                htmlFor="filter-cancelado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <X className="h-4 w-4 text-red-600 flex-shrink-0" />
                                Cancelado
                            </label>
                        </div>
                    </div>
                    
                    <DropdownMenuSeparator />
                    
                    <DropdownMenuLabel className="flex items-center gap-1">                        
                        <WalletMinimal className="h-4 w-4" />
                        Estado de pago
                        
                    </DropdownMenuLabel>
                    <div className="px-2 py-2 space-y-2">
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-pagado"
                                checked={currentFilters.pagado.includes(true)}
                                onCheckedChange={() => togglePagado(true)}
                            />
                            <label
                                htmlFor="filter-pagado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
                                Pagado
                                </label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-no-pagado"
                                checked={currentFilters.pagado.includes(false)}
                                onCheckedChange={() => togglePagado(false)}
                            />
                            <label
                                htmlFor="filter-no-pagado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <X className="h-4 w-4 text-red-600 flex-shrink-0" />
                                No pagado
                            </label>
                        </div>
                    </div>

                    <DropdownMenuSeparator />

                    <DropdownMenuLabel className="flex items-center gap-1">
                        <MessageCircle className="h-4 w-4" />
                        Estado de mensaje
                        
                    </DropdownMenuLabel>
                    <div className="px-2 py-2 space-y-2">
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-mensaje-enviado"
                                checked={currentFilters.enviado.includes(true)}
                                onCheckedChange={() => toggleMensaje(true)}
                            />
                            <label
                                htmlFor="filter-mensaje-enviado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
                                Enviado
                                </label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-mensaje-no-enviado"
                                checked={currentFilters.enviado.includes(false)}
                                onCheckedChange={() => toggleMensaje(false)}
                            />
                            <label
                                htmlFor="filter-mensaje-no-enviado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <X className="h-4 w-4 text-red-600 flex-shrink-0" />
                                No enviado
                            </label>
                        </div>
                    </div>

                </DropdownMenuContent>
            </DropdownMenu>
        
            <Button
                onClick={() => router.push('/balances')}
                className="w-full md:w-auto bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm gap-2"
            >
                <BarChart3 className="h-4 w-4" />
                <span className="hidden sm:inline">Ver Balances</span>
                <span className="sm:hidden">Balances</span>
            </Button>

            <Button
                onClick={onAddOrder}
                className="w-full md:w-auto md:ml-auto bg-cyan-600 hover:bg-cyan-700 text-white font-semibold text-sm"
            >
                <span className="hidden sm:inline">+ Agregar Pedido</span>
                <span className="sm:hidden">+ Agregar</span>
            </Button>
        </div>
    )
})
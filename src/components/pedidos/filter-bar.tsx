import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { Input } from "../ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu"
import { Filter, Calendar, Clock, Check, X, Mailbox, Van, VanIcon, LucideVan, DollarSign, BadgeDollarSign, Coins, Wallet, WalletCards, WalletMinimal, Wallet2, Smartphone, PhoneIncoming, WheatOff, MessageCircle, MessageCirclePlus, MessageCircleReply, MessageCircleMore, MessageCircleOff, MessageCircleCode, MessageCircleQuestionMark, MessageCircleQuestion } from "lucide-react"
import * as React from "react"
import { ColumnDef, RowData, Table } from "@tanstack/react-table"

interface FilterBarProps {
    table: Table<any>
    onFiltersChange?: (filters: {
        periodo: 'dia' | 'semana' | 'mes' | 'todos',
        estados: string[],
        pagado: (boolean | null)[],
        mensaje: (boolean | null)[],
    }) => void
    onAddOrder?: () => void
}

export function FilterBar({ 
    table,
    onFiltersChange,
    onAddOrder,
}: FilterBarProps) {
    // Estados internos
    const [periodoTemporal, setPeriodoTemporal] = React.useState<'dia' | 'semana' | 'mes' | 'todos'>('semana')
    const [estadosFiltrados, setEstadosFiltrados] = React.useState<string[]>(["pendiente", "enviado"])
    const [pagadoFiltrado, setPagadoFiltrado] = React.useState<(boolean | null)[]>([true, false])
    const [mensajeFiltrado, setMensajeFiltrado] = React.useState<(boolean | null)[]>([true, false])

    // busqueda por texto
    const [searchDireccion, setSearchDireccion] = React.useState("")
    const [searchTelefono, setSearchTelefono] = React.useState("")

    // Notificar cambios al padre
    React.useEffect(() => {
        onFiltersChange?.({
            periodo: periodoTemporal,   
            estados: estadosFiltrados,
            pagado: pagadoFiltrado,
            mensaje: mensajeFiltrado,
        })
    }, [periodoTemporal, estadosFiltrados, pagadoFiltrado, mensajeFiltrado, onFiltersChange]) 

    React.useEffect(() => {
        const timer = setTimeout(() => {
            table.getColumn("direccion")?.setFilterValue(searchDireccion || undefined)
        }, 300) 
        return () => clearTimeout(timer)
    }, [searchDireccion, table])

    React.useEffect(() => {
        const timer = setTimeout(() => {
            table.getColumn("telefono")?.setFilterValue(searchTelefono || undefined)
        }, 300) 
        return () => clearTimeout(timer)
    }, [searchTelefono, table])

    const toggleEstado = React.useCallback((estado: string) => {
        setEstadosFiltrados(prev => 
            prev.includes(estado) 
                ? prev.filter(e => e !== estado)
                : [...prev, estado]
        )
    }, [])

    const togglePagado = React.useCallback((valor: boolean) => {
        setPagadoFiltrado(prev => {
            const filtered = prev.filter(v => v !== null) as boolean[]
            return filtered.includes(valor)
                ? filtered.filter(v => v !== valor)
                : [...filtered, valor]
        })
    }, [])

    const toggleMensaje = React.useCallback((estado: boolean) => {
        setMensajeFiltrado(prev => {
            const filtered = prev.filter(v => v !== null) as boolean[]
            return filtered.includes(estado)
                ? filtered.filter(v => v !== estado)
                : [...filtered, estado]
        })        
    }, [])

    return (
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
            <div className="flex flex-wrap gap-1 mr-0 md:mr-2 w-full md:w-auto">
                <Button
                    size="sm"
                    variant={periodoTemporal === 'dia' ? 'default' : 'outline'}
                    onClick={() => setPeriodoTemporal('dia')}
                    className="gap-1 text-xs md:text-sm"
                >
                    <Calendar className="h-3 w-3" />
                    <span className="hidden sm:inline">Hoy</span>
                </Button>
                <Button
                    size="sm"
                    variant={periodoTemporal === 'semana' ? 'default' : 'outline'}
                    onClick={() => setPeriodoTemporal('semana')}
                    className="gap-1 text-xs md:text-sm"
                >
                    <span className="hidden sm:inline">Semana</span>
                    <span className="sm:hidden">Sem</span>
                </Button>
                <Button
                    size="sm"
                    variant={periodoTemporal === 'mes' ? 'default' : 'outline'}
                    onClick={() => setPeriodoTemporal('mes')}
                    className="gap-1 text-xs md:text-sm"
                >
                    Mes
                </Button>
                <Button
                    size="sm"
                    variant={periodoTemporal === 'todos' ? 'default' : 'outline'}
                    onClick={() => setPeriodoTemporal('todos')}
                    className="gap-1 text-xs md:text-sm"
                >
                    <span className="hidden sm:inline">Todos</span>
                    <span className="sm:hidden">Todo</span>
                </Button>
            </div>
        
            <div className="hidden md:block h-8 w-px bg-gray-300" />
        
            <Input
                placeholder="Dirección..."
                value={searchDireccion}
                onChange={(event) => setSearchDireccion(event.target.value)}
                className="flex-1 min-w-[150px] md:max-w-sm text-sm"
            />
            <Input
                placeholder="Teléfono..."
                value={searchTelefono}
                onChange={(event) => setSearchTelefono(event.target.value)}
                className="flex-1 min-w-[120px] md:max-w-sm text-sm"
            />
        
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-2 text-xs md:text-sm">
                        <Filter className="h-4 w-4" />
                        <span className="hidden sm:inline">Filtros</span>
                        <span className="sm:hidden">F</span>
                        {(estadosFiltrados.length < 3 || pagadoFiltrado.length < 2 || mensajeFiltrado.length < 2) && (
                            <span className="ml-1 rounded-full bg-cyan-600 px-2 py-0.5 text-xs text-white">
                                {3 - estadosFiltrados.length + (2 - pagadoFiltrado.length) + (2 - mensajeFiltrado.length)}
                            </span>
                        )}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel className="flex items-center gap-1">
                        Estado del pedido
                        <Van className="h-5 w-5" />
                    </DropdownMenuLabel>
                    <div className="px-2 py-2 space-y-2">
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-pendiente"
                                checked={estadosFiltrados.includes("pendiente")}
                                onCheckedChange={() => toggleEstado("pendiente")}
                            />
                            <label
                                htmlFor="filter-pendiente"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <Clock className="h-4 w-4 text-gray-500" />
                                Pendiente
                            </label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-enviado"
                                checked={estadosFiltrados.includes("enviado")}
                                onCheckedChange={() => toggleEstado("enviado")}
                            />
                            <label
                                htmlFor="filter-enviado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <Check className="h-4 w-4 text-green-600" />
                                Enviado
                            </label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-cancelado"
                                checked={estadosFiltrados.includes("cancelado")}
                                onCheckedChange={() => toggleEstado("cancelado")}
                            />
                            <label
                                htmlFor="filter-cancelado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <X className="h-4 w-4 text-red-600" />
                                Cancelado
                            </label>
                        </div>
                    </div>
                    
                    <DropdownMenuSeparator />
                    
                    <DropdownMenuLabel className="flex items-center gap-1">                        
                        Estado de pago
                        <WalletMinimal className="h-4 w-4" />
                    </DropdownMenuLabel>
                    <div className="px-2 py-2 space-y-2">
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-pagado"
                                checked={pagadoFiltrado.includes(true)}
                                onCheckedChange={() => togglePagado(true)}
                            />
                            <label
                                htmlFor="filter-pagado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <Check className="h-4 w-4 text-green-600" />
                                Pagado
                                </label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-no-pagado"
                                checked={pagadoFiltrado.includes(false)}
                                onCheckedChange={() => togglePagado(false)}
                            />
                            <label
                                htmlFor="filter-no-pagado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <X className="h-4 w-4 text-red-600" />
                                No pagado
                            </label>
                        </div>
                    </div>

                    <DropdownMenuSeparator />

                    <DropdownMenuLabel className="flex items-center gap-1">
                        Estado de mensaje
                        <MessageCircle className="h-4 w-4" />
                    </DropdownMenuLabel>
                    <div className="px-2 py-2 space-y-2">
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-mensaje-enviado"
                                checked={mensajeFiltrado.includes(true)}
                                onCheckedChange={() => toggleMensaje(true)}
                            />
                            <label
                                htmlFor="filter-mensaje-enviado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <Check className="h-4 w-4 text-green-600" />
                                Enviado
                                </label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="filter-mensaje-no-enviado"
                                checked={mensajeFiltrado.includes(false)}
                                onCheckedChange={() => toggleMensaje(false)}
                            />
                            <label
                                htmlFor="filter-mensaje-no-enviado"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-2 cursor-pointer"
                            >
                                <X className="h-4 w-4 text-red-600" />
                                No enviado
                            </label>
                        </div>
                    </div>

                </DropdownMenuContent>
            </DropdownMenu>
        
            <Button
                onClick={onAddOrder}
                className="w-full md:w-auto md:ml-auto bg-cyan-600 hover:bg-cyan-700 text-white font-semibold text-sm"
            >
                <span className="hidden sm:inline">+ Agregar Pedido</span>
                <span className="sm:hidden">+ Agregar</span>
            </Button>
        </div>
    )
}
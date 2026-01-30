
"use client"

import * as React from "react"
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { AddOrderModal } from "@/components/pedidos/add-order-modal"
import { AddGastoModal } from "@/components/gastos/add-gasto-modal"
import { Pedido } from "@/types/pedidos"
import { crearMensajeWpp } from "@/lib/mensaje-utils"
import { SelectionBar } from "./selection-bar"
import { FilterBar } from "./filter-bar"
import { MessageEditor } from "./message-editor"
import { createColumns } from "@/components/pedidos/columns"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { EditOrderModal } from "./edit-order-modal"
import { EditCostoEnvioModal } from "./edit-costo-envio-modal"

type FilterPeriodo = 'dia' | 'semana' | 'mes' | 'todos'

export interface Filters {
  periodo: FilterPeriodo,
  estados: string[]
  pagado: (boolean | null)[]
  enviado: (boolean | null)[]
  direccion?: string
  telefono?: string
}

const defaultFilters: Filters = {
  periodo: 'semana',
  estados: ["pendiente", "enviado"],
  pagado: [true, false],
  enviado: [true, false],
  direccion: '',
  telefono: '',
}

const areFiltersEqual = (f1: Filters, f2: Filters) => {
  return (
    f1.periodo === f2.periodo &&
    f1.estados.join() === f2.estados.join() &&
    f1.pagado.join() === f2.pagado.join() &&
    f1.enviado.join() === f2.enviado.join() &&
    f1.direccion === f2.direccion &&
    f1.telefono === f2.telefono
  )
}

const parseFiltersFromUrl = (searchParams: URLSearchParams): Filters => {
  return {
    periodo: (searchParams.get('periodo') || defaultFilters.periodo) as FilterPeriodo,
    estados: searchParams.get('estado')?.split(',') || defaultFilters.estados,
    pagado: searchParams.get('pagado')?.split(',').map(p => p === 'true' ? true : p === 'false' ? false : null) || defaultFilters.pagado,
    enviado: searchParams.get('enviado')?.split(',').map(p => p === 'true' ? true : p === 'false' ? false : null) || defaultFilters.enviado,
    direccion: searchParams.get('direccion') || defaultFilters.direccion,
    telefono: searchParams.get('telefono') || defaultFilters.telefono,
  }
}

interface DataTableProps {
  data: Pedido[],
  pageIndex: number,
  pageSize: number,
  pageCount: number,
  rowCount: number,
}

export function DataTable({
  data,
  pageIndex,
  pageSize,
  pageCount,
  rowCount
}: DataTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState({})
  const [isAddModalOpen, setIsAddModalOpen] = React.useState(false)
  const [isAddGastoModalOpen, setIsAddGastoModalOpen] = React.useState(false)
  
  // Estados para modales
  const [editingOrderId, setEditingOrderId] = React.useState<number | null>(null)
  const [editingCostoId, setEditingCostoId] = React.useState<number | null>(null)
  
  // Estados para mensajes de WhatsApp
  const [mostrarEditorWpp, setMostrarEditorWpp] = React.useState(false)
  const [mensajesWpp, setMensajesWpp] = React.useState<{id: number, mensaje: string, enviado: boolean}[]>([])

  const columns = React.useMemo(() => createColumns({
    editingOrderId,
    setEditingOrderId,
    editingCostoId,
    setEditingCostoId,
  }), [editingOrderId, editingCostoId])

  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()

  // Estado para filtros personalizados
  const [filters, setFilters] = React.useState<Filters>(() => parseFiltersFromUrl(searchParams))

  const onPaginationChange = React.useCallback((updaterOrValue: any) => {
    // TanStack devuelve una función o un valor, hay que resolverlo
    const previousState = { pageIndex, pageSize, rowCount }
    const nextState = typeof updaterOrValue === 'function'
      ? updaterOrValue(previousState)
      : updaterOrValue

    const nextIndex = nextState.pageIndex + 1
    const nextSize = nextState.pageSize

    const currentIndex = Number(searchParams.get('page') ?? pageIndex + 1) // previousState.pageIndex + 1
    const currentSize = Number(searchParams.get('limit') ?? pageSize) // previousState.pageSize

    if (nextIndex === currentIndex && nextSize === currentSize) return

    // Construimos la nueva URL
    const params = new URLSearchParams(searchParams.toString())
    params.set('page', nextIndex.toString())
    params.set('limit', nextSize.toString())

    // Navegamos (esto recargará los datos en el servidor automáticamente)
    router.push(`${pathname}?${params.toString()}`)
  }, [searchParams, pathname, router, pageIndex, pageSize])

  const onFiltersChange = React.useCallback((newFilters: typeof filters) => {
    if (areFiltersEqual(newFilters, filters)) return

    setFilters(newFilters)
    
    // Construir URL con filtros
    const params = new URLSearchParams(searchParams.toString())
    params.set('page', '1') // Volver a página 1 al filtrar

    params.set('estado', newFilters.estados.join(','))
    params.set('pagado', newFilters.pagado.join(','))
    params.set('enviado', newFilters.enviado.join(','))
    params.set('periodo', newFilters.periodo)

    // Manejo de Dirección
    if (newFilters.direccion) {
        params.set('direccion', newFilters.direccion)
    } else {
        params.delete('direccion')
    }
    // Manejo de Teléfono
    if (newFilters.telefono) {
        params.set('telefono', newFilters.telefono)
    } else {
        params.delete('telefono')
    }
    
    router.push(`${pathname}?${params.toString()}`)
  }, [searchParams, pathname, router, filters])


  React.useEffect(() => {
    const urlFilters = parseFiltersFromUrl(searchParams)
    setFilters(urlFilters)
  }, [searchParams])

  const table = useReactTable({
    data: data,
    columns,
    pageCount,
    manualPagination: true,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: onPaginationChange,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      pagination: {
        pageIndex,
        pageSize,
      },
    },

  })

  const selectedRowsCount = Object.keys(rowSelection).length

  React.useEffect(() => {
    if (mostrarEditorWpp && mensajesWpp.length !== selectedRowsCount) {
      setMensajesWpp([])
      setMostrarEditorWpp(false)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [selectedRowsCount])

  const generarMensajesWpp = React.useCallback(async () => {
    const selectedRows = table.getFilteredSelectedRowModel().rows
    const mensajes = selectedRows.map(row => {
      const pedido = row.original as Pedido
      return {
        id: pedido.id,
        mensaje: crearMensajeWpp(pedido),
        enviado: pedido.enviado
      }
    })

    setMensajesWpp(mensajes)
    setMostrarEditorWpp(true)
  }, [table])

  return (
    <div className="space-y-4"> 
      {selectedRowsCount > 0 && (
        
        <SelectionBar
          selectedRowsCount={selectedRowsCount}
          table={table}
          generarMensajesWpp={generarMensajesWpp}
          setRowSelection={setRowSelection}
        />

      )}
      
      <FilterBar
        table={table}
        onFiltersChange={onFiltersChange}
        onAddOrder={() => setIsAddModalOpen(true)}
        onAddGasto={() => setIsAddGastoModalOpen(true)}
        currentFilters={filters}
      />
      
      {/* ---- TABLA ---- */}
      <div className="rounded-md border">
        <Table>
          <TableHeader className="bg-cyan-700 ">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead className="text-white" key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No hay pedidos.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      
      <div className="flex items-center justify-between space-x-2 py-4">
        <div className="text-sm text-muted-foreground">
          {'Mostrando '}
          
          <select
            className="text-sm text-muted-foreground"
            value={table.getState().pagination.pageSize}
            onChange={e => {
              table.setPageSize(Number(e.target.value)) 
            }}
          >
            {[10, 20, 30, 40, 50].map(pageSize => (
              <option key={pageSize} value={pageSize}>
                {pageSize}
              </option>
            ))}
          </select>

          {' pedidos por página.'}
        </div>
        
        

        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Anterior
          </Button>
          <div className="text-sm font-medium">
            Página {table.getPageCount() === 0 ? 0 : table.getState().pagination.pageIndex + 1} de {table.getPageCount() }
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Siguiente
          </Button>

          
        </div>
      </div>

      {/* Editor de mensajes de WhatsApp */}
      {mostrarEditorWpp && mensajesWpp.length > 0 && (
        <MessageEditor
          mensajes={mensajesWpp}
          onClose={() => setMostrarEditorWpp(false)}
        />
      )}

      <AddOrderModal
        open={isAddModalOpen}
        onOpenChange={setIsAddModalOpen}
      />

      <AddGastoModal
        open={isAddGastoModalOpen}
        onOpenChange={setIsAddGastoModalOpen}
      />

      {editingOrderId !== null && (
        <EditOrderModal 
          open={true}
          onOpenChange={(isOpen) => {
            if (!isOpen) setEditingOrderId(null)
          }}
          pedido={data.find(p => p.id === editingOrderId)!}
        />
      )}

      {editingCostoId !== null && (
        <EditCostoEnvioModal
          id={editingCostoId}
          costoEnvio={data.find(p => p.id === editingCostoId)?.costo_envio || 0}
          open={true}
          onOpenChange={(isOpen) => {
            if (!isOpen) setEditingCostoId(null)
          }}
        />
      )}
    </div>
  )
}

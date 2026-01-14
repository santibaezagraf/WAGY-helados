
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
import { Pedido } from "@/types/pedidos"
import { crearMensajeWpp } from "@/lib/mensaje-utils"
import { SelectionBar } from "./selection-bar"
import { FilterBar } from "./filter-bar"
import { MessageEditor } from "./message-editor"
import { createColumns } from "@/components/pedidos/columns"

interface DataTableProps {
  data: Pedido[]
}

export function DataTable({
  data,
}: DataTableProps) {
  const columns = React.useMemo(() => createColumns(), [])
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState({})
  const [isAddModalOpen, setIsAddModalOpen] = React.useState(false)
  
  // Estados para mensajes de WhatsApp
  const [mostrarEditorWpp, setMostrarEditorWpp] = React.useState(false)
  const [mensajesWpp, setMensajesWpp] = React.useState<{id: number, mensaje: string, enviado: boolean}[]>([])
  
  // Estados para filtros personalizados
  const [filters, setFilters] = React.useState({
    periodo: 'semana' as 'dia' | 'semana' | 'mes' | 'todos',
    estados: ["pendiente", "enviado"] as string[],
    pagado: [true, false] as (boolean | null)[],
    mensaje: [true, false] as (boolean | null)[],
  })

  // Estado para la paginación y el cambio de indice
  const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: 20 })

  // Aplicar filtros personalizados
  const filteredData = React.useMemo(() => {
    const ahora = new Date()
    
    return data.filter((pedido: any) => {
      // Filtro por estado y pagado
      const cumpleEstado = filters.estados.length === 0 || filters.estados.includes(pedido.estado)
      const cumplePagado = filters.pagado.length === 0 || filters.pagado.includes(pedido.pagado)
      const cumpleMensaje = filters.mensaje.length === 0 || filters.mensaje.includes(pedido.enviado)
      
      // Filtro temporal
      let cumpleTemporal = true
      if (filters.periodo !== 'todos') {
        const fechaPedido = new Date(pedido.created_at)
        
        if (filters.periodo === 'dia') {
          // Mismo día
          cumpleTemporal = fechaPedido.toDateString() === ahora.toDateString()
        } else if (filters.periodo === 'semana') {
          // Últimos 7 días
          const hace7Dias = new Date(ahora)
          hace7Dias.setDate(ahora.getDate() - 7)
          cumpleTemporal = fechaPedido >= hace7Dias
        } else if (filters.periodo === 'mes') {
          // Último mes
          const haceUnMes = new Date(ahora)
          haceUnMes.setMonth(ahora.getMonth() - 1)
          cumpleTemporal = fechaPedido >= haceUnMes
        }
      }
      
      return cumpleEstado && cumplePagado && cumpleMensaje && cumpleTemporal
    })
  }, [data, filters])

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      pagination,
    },

  })

  const selectedRowsCount = Object.keys(rowSelection).length

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
        onFiltersChange={setFilters}
        onAddOrder={() => setIsAddModalOpen(true)}
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
            value={table.getState().pagination.pageSize} // Lee el valor del estado
            onChange={e => {
              table.setPageSize(Number(e.target.value)) // <--- ESTA ES LA FUNCIÓN CLAVE
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
            Página {table.getState().pagination.pageIndex + 1} de{" "}
            {table.getPageCount()}
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
    </div>
  )
}

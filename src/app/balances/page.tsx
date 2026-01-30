"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { obtenerBalance, Balance } from "@/lib/actions/balances"
import { EliminarGasto, ObtenerGastos } from "@/lib/actions/gastos"
import { DateRangeSelector } from "@/components/balances/date-range-selector"
import { Button } from "@/components/ui/button"
import { Header } from "@/components/ui/header"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ArrowLeft, Loader2, ChevronDown, ChevronUp, Trash2 } from "lucide-react"

interface BalanceRow {
  label: string
  value: string | number
  format?: "number" | "currency"
  highlight?: boolean
  color?: "red" | "green" | "blue"
}

export default function BalancesPage() {
  const router = useRouter()
  const [balance, setBalance] = React.useState<Balance | null>(null)
  const [gastos, setGastos] = React.useState<{ id: number, monto: number }[]>([])
  const [gastosDropdownOpen, setGastosDropdownOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [gastoToDelete, setGastoToDelete] = React.useState<{ id: number, monto: number } | null>(null)
  const [dateRange, setDateRange] = React.useState<{
    startDate: Date
    endDate: Date
    mode: "dia" | "semana"
  } | null>(null)

  const fetchBalance = React.useCallback(async (startDate: Date, endDate: Date) => {
    setLoading(true)
    try {
      const [balanceResult, gastosResult] = await Promise.all([
        obtenerBalance(startDate, endDate),
        ObtenerGastos(startDate, endDate)
      ])
      setBalance(balanceResult)
      setGastos(gastosResult)
    } catch (error) {
      console.error("Error fetching balance:", error)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleDateRangeChange = React.useCallback((startDate: Date, endDate: Date, mode: "dia" | "semana") => {
    setDateRange({ startDate, endDate, mode })
    fetchBalance(startDate, endDate)
  }, [fetchBalance])

  const formatCurrency = React.useCallback((value: number | null | undefined) => {
    if (value === null || value === undefined) return "$0"
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value)
  }, [])

  const handleDeleteGasto = React.useCallback(async () => {
    if (!gastoToDelete) return
    
    try {
      await EliminarGasto(gastoToDelete.id)
      setDeleteDialogOpen(false)
      setGastoToDelete(null)
      
      // Refrescar los datos
      if (dateRange) {
        await fetchBalance(dateRange.startDate, dateRange.endDate)
      }
    } catch (error) {
      console.error("Error al eliminar gasto:", error)
    }
  }, [gastoToDelete, dateRange, fetchBalance])

  const balanceRows: BalanceRow[] = React.useMemo(() => (balance
    ? [
        {
          label: "Total Helados Agua",
          value: balance.total_agua,
          format: "number",
        },
        {
          label: "Total Helados Crema",
          value: balance.total_crema,
          format: "number",
        },
        {
          label: "Plata Transferencia",
          value: formatCurrency(balance.plata_transferencia),
        },
        {
          label: "Plata Efectivo (Ingreso Bruto)",
          value: formatCurrency(balance.plata_efectivo),
        },
        {
          label: "Costo de Envíos",
          value: `${formatCurrency(balance.costo_envio_total)} (${balance.cantidad_envios ?? 0})`,
          highlight: true,
          color: "red",
        },
        {
          label: "Gastos Varios",
          value: `${formatCurrency(balance.total_gastos)} (${balance.cantidad_gastos ?? 0})`,
          highlight: true,
          color: "red",
        },
        {
          label: "Efectivo Final",
          value: formatCurrency(balance.efectivo_final),
          highlight: true,
          color: "blue",
        },

        {
          label: "Ingreso Total (Efectivo + Transferencia)",
          value: formatCurrency(balance.ingreso_total),
          highlight: true,
          color: "green",
        },
      ]
    : [])
  , [balance, formatCurrency])

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="mb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.back()}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver
          </Button>
        </div>

        <h1 className="text-3xl font-bold mb-6">Balance de Ventas</h1>

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Selector de fechas */}
          <div className="md:col-span-1">
            <DateRangeSelector
              onDateRangeChange={handleDateRangeChange}
              defaultMode="semana"
            />
          </div>

          {/* Resultados del balance */}
          <div className="lg:col-span-2">
            {loading ? (
              <div className="flex items-center justify-center rounded-lg border border-gray-200 bg-white p-8">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
                <span className="ml-2 text-gray-600">Cargando balance...</span>
              </div>
            ) : balance ? (
              <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-6">
                {balanceRows.map((row, index) => (
                  <div key={index} >
                      <div
                        className={`flex items-center justify-between border-b pb-3 last:border-b-0 ${
                          row.highlight && row.color === 'red' ? 'rounded-lg bg-red-50 p-3' : 
                          row.highlight && row.color === 'green' ? 'rounded-lg bg-green-50 p-3' : 
                          row.highlight && row.color === 'blue' ? 'rounded-lg bg-blue-50 p-3' : ''
                        }`}
                      >
                      <span
                        className={`font-medium flex items-center gap-2 ${
                          row.highlight && row.color === 'red' ? 'text-red-900' :
                          row.highlight && row.color === 'green' ? 'text-green-900' :
                          row.highlight && row.color === 'blue' ? 'text-blue-900' : 'text-gray-700'
                        }`}
                      >
                        {row.label}
                        {row.label === "Gastos Varios" && gastos.length > 0 && (
                          <button
                            onClick={() => setGastosDropdownOpen(!gastosDropdownOpen)}
                            className="text-gray-600 hover:text-gray-800 transition-colors"
                          >
                            {gastosDropdownOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </button>
                        )}
                      </span>
                      <span
                        className={`text-lg font-semibold ${
                          row.highlight && row.color === 'red' ? 'text-red-600' :
                          row.highlight && row.color === 'green' ? 'text-green-600' :
                          row.highlight && row.color === 'blue' ? 'text-blue-600' : 'text-gray-900'
                        }`}
                      >
                        {row.value}
                      </span>
                    </div>
                    
                    {/* Dropdown de gastos individuales */}
                    {row.label === "Gastos Varios" && gastosDropdownOpen && gastos.length > 0 && (
                      <div className="mt-2 ml-6 space-y-2 border-l-2 border-red-200 pl-4">
                        {gastos.map((gasto, gastosIndex) => (
                          <div key={gastosIndex} className="flex justify-between items-center text-sm text-red-900 bg-red-100 px-3 py-2 rounded-md">
                            <span className="font-medium">{formatCurrency(gasto.monto)}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 hover:bg-red-200 text-red-600 hover:text-red-700"
                              onClick={() => {
                                setGastoToDelete(gasto)
                                setDeleteDialogOpen(true)
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-lg border border-gray-200 bg-white p-8">
                <p className="text-gray-500">
                  Selecciona un período para ver el balance
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dialog de confirmación para eliminar gasto */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>¿Eliminar gasto?</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-gray-600">
              ¿Estás seguro que deseas eliminar este gasto de{" "}
              <span className="font-semibold text-red-600">
                {gastoToDelete && formatCurrency(gastoToDelete.monto)}
              </span>?
            </p>
            <p className="text-sm text-gray-500 mt-2">
              Esta acción no se puede deshacer.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false)
                setGastoToDelete(null)
              }}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteGasto}
            >
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

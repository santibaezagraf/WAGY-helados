"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { obtenerBalance, Balance } from "@/lib/actions/balances"
import { DateRangeSelector } from "@/components/balances/date-range-selector"
import { Button } from "@/components/ui/button"
import { Header } from "@/components/ui/header"
import { ArrowLeft, Loader2 } from "lucide-react"

interface BalanceRow {
  label: string
  value: string | number
  format?: "number" | "currency"
  highlight?: boolean
}

export default function BalancesPage() {
  const router = useRouter()
  const [balance, setBalance] = React.useState<Balance | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [dateRange, setDateRange] = React.useState<{
    startDate: Date
    endDate: Date
    mode: "dia" | "semana"
  } | null>(null)

  const fetchBalance = React.useCallback(async (startDate: Date, endDate: Date) => {
    setLoading(true)
    try {
      const result = await obtenerBalance(startDate, endDate)
      setBalance(result)
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
          highlight: false,
        },
        {
          label: "Plata Efectivo (Ingreso Bruto)",
          value: formatCurrency(balance.plata_efectivo),
          highlight: false,
        },
        {
          label: "Costo de Envíos",
          value: `${formatCurrency(balance.costo_envio_total)} (${balance.cantidad_envios ?? 0})`,
          highlight: false,
        },
        {
          label: "Efectivo Final (Efectivo - Envíos)",
          value: formatCurrency(balance.efectivo_final),
          highlight: false,
        },
        {
          label: "Ingreso Total (Efectivo + Transferencia)",
          value: formatCurrency(balance.ingreso_total),
          highlight: true,
        },
      ]
    : [])
  , [balance, formatCurrency])

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="mb-6 flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.back()}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver
          </Button>
          <h1 className="text-3xl font-bold">Balance de Ventas</h1>
        </div>

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
                  <div
                    key={index}
                    className={`flex items-center justify-between border-b pb-3 last:border-b-0 ${
                      row.highlight ? "rounded-lg bg-blue-50 p-3" : ""
                    }`}
                  >
                    <span
                      className={`font-medium ${
                        row.highlight ? "text-blue-900" : "text-gray-700"
                      }`}
                    >
                      {row.label}
                    </span>
                    <span
                      className={`text-lg font-semibold ${
                        row.highlight ? "text-blue-600" : "text-gray-900"
                      }`}
                    >
                      {row.value}
                    </span>
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
    </div>
  )
}

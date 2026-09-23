"use client"

import * as React from "react"
import Link from "next/link"
import { obtenerBalance, Balance } from "@/lib/actions/balances"
import { EliminarGasto, ObtenerGastos, type Gasto } from "@/lib/actions/gastos"
import { DateRangeSelector } from "@/components/balances/date-range-selector"
import { inicioDelDiaAR, sumarDiasAR, claveDiaAR, formatearFechaAR, formatearHoraAR } from "@/lib/zona-horaria"
import { Button } from "@/components/ui/button"
import { Header } from "@/components/ui/header"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  ArrowLeft,
  Loader2,
  ChevronDown,
  ChevronUp,
  Trash2,
  IceCream,
  IceCream2,
  Banknote,
  CreditCard,
  Truck,
  Receipt,
  Wallet,
  TrendingUp,
} from "lucide-react"

type TileColor = "gray" | "red" | "blue" | "green" | "sky" | "amber"

const TILE_STYLES: Record<TileColor, { bg: string; iconBg: string; iconText: string; label: string; value: string }> = {
  gray: {
    bg: "bg-white border-gray-200",
    iconBg: "bg-gray-100",
    iconText: "text-gray-700",
    label: "text-gray-600",
    value: "text-gray-900",
  },
  sky: {
    bg: "bg-white border-sky-100",
    iconBg: "bg-sky-100",
    iconText: "text-sky-700",
    label: "text-gray-600",
    value: "text-gray-900",
  },
  amber: {
    bg: "bg-white border-amber-100",
    iconBg: "bg-amber-100",
    iconText: "text-amber-700",
    label: "text-gray-600",
    value: "text-gray-900",
  },
  red: {
    bg: "bg-red-50 border-red-100",
    iconBg: "bg-red-100",
    iconText: "text-red-700",
    label: "text-red-900",
    value: "text-red-700",
  },
  blue: {
    bg: "bg-gradient-to-br from-blue-50 to-blue-100 border-blue-200",
    iconBg: "bg-blue-500/10",
    iconText: "text-blue-700",
    label: "text-blue-900",
    value: "text-blue-700",
  },
  green: {
    bg: "bg-gradient-to-br from-emerald-50 to-emerald-100 border-emerald-200",
    iconBg: "bg-emerald-500/10",
    iconText: "text-emerald-700",
    label: "text-emerald-900",
    value: "text-emerald-700",
  },
}

interface TileProps {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon: React.ReactNode
  color?: TileColor
  size?: "sm" | "lg"
  children?: React.ReactNode
  extraAction?: React.ReactNode
}

function MetricTile({ label, value, hint, icon, color = "gray", size = "sm", children, extraAction }: TileProps) {
  const s = TILE_STYLES[color]
  return (
    <div className={`rounded-xl border shadow-sm ${s.bg}`}>
      <div className={`flex items-start gap-3 ${size === "lg" ? "p-5" : "p-4"}`}>
        <div className={`shrink-0 rounded-lg p-2 ${s.iconBg} ${s.iconText}`}>{icon}</div>
        <div className="min-w-0 flex-1">
          <div className={`flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide ${s.label}`}>
            <span className="truncate">{label}</span>
            {extraAction}
          </div>
          <div className={`mt-1 font-semibold tabular-nums ${s.value} ${size === "lg" ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl"}`}>
            {value}
          </div>
          {hint && <div className={`mt-0.5 text-xs ${s.label}`}>{hint}</div>}
        </div>
      </div>
      {children}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
      {children}
    </h2>
  )
}

export function PanelBalances() {

  const [balance, setBalance] = React.useState<Balance | null>(null)
  const [gastos, setGastos] = React.useState<Gasto[]>([])
  const [gastosDropdownOpen, setGastosDropdownOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [gastoToDelete, setGastoToDelete] = React.useState<Gasto | null>(null)
  const [dateRange, setDateRange] = React.useState<{
    startDate: Date
    endDate: Date
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

  const handleDateRangeChange = React.useCallback((startDate: Date, endDate: Date) => {
    setDateRange({ startDate, endDate })
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

      if (dateRange) {
        await fetchBalance(dateRange.startDate, dateRange.endDate)
      }
    } catch (error) {
      console.error("Error al eliminar gasto:", error)
    }
  }, [gastoToDelete, dateRange, fetchBalance])

  const textoRango = React.useMemo(() => {
    if (!dateRange) return ""
    const fmt = (d: Date) =>
      formatearFechaAR(d, { day: "numeric", month: "short" })
    const inicio = inicioDelDiaAR(dateRange.startDate)
    // endDate es el fin EXCLUSIVO (00:00 AR del día siguiente); el último día
    // inclusivo del rango es el día anterior.
    const finIncl = sumarDiasAR(dateRange.endDate, -1)
    if (claveDiaAR(inicio) === claveDiaAR(finIncl)) return fmt(inicio)
    return `${fmt(inicio)} — ${fmt(finIncl)}`
  }, [dateRange])

  return (
    <div className="min-h-screen bg-gray-50">
      <Header rol="admin" />

      <div className="mx-auto w-full px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors"
              title="Volver a pedidos"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-2xl font-bold sm:text-3xl">Balance de Ventas</h1>
          </div>
          {textoRango && (
            <div className="text-xs text-gray-500 sm:text-sm">
              Período: <span className="font-medium text-gray-700">{textoRango}</span>
            </div>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_1fr]">
          {/* Selector de fechas — sticky en desktop */}
          <aside className="lg:sticky lg:top-4 lg:self-start">
            <DateRangeSelector onDateRangeChange={handleDateRangeChange} />
          </aside>

          {/* Dashboard */}
          <main className="min-w-0">
            {loading ? (
              <div className="flex items-center justify-center rounded-xl border border-gray-200 bg-white p-16">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
                <span className="ml-3 text-gray-600">Cargando balance...</span>
              </div>
            ) : balance ? (
              <div className="space-y-6">
                {/* Totales destacados */}
                <section>
                  <SectionTitle>Totales</SectionTitle>
                  <div className="grid gap-4 md:grid-cols-2">
                    <MetricTile
                      label="Ingreso Total"
                      hint="Efectivo + Transferencia"
                      value={formatCurrency(balance.ingreso_total)}
                      icon={<TrendingUp className="h-5 w-5" />}
                      color="green"
                      size="lg"
                    />
                    <MetricTile
                      label="Efectivo Final"
                      hint="Efectivo bruto − envíos − gastos"
                      value={formatCurrency(balance.efectivo_final)}
                      icon={<Wallet className="h-5 w-5" />}
                      color="blue"
                      size="lg"
                    />
                  </div>
                </section>

                {/* Cantidades */}
                <section>
                  <SectionTitle>Helados vendidos</SectionTitle>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <MetricTile
                      label="Agua"
                      value={balance.total_agua}
                      icon={<IceCream2 className="h-5 w-5" />}
                      color="sky"
                    />
                    <MetricTile
                      label="Crema"
                      value={balance.total_crema}
                      icon={<IceCream className="h-5 w-5" />}
                      color="amber"
                    />
                  </div>
                </section>

                {/* Ingresos brutos */}
                <section>
                  <SectionTitle>Ingresos brutos</SectionTitle>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <MetricTile
                      label="Transferencia"
                      value={formatCurrency(balance.plata_transferencia)}
                      icon={<CreditCard className="h-5 w-5" />}
                      color="gray"
                    />
                    <MetricTile
                      label="Efectivo"
                      value={formatCurrency(balance.plata_efectivo)}
                      icon={<Banknote className="h-5 w-5" />}
                      color="gray"
                    />
                  </div>
                </section>

                {/* Costos */}
                <section>
                  <SectionTitle>Costos</SectionTitle>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <MetricTile
                      label="Envíos"
                      value={formatCurrency(balance.costo_envio_total)}
                      hint={`${balance.cantidad_envios ?? 0} envíos`}
                      icon={<Truck className="h-5 w-5" />}
                      color="red"
                    />
                    <MetricTile
                      label="Gastos varios"
                      value={formatCurrency(balance.total_gastos)}
                      hint={`${balance.cantidad_gastos ?? 0} gastos`}
                      icon={<Receipt className="h-5 w-5" />}
                      color="red"
                      extraAction={
                        gastos.length > 0 && (
                          <button
                            onClick={() => setGastosDropdownOpen((v) => !v)}
                            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-700 hover:bg-red-100"
                            aria-expanded={gastosDropdownOpen}
                          >
                            {gastosDropdownOpen ? "Ocultar" : "Ver detalle"}
                            {gastosDropdownOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          </button>
                        )
                      }
                    >
                      {gastosDropdownOpen && gastos.length > 0 && (
                        <div className="border-t border-red-200/60 bg-red-50/60 px-4 py-3">
                          <div className="grid gap-2 sm:grid-cols-2">
                            {gastos.map((gasto) => {
                              const fecha = new Date(gasto.created_at)
                              return (
                                <div
                                  key={gasto.id}
                                  className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm"
                                >
                                  <div className="min-w-0">
                                    <div className="font-medium tabular-nums text-red-900">
                                      {formatCurrency(gasto.monto)}
                                    </div>
                                    {gasto.concepto && (
                                      <div className="truncate text-xs text-red-800" title={gasto.concepto}>
                                        {gasto.concepto}
                                      </div>
                                    )}
                                    <div className="text-[11px] text-red-700/70">
                                      {formatearFechaAR(fecha, { day: "numeric", month: "short" })} · {formatearHoraAR(fecha)}
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 shrink-0 p-0 text-red-600 hover:bg-red-100 hover:text-red-700"
                                    onClick={() => {
                                      setGastoToDelete(gasto)
                                      setDeleteDialogOpen(true)
                                    }}
                                    aria-label={`Eliminar gasto de ${formatCurrency(gasto.monto)}`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </MetricTile>
                  </div>
                </section>
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-xl border border-gray-200 bg-white p-16">
                <p className="text-gray-500">Seleccioná un período para ver el balance</p>
              </div>
            )}
          </main>
        </div>
      </div>

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
              </span>
              {gastoToDelete?.concepto && <> ({gastoToDelete.concepto})</>}?
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

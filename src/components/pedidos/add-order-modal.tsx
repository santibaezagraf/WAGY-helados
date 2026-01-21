"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createClient } from "@/lib/supabase-client"
import { calcularPreciosUnitarios, obtenerReglasListaActiva, ReglaPrecios } from "@/lib/precio-utils"
import { PedidoInsert } from "@/types/pedidos"
import { IceCream, Droplet, Banknote, CreditCard, AlertCircle } from "lucide-react"
import { Logo } from "@/components/ui/logo"
import { crearPedido } from "@/lib/actions/pedidos"
import { useRouter } from "next/navigation"

interface AddOrderModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AddOrderModal({ open, onOpenChange }: AddOrderModalProps) {
  const [step, setStep] = React.useState(1)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [isCalculating, setIsCalculating] = React.useState(false)

  //Estado para las reglas
  const [reglas, setReglas] = React.useState<ReglaPrecios[]>([])
  // const [errorPrecios, setErrorPrecios] = React.useState<string | null>(null)

  // Precios unitarios dinámicos
  const [precioUnitarioAgua, setPrecioUnitarioAgua] = React.useState(0)
  const [precioUnitarioCrema, setPrecioUnitarioCrema] = React.useState(0)
  const [errorPrecios, setErrorPrecios] = React.useState<string | null>(null)
  
  // Step 1: Cantidades (como strings para mejor UX en inputs)
  const [cantidadCremaStr, setCantidadCremaStr] = React.useState<string>("")
  const [cantidadAguaStr, setCantidadAguaStr] = React.useState<string>("")

  // Convertir a números para cálculos
  const cantidadCrema = parseInt(cantidadCremaStr) || 0
  const cantidadAgua = parseInt(cantidadAguaStr) || 0

  const [totalAguaEditado, setTotalAguaEditado] = React.useState<boolean>(false)
  const [totalCremaEditado, setTotalCremaEditado] = React.useState<boolean>(false)

  const [totalAguaManualStr, setTotalAguaManualStr] = React.useState<string>("")
  const [totalCremaManualStr, setTotalCremaManualStr] = React.useState<string>("")

  // Step 2: Detalles
  const [direccion, setDireccion] = React.useState("")
  const [telefono, setTelefono] = React.useState("")
  const [aclaracion, setAclaracion] = React.useState("")
  const [observaciones, setObservaciones] = React.useState("")
  const [metodoPago, setMetodoPago] = React.useState<"transferencia" | "efectivo">("efectivo")
  const [costoEnvioStr, setCostoEnvioStr] = React.useState("0")

  const costoEnvio = parseInt(costoEnvioStr) || 0

  let totalCrema = totalCremaEditado
    ? totalCremaManualStr
    : (cantidadCrema * precioUnitarioCrema).toString()

  let totalAgua = totalAguaEditado
    ? totalAguaManualStr
    : (cantidadAgua * precioUnitarioAgua).toString()

  const subtotal = parseInt(totalCrema || "0") + parseInt(totalAgua || "0")
  const total = subtotal - costoEnvio

  const router = useRouter()

  // Cargar reglas de precios al abrir el modal
  React.useEffect(() => {
    if (!open) return

    const cargarReglas = async () => {
      try {
        setIsCalculating(true)
        setErrorPrecios(null)

        const reglasObtenidas = await obtenerReglasListaActiva()
        setReglas(reglasObtenidas)
      } catch (error) {
        console.error("Error al obtener reglas de precios:", error)
        setErrorPrecios(error instanceof Error ? error.message : "Error desconocido al obtener reglas de precios")
        setReglas([])
      } finally {
        setIsCalculating(false)
      }
    }

    cargarReglas()
  }, [open])


  React.useEffect(() => {
    if (reglas.length === 0) {
      setPrecioUnitarioAgua(0)
      setPrecioUnitarioCrema(0)
      setErrorPrecios("No se pueden calcular los precios sin reglas de precios.")
      return
    }

    const timeoutId = setTimeout(async () => {
      if (cantidadAgua === 0 && cantidadCrema === 0) {
        setPrecioUnitarioAgua(0)
        setPrecioUnitarioCrema(0)
        setErrorPrecios(null)
        return
      }

      setIsCalculating(true)
      setErrorPrecios(null)

      try {
        console.log("Calculando precios para:", { cantidadAgua, cantidadCrema });

        const precios = calcularPreciosUnitarios(cantidadAgua, cantidadCrema, reglas)
        setPrecioUnitarioAgua(precios.precioAgua)
        setPrecioUnitarioCrema(precios.precioCrema)
      } catch (error) {
        console.error("Error al calcular precios:", error)
        setErrorPrecios(error instanceof Error ? error.message : "Error desconocido al calcular precios")
        setPrecioUnitarioAgua(0)
        setPrecioUnitarioCrema(0)
      } finally {
        setIsCalculating(false)
      }
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [cantidadAgua, cantidadCrema, reglas])

  const resetForm = () => {
    setStep(1)
    setCantidadCremaStr("")
    setCantidadAguaStr("")
    setDireccion("")
    setTelefono("")
    setAclaracion("")
    setObservaciones("")
    setMetodoPago("efectivo")
    setCostoEnvioStr("")
    setTotalAguaManualStr("")
    setTotalCremaManualStr("")
    setTotalAguaEditado(false)
    setTotalCremaEditado(false)
  }



  const handleNext = () => {
    if (cantidadCrema > 0 || cantidadAgua > 0) {
      setStep(2)
    }
  }

  const handleBack = () => {
    setStep(1)
    setTotalAguaManualStr("")
    setTotalCremaManualStr("")
    setTotalAguaEditado(false)
    setTotalCremaEditado(false)
  }

  const handleSubmit = async () => {
    if (!direccion || !telefono) {
      alert("Por favor completa los campos obligatorios (Dirección y Teléfono)")
      return
    }

    setIsSubmitting(true)

    try {
      await crearPedido({
        direccion,
        telefono,
        cantidad_agua: cantidadAgua,
        cantidad_crema: cantidadCrema,
        metodo_pago: metodoPago,
        costo_envio: costoEnvio,
        aclaracion: aclaracion || null,
        observaciones: observaciones || null,
        monto_total_agua: parseInt(totalAgua || "0"),
        monto_total_crema: parseInt(totalCrema || "0"),
      })
      resetForm()
      onOpenChange(false)
      router.refresh()
    } catch (error) {
      console.error("Error:", error)
      alert("Error al crear el pedido: " + (error as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

  

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-[600px] max-h-[90vh] overflow-y-auto bg-gradient-to-br from-white to-cyan-50">
        <DialogHeader className="pb-4">
          <div className="flex justify-center mb-3">
            <Logo size="sm" />
          </div>
          <DialogTitle className="text-2xl sm:text-3xl font-bold text-center text-slate-800">
            {step === 1 ? "Cantidades" : "Detalles del pedido"}
          </DialogTitle>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4 sm:space-y-6 py-4 sm:py-6">
            {/* Helados de Crema */}
            <div className="bg-white rounded-xl p-4 sm:p-6 shadow-lg border-2 border-slate-200 hover:border-cyan-400 transition-colors">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-xl sm:text-2xl font-bold text-slate-800 flex items-center gap-2">
                    <IceCream className="h-6 w-6 text-cyan-600" />
                    Helados de Crema
                  </h3>
                  <p className="text-sm text-slate-600">${precioUnitarioCrema} c/u</p>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:gap-4">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setCantidadCremaStr(Math.max(0, cantidadCrema - 1).toString())}
                  className="w-10 h-10 sm:w-12 sm:h-12 rounded-full text-lg sm:text-xl font-bold bg-slate-500 text-white hover:bg-slate-600 flex-shrink-0"
                >
                  -
                </Button>
                <div className="flex-1">
                  <Input
                  type="number"
                  value={cantidadCremaStr}
                  onChange={(e) => {
                    const value = e.target.value
                    // Permitir vacío o números válidos
                    if (value === "" || /^\d+$/.test(value)) {
                    setCantidadCremaStr(value)
                    }
                  }}
                  onWheel={(e) => e.currentTarget.blur()}
                  placeholder="0"
                  className="h-14 sm:h-16 text-center text-2xl sm:text-4xl font-bold text-cyan-600 border-2 border-cyan-300 placeholder:text-cyan-400"
                  min="0"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setCantidadCremaStr((cantidadCrema + 1).toString())}
                  className="w-10 h-10 sm:w-12 sm:h-12 rounded-full text-lg sm:text-xl font-bold bg-cyan-600 text-white hover:bg-cyan-700 flex-shrink-0"
                >
                  +
                </Button>
              </div>
              <div className="flex gap-2 mt-4 flex-wrap justify-center">
                <button
                  type="button"
                  onClick={() => setCantidadCremaStr('30')}
                  className="px-3 py-1 text-sm font-semibold bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors"
                >
                  30
                </button>
                <button
                  type="button"
                  onClick={() => setCantidadCremaStr('60')}
                  className="px-3 py-1 text-sm font-semibold bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors"
                >
                  60
                </button>
              </div>
              {cantidadCrema > 0 && (
                <div className="mt-3 text-center text-base sm:text-lg font-semibold text-slate-700">
                  Subtotal: ${totalCrema}
                </div>
              )}
            </div>

            {/* Helados de Agua */}
            <div className="bg-white rounded-xl p-4 sm:p-6 shadow-lg border-2 border-slate-200 hover:border-cyan-400 transition-colors">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-xl sm:text-2xl font-bold text-slate-800 flex items-center gap-2">
                    <Droplet className="h-6 w-6 text-cyan-600" />
                    Helados de Agua
                  </h3>
                  <p className="text-sm text-slate-600">${precioUnitarioAgua} c/u</p>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:gap-4">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setCantidadAguaStr(Math.max(0, cantidadAgua - 1).toString())}
                  className="w-10 h-10 sm:w-12 sm:h-12 rounded-full text-lg sm:text-xl font-bold bg-slate-500 text-white hover:bg-slate-600 flex-shrink-0"
                >
                  -
                </Button>
                <div className="flex-1">
                  <Input
                    type="number"
                    value={cantidadAguaStr}
                    onChange={(e) => {
                      const value = e.target.value
                      // Permitir vacío o números válidos
                      if (value === "" || /^\d+$/.test(value)) {
                        setCantidadAguaStr(value)
                      }
                    }}
                    onWheel={(e) => e.currentTarget.blur()}
                    placeholder="0"
                    className="h-14 sm:h-16 text-center text-2xl sm:text-4xl font-bold text-cyan-600 border-2 border-cyan-300 placeholder:text-cyan-400"
                    min="0"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setCantidadAguaStr((cantidadAgua + 1).toString())}
                  className="w-10 h-10 sm:w-12 sm:h-12 rounded-full text-lg sm:text-xl font-bold bg-cyan-600 text-white hover:bg-cyan-700 flex-shrink-0"
                >
                  +
                </Button>
              </div>
              <div className="flex gap-2 mt-4 flex-wrap justify-center">
                <button
                  type="button"
                  onClick={() => setCantidadAguaStr('50')}
                  className="px-3 py-1 text-sm font-semibold bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors"
                >
                  50
                </button>
                <button
                  type="button"
                  onClick={() => setCantidadAguaStr('100')}
                  className="px-3 py-1 text-sm font-semibold bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors"
                >
                  100
                </button>
                <button
                  type="button"
                  onClick={() => setCantidadAguaStr('200')}
                  className="px-3 py-1 text-sm font-semibold bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors"
                >
                  200
                </button>
              </div>
              {cantidadAgua > 0 && (
                <div className="mt-3 text-center text-base sm:text-lg font-semibold text-slate-700">
                  Subtotal: ${totalAgua}
                </div>
              )}
            </div>

            {/* Error de precios */}
            {errorPrecios && (
              <div className="bg-red-50 border-2 border-red-300 rounded-xl p-3 sm:p-4 text-red-700 text-center text-sm sm:text-base flex items-center justify-center gap-2">
                <AlertCircle className="h-5 w-5" />
                {errorPrecios}
              </div>
            )}

            {/* Total */}
            {(cantidadCrema > 0 || cantidadAgua > 0) && (
              <div className="bg-cyan-50 rounded-xl p-4 border-2 border-cyan-300">
                <div className="text-center">
                  <p className="text-sm text-slate-600">Total de productos</p>
                  <p className="text-2xl sm:text-3xl font-bold text-cyan-700">${subtotal}</p>
                </div>
              </div>
            )}

            <Button
              type="button"
              onClick={handleNext}
              disabled={cantidadCrema === 0 && cantidadAgua === 0}
              className="w-full h-12 sm:h-14 text-lg sm:text-xl font-bold bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl"
            >
              Siguiente →
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="direccion" className="text-base font-semibold">
                  Dirección *
                </Label>
                <Input
                  id="direccion"
                  placeholder="Calle, número, depto..."
                  value={direccion}
                  onChange={(e) => setDireccion(e.target.value)}
                  className="h-12 text-base"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="telefono" className="text-base font-semibold">
                  Teléfono *
                </Label>
                <Input
                  id="telefono"
                  placeholder="+54 9 ..."
                  value={telefono}
                  onChange={(e) => setTelefono(e.target.value)}
                  className="h-12 text-base"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="aclaracion" className="text-base font-semibold">
                  Aclaraciones
                </Label>
                <Input
                  id="aclaracion"
                  placeholder="Entre calles, punto de referencia..."
                  value={aclaracion}
                  onChange={(e) => setAclaracion(e.target.value)}
                  className="h-12 text-base"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="observaciones" className="text-base font-semibold">
                  Observaciones
                </Label>
                <Input
                  id="observaciones"
                  placeholder="Notas adicionales del pedido..."
                  value={observaciones}
                  onChange={(e) => setObservaciones(e.target.value)}
                  className="h-12 text-base"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="metodoPago" className="text-base font-semibold">
                  Método de Pago *
                </Label>
                <Select value={metodoPago} onValueChange={(value: "transferencia" | "efectivo") => setMetodoPago(value)}>
                  <SelectTrigger className="h-12 text-base">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="efectivo" className="gap-2">
                      <Banknote className="inline h-4 w-4 mx-1" />
                      Efectivo
                    </SelectItem>
                    <SelectItem value="transferencia" className="gap-2">
                      <CreditCard className="inline h-4 w-4 mx-1" />
                      Transferencia
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="costoEnvio" className="text-base font-semibold">
                  Costo de Envío
                </Label>
                <Input
                  id="costoEnvio"
                  type="number"
                  placeholder="0"
                  value={costoEnvioStr}
                  onChange={(e) => {
                    const value = e.target.value
                    // Permitir vacío o números válidos
                    if (value === "" || /^\d+$/.test(value)) {
                    setCostoEnvioStr(value)
                    }
                  }}
                  onWheel={(e) => e.currentTarget.blur()}
                  className="h-12 text-base"
                  min="0"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="precioAgua" className="text-base font-semibold">
                  Precio total Agua
                </Label>
                <Input
                  id="precioAgua"
                  type="number"
                  placeholder="0"
                  value={totalAgua}
                  onChange={((e) => {
                    const value = e.target.value
                    // Permitir vacío o números válidos
                    if (value === "" || /^\d+$/.test(value)) {
                      setTotalAguaManualStr(value)
                      setTotalAguaEditado(true)
                    }
                  })}
                  onWheel={(e) => e.currentTarget.blur()}
                  min="0"
                  className="h-12 text-base"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="precioCrema" className="text-base font-semibold">
                  Precio total Crema
                </Label>
                <Input
                  id="precioCrema"
                  type="number"
                  placeholder="0"
                  value={totalCrema}
                  onChange={(e) => {
                    const value = e.target.value
                    // Permitir vacío o números válidos
                    if (value === "" || /^\d+$/.test(value)) {
                      setTotalCremaManualStr(value)
                      setTotalCremaEditado(true)
                    }
                  }}
                  onWheel={(e) => e.currentTarget.blur()}
                  min="0"
                  className="h-12 text-base"
                />
              </div>


            </div>

            {/* Resumen */}
            <div className="bg-cyan-50 rounded-xl p-4 border-2 border-cyan-300 space-y-1">
              <div className="flex justify-between text-sm">
                <span>Helados de crema ({cantidadCrema}x):</span>
                <span className="font-semibold">${totalCrema}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>Helados de agua ({cantidadAgua}x):</span>
                <span className="font-semibold">${totalAgua}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>Envío:</span>
                <span className="font-semibold">${costoEnvio}</span>
              </div>
              <div className="border-t-2 border-cyan-600 pt-2 mt-2 flex justify-between">
                <span className="font-bold text-base sm:text-lg">GANANCIA TOTAL:</span>
                <span className="font-bold text-base sm:text-lg text-cyan-700">${total}</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleBack}
                className="flex-1 h-12 text-base sm:text-lg font-semibold"
              >
                ← Volver
              </Button>
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting || !direccion || !telefono}
                className="flex-1 h-12 text-base sm:text-lg font-bold bg-cyan-600 hover:bg-cyan-700 text-white"
              >
                {isSubmitting ? "Creando..." : "Confirmar Pedido"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

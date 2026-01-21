"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createClient } from "@/lib/supabase-client"
import { Pedido } from "@/types/pedidos"
import { Check, Clock, X, IceCream, Droplet, Banknote, CreditCard } from "lucide-react"
import { calcularPreciosUnitarios, obtenerReglasListaActiva, ReglaPrecios } from "@/lib/precio-utils"
import { Logo } from "@/components/ui/logo"
import { actualizarPedidoCompleto } from "@/lib/actions/pedidos"
import { useRouter } from "next/navigation"

interface EditOrderModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  pedido: Pedido
}

export function EditOrderModal({ open, onOpenChange, pedido }: EditOrderModalProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  
  // Estados con valores iniciales del pedido
  const [cantidadCremaStr, setCantidadCremaStr] = React.useState<string>("")
  const [cantidadAguaStr, setCantidadAguaStr] = React.useState<string>("")
  const [direccion, setDireccion] = React.useState("")
  const [telefono, setTelefono] = React.useState("")
  const [aclaracion, setAclaracion] = React.useState("")
  const [observaciones, setObservaciones] = React.useState("")
  const [metodoPago, setMetodoPago] = React.useState<"transferencia" | "efectivo">("efectivo")
  const [costoEnvioStr, setCostoEnvioStr] = React.useState("")

  const [precioUnitarioAgua, setPrecioUnitarioAgua] = React.useState<number | null>(0)
  const [precioUnitarioCrema, setPrecioUnitarioCrema] = React.useState<number | null>(0)

  const [totalAguaEditado, setTotalAguaEditado] = React.useState<boolean>(false)
  const [totalCremaEditado, setTotalCremaEditado] = React.useState<boolean>(false)
  const [totalAguaManualStr, setTotalAguaManualStr] = React.useState<string>("")
  const [totalCremaManualStr, setTotalCremaManualStr] = React.useState<string>("")
  const [estado, setEstado] = React.useState<"pendiente" | "enviado" | "cancelado">("pendiente")
  const [pagado, setPagado] = React.useState(false)

  // Estado para las reglas de precios
  const [reglas, setReglas] = React.useState<ReglaPrecios[]>([])

  const router = useRouter()

  // Actualizar estados cuando cambia el pedido o se abre el modal
  React.useEffect(() => {

    if (open) {
      setCantidadCremaStr(pedido.cantidad_crema.toString())
      setCantidadAguaStr(pedido.cantidad_agua.toString())
      setDireccion(pedido.direccion)
      setTelefono(pedido.telefono)
      setAclaracion(pedido.aclaracion || "")
      setObservaciones(pedido.observaciones || "")
      setMetodoPago(pedido.metodo_pago as "transferencia" | "efectivo")
      setCostoEnvioStr(pedido.costo_envio.toString())
      setPrecioUnitarioAgua(pedido.precio_unitario_agua)
      setPrecioUnitarioCrema(pedido.precio_unitario_crema)
      setTotalAguaManualStr(pedido.monto_total_agua?.toString() || "")
      setTotalCremaManualStr(pedido.monto_total_crema?.toString() || "")
      setEstado(pedido.estado as "pendiente" | "enviado" | "cancelado")
      setPagado(pedido.pagado || false)
      setTotalAguaEditado(true)
      setTotalCremaEditado(true)

      const cargarReglas = async () => {
        try {
            const reglasObtenidas = await obtenerReglasListaActiva()
            setReglas(reglasObtenidas)
        } catch (error) {
            console.error("Error al obtener reglas de precios:", error)
            setReglas([])
        }
      }

      cargarReglas()

    } else return
  }, [pedido, open])

  const cantidadCrema = parseInt(cantidadCremaStr) || 0
  const cantidadAgua = parseInt(cantidadAguaStr) || 0
  const costoEnvio = parseInt(costoEnvioStr) || 0

  const totalCrema = totalCremaEditado
    ? totalCremaManualStr
    : (cantidadCrema * (precioUnitarioCrema ?? 0)).toString()

  const totalAgua = totalAguaEditado
    ? totalAguaManualStr
    : (cantidadAgua * (precioUnitarioAgua ?? 0)).toString()
  const subtotal = parseInt(totalCrema || "0") + parseInt(totalAgua || "0")
  const total = subtotal - costoEnvio

  React.useEffect(() => {
    const timeoutId = setTimeout(async () => {
        if (cantidadAgua === 0 && cantidadCrema === 0) {
            setPrecioUnitarioAgua(0)
            setPrecioUnitarioCrema(0)
            return
        }

        try {
            const precios = calcularPreciosUnitarios(cantidadAgua, cantidadCrema, reglas)
            setPrecioUnitarioAgua(precios.precioAgua)
            setPrecioUnitarioCrema(precios.precioCrema)
        } catch (error) {
            console.error("Error al calcular precios unitarios:", error)
            setPrecioUnitarioAgua(0)
            setPrecioUnitarioCrema(0)
        } 
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [cantidadAgua, cantidadCrema, reglas])

  

  const handleSubmit = async () => {
    if (!direccion || !telefono) {
      alert("Por favor completa los campos obligatorios (Dirección y Teléfono)")
      return
    }

    setIsSubmitting(true)

    try {
      await actualizarPedidoCompleto(pedido.id, {
        direccion,
        telefono,
        cantidad_agua: cantidadAgua,
        cantidad_crema: cantidadCrema,
        metodo_pago: metodoPago,
        estado,
        pagado,
        costo_envio: costoEnvio,
        aclaracion: aclaracion || null,
        observaciones: observaciones || null,
        monto_total_agua: parseInt(totalAgua || "0"),
        monto_total_crema: parseInt(totalCrema || "0"),
      })
      onOpenChange(false)
      router.refresh()
    } catch (error) {
      console.error("Error:", error)
      alert("Error al actualizar el pedido: " + (error as Error).message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-[700px] max-h-[90vh] overflow-y-auto bg-gradient-to-br from-white to-cyan-50">
        <DialogHeader className="pb-4">
          <div className="flex justify-center mb-3">
            <Logo size="sm" />
          </div>
          <DialogTitle className="text-2xl sm:text-3xl font-bold text-center text-slate-800">
            Editar Pedido #{pedido.id}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Cantidades de Helados */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="cantidadAgua" className="text-base font-semibold flex items-center gap-2">
                <Droplet className="h-4 w-4 text-cyan-600" />
                Helados de Agua
              </Label>
              <Input
                id="cantidadAgua"
                type="number"
                value={cantidadAguaStr}
                onChange={(e) => {
                  const value = e.target.value
                  if (value === "" || /^\d+$/.test(value)) {
                    setCantidadAguaStr(value)
                    setTotalAguaEditado(false)
                  }
                }}
                onWheel={(e) => e.currentTarget.blur()}
                placeholder="0"
                className="h-12 text-base"
                min="0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="cantidadCrema" className="text-base font-semibold flex items-center gap-2">
                <IceCream className="h-4 w-4 text-cyan-600" />
                Helados de Crema
              </Label>
              <Input
                id="cantidadCrema"
                type="number"
                value={cantidadCremaStr}
                onChange={(e) => {
                  const value = e.target.value
                  if (value === "" || /^\d+$/.test(value)) {
                    setCantidadCremaStr(value)
                    setTotalCremaEditado(false)
                  }
                }}
                onWheel={(e) => e.currentTarget.blur()}
                placeholder="0"
                className="h-12 text-base"
                min="0"
              />
            </div>
          </div>

          {/* Precios totales */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="totalAgua" className="text-base font-semibold">
                Total Agua
              </Label>
              <Input
                id="totalAgua"
                type="number"
                value={totalAgua}
                onChange={(e) => {
                  const value = e.target.value
                  if (value === "" || /^\d+$/.test(value)) {
                    setTotalAguaManualStr(value)
                    setTotalAguaEditado(true)
                  }
                }}
                onWheel={(e) => e.currentTarget.blur()}
                placeholder="0"
                className="h-12 text-base"
                min="0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="totalCrema" className="text-base font-semibold">
                Total Crema
              </Label>
              <Input
                id="totalCrema"
                type="number"
                value={totalCrema}
                onChange={(e) => {
                  const value = e.target.value
                  if (value === "" || /^\d+$/.test(value)) {
                    setTotalCremaManualStr(value)
                    setTotalCremaEditado(true)
                  }
                }}
                onWheel={(e) => e.currentTarget.blur()}
                placeholder="0"
                className="h-12 text-base"
                min="0"
              />
            </div>
          </div>

          {/* Dirección */}
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

          {/* Teléfono */}
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

          {/* Aclaraciones */}
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

          {/* Observaciones */}
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

          {/* Método de pago y Costo de envío */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  if (value === "" || /^\d+$/.test(value)) {
                    setCostoEnvioStr(value)
                  }
                }}
                onWheel={(e) => e.currentTarget.blur()}
                className="h-12 text-base"
                min="0"
              />
            </div>
          </div>

          {/* Estado y Pagado */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="estado" className="text-base font-semibold">
                Estado
              </Label>
              <Select value={estado} onValueChange={(value: "pendiente" | "enviado" | "cancelado") => setEstado(value)}>
                <SelectTrigger className="h-12 text-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pendiente" className="gap-2 text-gray-700 hover:text-gray-800 hover:bg-gray-50 focus:bg-gray-50 focus:text-gray-800">
                    <Clock className="inline h-4 w-4 text-gray-500 mx-1" />
                    Pendiente
                  </SelectItem>
                  <SelectItem value="enviado" className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800">
                    <Check className="inline h-4 w-4 mx-1 text-green-500" />
                    Enviado
                </SelectItem>
                  <SelectItem value="cancelado" className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800">
                    <X className="inline h-4 w-4 mx-1" />
                    Cancelado
                </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pagado" className="text-base font-semibold">
                Pagado
              </Label>
              <Select value={pagado ? "true" : "false"} onValueChange={(value) => setPagado(value === "true")}>
                <SelectTrigger className="h-12 text-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true" className="gap-2 text-green-700 hover:text-green-800 hover:bg-green-50 focus:bg-green-50 focus:text-green-800">
                    <Check className="inline h-4 w-4 mx-1 text-green-500" />
                    Sí
                </SelectItem>
                  <SelectItem value="false" className="gap-2 text-red-700 hover:text-red-800 hover:bg-red-50 focus:bg-red-50 focus:text-red-800">
                    <X className="inline h-4 w-4 mx-1" />
                    No
                </SelectItem>
                </SelectContent>
              </Select>
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

          {/* Botones */}
          <div className="flex flex-col sm:flex-row gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="flex-1 h-12 text-base sm:text-lg font-semibold"
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || !direccion || !telefono}
              className="flex-1 h-12 text-base sm:text-lg font-bold bg-cyan-600 hover:bg-cyan-700 text-white"
            >
              {isSubmitting ? "Guardando..." : "Guardar Cambios"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

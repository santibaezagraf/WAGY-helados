"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createClient } from "@/lib/supabase-client"
import { PedidoInsert } from "@/types/pedidos"

interface AddOrderModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOrderAdded: () => void
}

export function AddOrderModal({ open, onOpenChange, onOrderAdded }: AddOrderModalProps) {
  const [step, setStep] = React.useState(1)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  
  // Step 1: Cantidades
  const [cantidadCrema, setCantidadCrema] = React.useState(0)
  const [cantidadAgua, setCantidadAgua] = React.useState(0)

  // Step 2: Detalles
  const [direccion, setDireccion] = React.useState("")
  const [telefono, setTelefono] = React.useState("")
  const [aclaracion, setAclaracion] = React.useState("")
  const [observaciones, setObservaciones] = React.useState("")
  const [metodoPago, setMetodoPago] = React.useState<"transferencia" | "efectivo">("efectivo")
  const [costoEnvio, setCostoEnvio] = React.useState(0)

  const resetForm = () => {
    setStep(1)
    setCantidadCrema(0)
    setCantidadAgua(0)
    setDireccion("")
    setTelefono("")
    setAclaracion("")
    setObservaciones("")
    setMetodoPago("efectivo")
    setCostoEnvio(0)
  }

  const handleNext = () => {
    if (cantidadCrema > 0 || cantidadAgua > 0) {
      setStep(2)
    }
  }

  const handleBack = () => {
    setStep(1)
  }

  const handleSubmit = async () => {
    if (!direccion || !telefono) {
      alert("Por favor completa los campos obligatorios (Dirección y Teléfono)")
      return
    }

    setIsSubmitting(true)

    try {
      const supabase = createClient()
      
      const nuevoPedido: PedidoInsert = {
        direccion,
        telefono,
        cantidad_agua: cantidadAgua,
        cantidad_crema: cantidadCrema,
        metodo_pago: metodoPago,
        estado: "pendiente",
        precio_unitario_agua: 500, // Precio por defecto, puedes ajustarlo
        precio_unitario_crema: 700, // Precio por defecto, puedes ajustarlo
        costo_envio: costoEnvio,
        aclaracion: aclaracion || null,
        observaciones: observaciones || null,
      }

      const { error } = await supabase.from("pedidos").insert([nuevoPedido])

      if (error) {
        console.error("Error al crear pedido:", error)
        alert("Error al crear el pedido: " + error.message)
      } else {
        resetForm()
        onOpenChange(false)
        onOrderAdded()
      }
    } catch (error) {
      console.error("Error:", error)
      alert("Error inesperado al crear el pedido")
    } finally {
      setIsSubmitting(false)
    }
  }

  const totalCrema = cantidadCrema * 700
  const totalAgua = cantidadAgua * 500
  const subtotal = totalCrema + totalAgua
  const total = subtotal + costoEnvio

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] bg-gradient-to-br from-red-50 to-yellow-50">
        <DialogHeader>
          <DialogTitle className="text-3xl font-bold text-center text-red-600">
            {step === 1 ? "¿Qué vas a pedir?" : "Detalles del pedido"}
          </DialogTitle>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-6 py-6">
            {/* Helados de Crema */}
            <div className="bg-white rounded-xl p-6 shadow-lg border-2 border-yellow-200 hover:border-yellow-400 transition-colors">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-2xl font-bold text-gray-800">🍦 Helados de Crema</h3>
                  <p className="text-sm text-gray-600">$700 c/u</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setCantidadCrema(Math.max(0, cantidadCrema - 1))}
                  className="w-12 h-12 rounded-full text-xl font-bold bg-red-500 text-white hover:bg-red-600"
                >
                  -
                </Button>
                <div className="flex-1 text-center">
                  <span className="text-4xl font-bold text-red-600">{cantidadCrema}</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setCantidadCrema(cantidadCrema + 1)}
                  className="w-12 h-12 rounded-full text-xl font-bold bg-green-500 text-white hover:bg-green-600"
                >
                  +
                </Button>
              </div>
              {cantidadCrema > 0 && (
                <div className="mt-3 text-center text-lg font-semibold text-gray-700">
                  Subtotal: ${totalCrema}
                </div>
              )}
            </div>

            {/* Helados de Agua */}
            <div className="bg-white rounded-xl p-6 shadow-lg border-2 border-blue-200 hover:border-blue-400 transition-colors">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-2xl font-bold text-gray-800">🧊 Helados de Agua</h3>
                  <p className="text-sm text-gray-600">$500 c/u</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setCantidadAgua(Math.max(0, cantidadAgua - 1))}
                  className="w-12 h-12 rounded-full text-xl font-bold bg-red-500 text-white hover:bg-red-600"
                >
                  -
                </Button>
                <div className="flex-1 text-center">
                  <span className="text-4xl font-bold text-blue-600">{cantidadAgua}</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => setCantidadAgua(cantidadAgua + 1)}
                  className="w-12 h-12 rounded-full text-xl font-bold bg-green-500 text-white hover:bg-green-600"
                >
                  +
                </Button>
              </div>
              {cantidadAgua > 0 && (
                <div className="mt-3 text-center text-lg font-semibold text-gray-700">
                  Subtotal: ${totalAgua}
                </div>
              )}
            </div>

            {/* Total */}
            {(cantidadCrema > 0 || cantidadAgua > 0) && (
              <div className="bg-yellow-100 rounded-xl p-4 border-2 border-yellow-400">
                <div className="text-center">
                  <p className="text-sm text-gray-600">Total de productos</p>
                  <p className="text-3xl font-bold text-yellow-700">${subtotal}</p>
                </div>
              </div>
            )}

            <Button
              type="button"
              onClick={handleNext}
              disabled={cantidadCrema === 0 && cantidadAgua === 0}
              className="w-full h-14 text-xl font-bold bg-green-500 hover:bg-green-600 text-white rounded-xl"
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
                    <SelectItem value="efectivo">💵 Efectivo</SelectItem>
                    <SelectItem value="transferencia">🏦 Transferencia</SelectItem>
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
                  value={costoEnvio}
                  onChange={(e) => setCostoEnvio(Number(e.target.value))}
                  className="h-12 text-base"
                />
              </div>
            </div>

            {/* Resumen */}
            <div className="bg-yellow-100 rounded-xl p-4 border-2 border-yellow-400 space-y-1">
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
              <div className="border-t-2 border-yellow-600 pt-2 mt-2 flex justify-between">
                <span className="font-bold text-lg">TOTAL:</span>
                <span className="font-bold text-lg text-yellow-700">${total}</span>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleBack}
                className="flex-1 h-12 text-lg font-semibold"
              >
                ← Volver
              </Button>
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting || !direccion || !telefono}
                className="flex-1 h-12 text-lg font-bold bg-green-500 hover:bg-green-600 text-white"
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

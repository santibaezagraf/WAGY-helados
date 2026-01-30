"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DollarSign, FileText } from "lucide-react"
import { IngresarGasto } from "@/lib/actions/gastos"
import { useRouter } from "next/navigation"

interface AddGastoModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AddGastoModal({ open, onOpenChange }: AddGastoModalProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [monto, setMonto] = React.useState<string>("")

  const router = useRouter()

  React.useEffect(() => {
    if (!open) {
      setMonto("")
    }
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    const montoNumerico = parseFloat(monto)
    
    if (!monto || montoNumerico <= 0) {
      alert("Ingrese un monto válido")
      return
    }

    setIsSubmitting(true)

    try {
      await IngresarGasto(montoNumerico)
        setMonto("")
        onOpenChange(false)
        
    } catch (error) {
      console.error("Error al registrar gasto:", error)
      alert("Error al registrar el gasto")
    } finally {
      setIsSubmitting(false)
      
    }
  }

  const handleCancel = () => {
    setMonto("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="text-center gap-2">
            Registrar Gasto
          </DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="monto" className="flex items-center gap-2">
                <DollarSign className="h-4 w-4" />
                Monto
              </Label>
                <div className="relative">
                <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500 pointer-events-none">$</span>
                <Input
                  id="monto"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={monto}
                  onChange={(e) => setMonto(e.target.value)}
                  disabled={isSubmitting}
                  required
                  className="pl-8"
                />
                </div>
              
              
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button 
                type="submit" 
                disabled={isSubmitting || !monto}
                className="px-4 py-2 bg-cyan-600 text-white rounded-md hover:bg-cyan-700 transition-colors font-semibold"
            >
              {isSubmitting ? "Guardando..." : "Registrar Gasto"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

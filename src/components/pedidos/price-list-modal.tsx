"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Plus, Trash2 } from "lucide-react"
import { guardarListaPrecios } from "@/lib/actions/lista_precios"

interface PriceRow {
  id: string
  fromQuantity: number | ""
  pricePerUnit: number | ""
}

export interface PriceList {
  name: string
  agua: PriceRow[]
  crema: PriceRow[]
}

interface PriceListModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PriceListModal({ open, onOpenChange }: PriceListModalProps) {
  const [priceList, setPriceList] = React.useState<PriceList>({
    name: "",
    agua: [{ id: "agua-1", fromQuantity: "", pricePerUnit: "" }],
    crema: [{ id: "crema-1", fromQuantity: "", pricePerUnit: "" }],
  })

  const handleNameChange = (newName: string) => {
    setPriceList((prev) => ({ ...prev, name: newName }))
  }

  const handleRowChange = (
    type: "agua" | "crema",
    rowId: string,
    field: "fromQuantity" | "pricePerUnit",
    value: string
  ) => {
    setPriceList((prev) => ({
      ...prev,
      [type]: prev[type].map((row) => {
        if (row.id === rowId) {
          return {
            ...row,
            [field]: value === "" ? "" : Number(value),
          }
        }
        return row
      }),
    }))
  }

  const addRow = (type: "agua" | "crema") => {
    const newId = `${type}-${Date.now()}`
    setPriceList((prev) => ({
      ...prev,
      [type]: [
        ...prev[type],
        { id: newId, fromQuantity: "", pricePerUnit: "" },
      ],
    }))
  }

  const removeRow = (type: "agua" | "crema", rowId: string) => {
    setPriceList((prev) => ({
      ...prev,
      [type]: prev[type].filter((row) => row.id !== rowId),
    }))
  }

  const handleCreatePriceList = async () => {
    // Validar que haya nombre
    if (!priceList.name.trim()) {
      alert("Por favor ingresa un nombre para la lista de precios")
      return
    }

    // Validar que haya al menos una fila en cada columna
    if (priceList.agua.length === 0 || priceList.crema.length === 0) {
      alert("Debe haber al menos una fila en cada columna")
      return
    }

    // Validar que todas las filas estén completas
    const validarFilas = (filas: PriceRow[]) => {
      return filas.every(
        (fila) => fila.fromQuantity !== "" && fila.pricePerUnit !== ""
      )
    }

    if (!validarFilas(priceList.agua) || !validarFilas(priceList.crema)) {
      alert("Todos los campos deben estar completados")
      return
    }

    // Log para demostración (aquí irían las server actions)
    console.log("Lista de precios creada:", priceList)

    const { success } = await guardarListaPrecios(
      priceList.name, 
      priceList.agua.map(item => ({
        fromQuantity: Number(item.fromQuantity),
        pricePerUnit: Number(item.pricePerUnit)
      })), 
      priceList.crema.map(item => ({
        fromQuantity: Number(item.fromQuantity),
        pricePerUnit: Number(item.pricePerUnit)
      }))
    )

    if (!success) {
      alert("Error al crear la lista de precios")
      return
    }


    // Reset y cierre
    setPriceList({
      name: "",
      agua: [{ id: "agua-1", fromQuantity: "", pricePerUnit: "" }],
      crema: [{ id: "crema-1", fromQuantity: "", pricePerUnit: "" }],
    })
    onOpenChange(false)
  }

  const renderPriceColumn = (type: "agua" | "crema", label: string) => {
    const rows = priceList[type]

    return (
      <div className="flex-1">
        <h3 className="font-semibold text-sm mb-3 text-slate-700">
          Helados de {label}
        </h3>
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="flex gap-2 items-end">
              <div className="flex-1">
                <Label className="text-xs text-slate-600 mb-1 block">
                  A partir de (unidades)
                </Label>
                <Input
                  type="number"
                  placeholder="ej: 50"
                  value={row.fromQuantity}
                  onChange={(e) =>
                    handleRowChange(type, row.id, "fromQuantity", e.target.value)
                  }
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex-1">
                <Label className="text-xs text-slate-600 mb-1 block">
                  Precio c/u ($)
                </Label>
                <Input
                  type="number"
                  placeholder="ej: 200"
                  value={row.pricePerUnit}
                  onChange={(e) =>
                    handleRowChange(type, row.id, "pricePerUnit", e.target.value)
                  }
                  className="h-8 text-sm"
                />
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeRow(type, row.id)}
                className="text-red-600 hover:text-red-700 hover:bg-red-50 h-8 w-8 p-0"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => addRow(type)}
            className="w-full gap-2 text-slate-700 border-slate-300"
          >
            <Plus className="h-4 w-4" />
            Agregar fila
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Crear Lista de Precios</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Nombre de la lista */}
          <div>
            <Label htmlFor="list-name" className="text-sm font-medium">
              Nombre de la lista
            </Label>
            <Input
              id="list-name"
              placeholder="ej: Lista Mayo 2026"
              value={priceList.name}
              onChange={(e) => handleNameChange(e.target.value)}
              className="mt-2"
            />
          </div>

          {/* Dos columnas de precios */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {renderPriceColumn("agua", "agua")}
            {renderPriceColumn("crema", "crema")}
          </div>

          {/* Resumen visual */}
          <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
            <h4 className="font-medium text-sm text-slate-700 mb-2">
              Resumen
            </h4>
            <div className="grid grid-cols-2 gap-4 text-sm text-slate-600">
              <div>
                <p className="font-medium text-slate-700">Agua</p>
                <p>{priceList.agua.length} fila(s) de precios</p>
              </div>
              <div>
                <p className="font-medium text-slate-700">Crema</p>
                <p>{priceList.crema.length} fila(s) de precios</p>
              </div>
            </div>
          </div>
        </div>

        {/* Botones de acción */}
        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            onClick={handleCreatePriceList}
            disabled={!priceList.name.trim() || priceList.agua.length === 0 || priceList.crema.length === 0}
            className="bg-cyan-600 hover:bg-cyan-700"
          >
            Crear Lista de Precios
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

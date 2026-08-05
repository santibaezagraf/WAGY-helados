"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { getListaActiva, guardarListaPrecios } from "@/lib/actions/lista_precios"

interface PriceRow {
  id: string
  fromQuantity: number | ""
  pricePerUnit: number | ""
}

export interface PriceList {
  name: string 
  saboresAgua: string[]
  saboresCrema: string[]
  agua: PriceRow[]
  crema: PriceRow[]
}

interface PriceListState extends PriceList {
  saboresAguaStr: string
  saboresCremaStr: string
}

const defaultSaboresAgua = "Frutilla, Uva, Limón, Pico Dulce, Crema del Cielo, Caramelo Fizz"
const defaultSaboresCrema = "Chocolate, Vainilla, Frutilla, Dulce de leche"

interface PriceListModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PriceListModal({ open, onOpenChange }: PriceListModalProps) {
  const [priceList, setPriceList] = React.useState<PriceListState>({
    name: "",
    saboresAgua: [],
    saboresCrema: [],
    saboresAguaStr: defaultSaboresAgua,
    saboresCremaStr: defaultSaboresCrema,
    agua: [{ id: "agua-1", fromQuantity: "", pricePerUnit: "" }],
    crema: [{ id: "crema-1", fromQuantity: "", pricePerUnit: "" }],
  })
  const [activePriceList, setActivePriceList] = React.useState<PriceList | null>(null)
  const [loadingActiveList, setLoadingActiveList] = React.useState(false)
  const [creatingPriceList, setCreatingPriceList] = React.useState(false)

  React.useEffect(() => {
    if (creatingPriceList) return 

    const fetchActivePriceList = async () => {
      try {
        setLoadingActiveList(true)
        const activePriceList = await getListaActiva()
        setActivePriceList(activePriceList)
      } catch (error) {
        console.error("Error al cargar la lista de precios activa:", error)
      } finally {
        setLoadingActiveList(false)
      }
    }

    fetchActivePriceList()
  }, [creatingPriceList, open])

  // Limpiar datos de priceList al salir de la vista de creación
  React.useEffect(() => {
    if (!creatingPriceList) {
      setPriceList({
        name: "",
        saboresAgua: [],
        saboresCrema: [],
        saboresAguaStr: defaultSaboresAgua,
        saboresCremaStr: defaultSaboresCrema,
        agua: [{ id: "agua-1", fromQuantity: "", pricePerUnit: "" }],
        crema: [{ id: "crema-1", fromQuantity: "", pricePerUnit: "" }],
      })
    }
  }, [creatingPriceList, open])

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

    const parseSabores = (str: string) => str.split(',').map(s => s.trim()).filter(Boolean)

    try {
      await guardarListaPrecios(
      priceList.name, 
      priceList.agua.map(item => ({
        fromQuantity: Number(item.fromQuantity),
        pricePerUnit: Number(item.pricePerUnit)
      })), 
      priceList.crema.map(item => ({
        fromQuantity: Number(item.fromQuantity),
        pricePerUnit: Number(item.pricePerUnit)
      })),
      parseSabores(priceList.saboresAguaStr),
      parseSabores(priceList.saboresCremaStr)
    )
  } catch (error) {
    alert("Error al crear la lista de precios: " + (error as Error).message)
    return
  }
  
    // Reset y cierre
    setPriceList({
      name: "",
      saboresAgua: [],
      saboresCrema: [],
      saboresAguaStr: defaultSaboresAgua,
      saboresCremaStr: defaultSaboresCrema,
      agua: [{ id: "agua-1", fromQuantity: "", pricePerUnit: "" }],
      crema: [{ id: "crema-1", fromQuantity: "", pricePerUnit: "" }],
    })
    onOpenChange(false)
  }

  const renderPriceColumn = (type: "agua" | "crema", label: string) => {
    const rows = priceList[type]
    const saboresKey = type === "agua" ? "saboresAguaStr" : "saboresCremaStr"

    return (
      <div className="flex-1">
        <h3 className="font-semibold text-sm mb-3 text-slate-700">
          Helados de {label}
        </h3>
        
        <div className="mb-4">
          <Label className="text-xs text-slate-600 mb-1 block">
            Sabores (separados por coma)
          </Label>
          <Input
            value={priceList[saboresKey]}
            onChange={(e) => setPriceList(prev => ({ ...prev, [saboresKey]: e.target.value }))}
            className="text-sm"
          />
        </div>

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

  const handleDialogOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setCreatingPriceList(false)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">

        { creatingPriceList ? (
          <>
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
                  className="mt-2" />
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
                onClick={() => setCreatingPriceList(false)}
              >
                Volver
              </Button>
              <Button
                onClick={handleCreatePriceList}
                disabled={!priceList.name.trim() || priceList.agua.length === 0 || priceList.crema.length === 0}
                className="bg-cyan-600 hover:bg-cyan-700"
              >
                Crear Lista de Precios
              </Button>
            </div>
          </>
        ) : (
          
          <>
            <DialogHeader>
              <DialogTitle>Lista de Precios</DialogTitle>
            </DialogHeader>

            {loadingActiveList ? (
              <div className="flex items-center justify-center py-10">
                <p className="text-slate-600">Cargando lista activa...</p>
                <Loader2 className="ml-2 h-5 w-5 animate-spin text-cyan-600" />
              </div>
            ) : (
              <div className="space-y-6 py-4">
              {activePriceList ? (
                <div className="space-y-4">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-sm text-slate-500">Lista activa</p>
                      <h3 className="text-xl font-semibold text-slate-900">{activePriceList.name}</h3>
                      
                    </div>
                    <Button
                      onClick={() => setCreatingPriceList(true)}
                      className="self-start md:self-auto bg-cyan-600 hover:bg-cyan-700"
                    >
                      Crear nueva lista
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[{ key: "agua" as const, label: "Helados de agua" }, { key: "crema" as const, label: "Helados de crema" }].map((section) => (
                      <div
                        key={section.key}
                        className="rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden"
                      >
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
                          <p className="font-medium text-slate-800 text-sm">{section.label}</p>
                          <span className="text-xs text-slate-500">
                            {activePriceList[section.key].length} regla(s)
                          </span>
                        </div>
                        {activePriceList[section.key === "agua" ? "saboresAgua" : "saboresCrema"]?.length > 0 && (
                          <div className="px-4 py-2 border-b border-slate-100 bg-white">
                            <p className="text-xs text-slate-500 mb-1">Sabores:</p>
                            <div className="flex flex-wrap gap-1">
                              {activePriceList[section.key === "agua" ? "saboresAgua" : "saboresCrema"].map(s => (
                                <span key={s} className="bg-slate-100 text-slate-600 text-[10px] px-2 py-0.5 rounded-full">{s}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="divide-y divide-slate-100">
                          {activePriceList[section.key].map((row) => (
                            <div key={row.id} className="px-4 py-3 flex items-center justify-between text-sm">
                              <div className="text-slate-700">
                                <p className="text-xs text-slate-500">Desde</p>
                                <p className="font-medium">{row.fromQuantity} u.</p>
                              </div>
                              <div className="text-right text-slate-700">
                                <p className="text-xs text-slate-500">Precio c/u</p>
                                <p className="font-semibold">${row.pricePerUnit}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-600">
                  <p className="font-medium text-slate-700">No hay lista activa</p>
                  <p className="text-sm text-slate-600 max-w-md">
                    Crea una nueva lista de precios para ver los valores activos de agua y crema.
                  </p>
                  <Button
                    onClick={() => setCreatingPriceList(true)}
                    className="bg-cyan-600 hover:bg-cyan-700"
                  >
                    Crear nueva lista
                  </Button>
                </div>
              )}
            </div>
            )}

            
          </>
        )}

      </DialogContent>
    </Dialog>
  )
}

// "use client"

// import * as React from "react"
// import { Button } from "@/components/ui/button"
// import { Badge } from "@/components/ui/badge"
// import { ChevronLeft, ChevronRight, Calendar } from "lucide-react"

// interface DateRangeSelectorProps {
//   onDateRangeChange: (startDate: Date, endDate: Date, mode: "dia" | "semana") => void
//   defaultMode?: "dia" | "semana"
// }

// export function DateRangeSelector({
//   onDateRangeChange,
//   defaultMode = "semana",
// }: DateRangeSelectorProps) {
//   const [mode, setMode] = React.useState<"dia" | "semana">(defaultMode)
//   const [currentDate, setCurrentDate] = React.useState(new Date())

//   React.useEffect(() => {
//     updateDateRange(currentDate, mode)
//   }, [currentDate, mode])

//   const updateDateRange = (date: Date, selectedMode: "dia" | "semana") => {
//     const startDate = new Date(date)
//     const endDate = new Date(date)

//     if (selectedMode === "dia") {
//       startDate.setHours(0, 0, 0, 0)
//       endDate.setHours(23, 59, 59, 999)
//     } else {
//       // Semana: domingo a sabado
//       const day = startDate.getDay()
//       const diff = startDate.getDate() - day + (day === 0 ? 0 : -6)
//       startDate.setDate(diff)
//       startDate.setHours(0, 0, 0, 0)

//       endDate.setDate(startDate.getDate() + 6)
//       endDate.setHours(23, 59, 59, 999)
//     }

//     onDateRangeChange(startDate, endDate, selectedMode)
//   }

//   const handlePrev = () => {
//     const newDate = new Date(currentDate)
//     if (mode === "dia") {
//       newDate.setDate(newDate.getDate() - 1)
//     } else {
//       newDate.setDate(newDate.getDate() - 7)
//     }
//     setCurrentDate(newDate)
//   }

//   const handleNext = () => {
//     const newDate = new Date(currentDate)
//     if (mode === "dia") {
//       newDate.setDate(newDate.getDate() + 1)
//     } else {
//       newDate.setDate(newDate.getDate() + 7)
//     }
//     setCurrentDate(newDate)
//   }

//   const handleToday = () => {
//     setCurrentDate(new Date())
//   }

//   const handleSemana = () => {
//     const newDate = new Date(currentDate)
//     const day = newDate.getDay()
//     const diff = currentDate.getDate() - day // + (day === 0 ? 0 : -6)
    
//     newDate.setDate(diff)
//     setCurrentDate(newDate)
//     setMode("semana")
//   }

//   const getDisplayText = () => {
//     const startDate = new Date(currentDate)
//     const day = startDate.getDay()
//     const diff = startDate.getDate() - day + (day === 0 ? 0 : -7) // si es domingo, la startDate es currentDate
//     startDate.setDate(diff)

//     if (mode === "dia") {
//       return currentDate.toLocaleDateString("es-ES", {
//         weekday: "long",
//         year: "numeric",
//         month: "long",
//         day: "numeric",
//       })
//     } else {
//       const endDate = new Date(startDate)
//       endDate.setDate(endDate.getDate() + 6)

//       return `${startDate.toLocaleDateString("es-ES", {
//         day: "numeric",
//         month: "short",
//       })} - ${endDate.toLocaleDateString("es-ES", {
//         day: "numeric",
//         month: "long",
//         year: "numeric",
//       })}`
//     }
//   }

//   return (
//     <div className="flex flex-col gap-4 rounded-lg border p-4">
//       <div className="flex items-center gap-2">
//         <Calendar className="h-5 w-5 text-gray-600" />
//         <h3 className="text-lg font-semibold">Selecciona el período</h3>
//       </div>

//       <div className="flex gap-2">
//         <Button
//           variant={mode === "dia" ? "default" : "outline"}
//           onClick={() => setMode("dia")}
//           className="flex-1"
//         >
//           Día
//         </Button>
//         <Button
//           variant={mode === "semana" ? "default" : "outline"}
//           onClick={handleSemana}
//           className="flex-1"
//         >
//           Semana
//         </Button>
//       </div>

//       <div className="flex items-center justify-between gap-4">
//         <Button
//           variant="outline"
//           size="sm"
//           onClick={handlePrev}
//           className="h-8 w-8 p-0"
//         >
//           <ChevronLeft className="h-4 w-4" />
//         </Button>

//         <div className="flex-1 text-center">
//           <Badge variant="secondary" className="text-sm font-medium">
//             {getDisplayText()}
//           </Badge>
//         </div>

//         <Button
//           variant="outline"
//           size="sm"
//           onClick={handleNext}
//           className="h-8 w-8 p-0"
//           // disabled={mode === "dia" ? currentDate > new Date() : currentDate < new Date(new Date().setDate(new Date().getDate() - 7))}
//         >
//           <ChevronRight className="h-4 w-4" />
//         </Button>
//       </div>

//       <Button variant="ghost" size="sm" onClick={handleToday} className="w-full">
//         Hoy
//       </Button>
//     </div>
//   )
// }

"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface DateRangeSelectorProps {
  onDateRangeChange: (startDate: Date, endDate: Date, mode: "dia" | "semana") => void
  defaultMode?: "dia" | "semana"
}

export function DateRangeSelector({
  onDateRangeChange,
  defaultMode = "semana",
}: DateRangeSelectorProps) {
  const [mode, setMode] = React.useState<"dia" | "semana">(defaultMode)
  const [currentDate, setCurrentDate] = React.useState(new Date())
  const [datePickerOpen, setDatePickerOpen] = React.useState(false)
  const [pickerDate, setPickerDate] = React.useState<string>("")
  const [pickerDateError, setPickerDateError] = React.useState<string>("")

  const formatDateInputValue = React.useCallback((date: Date) => {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, "0")
    const d = String(date.getDate()).padStart(2, "0")
    return `${y}-${m}-${d}`
  }, [])

  React.useEffect(() => {
    setPickerDate(formatDateInputValue(currentDate))
  }, [currentDate, formatDateInputValue])

  // --- HELPER: Obtener el domingo de la semana actual ---
  const getStartOfWeek = React.useCallback((date: Date) => {
    const d = new Date(date)
    const day = d.getDay() 
    const diff = d.getDate() - day 
    d.setDate(diff)
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  // --- EFFECT: Notificar cambios al padre ---
  React.useEffect(() => {
    const startDate = new Date(currentDate)
    const endDate = new Date(currentDate)

    if (mode === "dia") {
      startDate.setHours(0, 0, 0, 0)
      endDate.setHours(23, 59, 59, 999)
    } else {
      // Calcular Domingo
      const sunday = getStartOfWeek(startDate)
      
      // Asignar inicio (Domingo)
      startDate.setTime(sunday.getTime())
      
      // Asignar fin (Sábado)
      endDate.setTime(sunday.getTime())
      endDate.setDate(endDate.getDate() + 6)
      endDate.setHours(23, 59, 59, 999)
    }

    onDateRangeChange(startDate, endDate, mode)
  }, [currentDate, mode, getStartOfWeek])

  React.useEffect(() => {
    // Limpiar error al cambiar la fecha del picker
    if (pickerDateError) {
      setPickerDateError("")
    }
    if (!datePickerOpen) {
      setPickerDate(currentDate ? formatDateInputValue(currentDate) : "")
    }
  }, [pickerDate, datePickerOpen])

  // --- HANDLERS ---

  const handlePrev = () => {
    const newDate = new Date(currentDate)
    if (mode === "dia") {
      newDate.setDate(newDate.getDate() - 1)
    } else {
      newDate.setDate(newDate.getDate() - 7)
    }
    setCurrentDate(newDate)
  }

  const handleNext = () => {
    const newDate = new Date(currentDate)
    if (mode === "dia") {
      newDate.setDate(newDate.getDate() + 1)
    } else {
      newDate.setDate(newDate.getDate() + 7)
    }
    setCurrentDate(newDate)
  }

  const handleToday = () => {
    setCurrentDate(new Date())
  }

  // Al cambiar a modo semana, alineamos la fecha actual al domingo para evitar confusiones visuales
  const handleSetModeSemana = () => {
    setMode("semana")
    // Opcional: Si quieres que al cambiar a semana se acomode visualmente al domingo:
    setCurrentDate(getStartOfWeek(currentDate)) 
  }

  const getDisplayText = () => {
    if (mode === "dia") {
      return currentDate.toLocaleDateString("es-ES", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      })
    } else {
      const start = getStartOfWeek(currentDate)
      const end = new Date(start)
      end.setDate(end.getDate() + 6)

      return `${start.toLocaleDateString("es-ES", {
        day: "numeric",
        // month: "short",
      })} - ${end.toLocaleDateString("es-ES", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })}`
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4 bg-white shadow-sm">
      <div className="flex items-center gap-2">
        <Calendar className="h-5 w-5 text-gray-600" />
        <h3 className="text-lg font-semibold">Selecciona el período</h3>
      </div>

      <div className="flex gap-2">
        <Button
          variant={mode === "dia" ? "default" : "outline"}
          onClick={() => setMode("dia")}
          className="flex-1"
        >
          Día
        </Button>
        <Button
          variant={mode === "semana" ? "default" : "outline"}
          onClick={handleSetModeSemana}
          className="flex-1"
        >
          Semana
        </Button>
      </div>

      <div className="flex items-center justify-between gap-1">
        <Button
          variant="outline"
          size="icon"
          onClick={handlePrev}
          className="h-8 w-8"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div className="flex-1 text-center">
          <Badge variant="secondary" className="text-sm font-medium px-4 py-1 capitalize">
            {getDisplayText()}
          </Badge>
        </div>

        <Button
          variant="outline"
          size="icon"
          onClick={handleNext}
          disabled={
            mode === "dia"
              ? currentDate.toDateString() === new Date().toDateString()
              : currentDate >= getStartOfWeek(new Date())
          }
          className="h-8 w-8"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={datePickerOpen} onOpenChange={setDatePickerOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="w-full">
            Elegir fecha...
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Selecciona una fecha</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Input
              type="date"
              value={pickerDate}
              onChange={(e) => setPickerDate(e.target.value)}
              max={formatDateInputValue(new Date())}
              aria-label="Fecha"
              />
              {pickerDateError && (
                <p className="text-sm text-red-600">{pickerDateError}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={
              () => {
                setDatePickerOpen(false)
              }
            }>
              Cancelar
            </Button>
            <Button
              onClick={() => {
                if (!pickerDate) return
                const [y, m, d] = pickerDate.split("-").map(Number)
                const selected = new Date(y, (m || 1) - 1, d || 1)

                if (selected > new Date()) {
                  // No permitir fechas futuras
                  setPickerDateError("No se pueden seleccionar fechas futuras.")
                  return
                }

                setCurrentDate(selected)
                setMode("dia")
                setDatePickerOpen(false)
              }}
            >
              Aplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button variant="ghost" size="sm" onClick={handleToday} className="w-full">
        Ir a Hoy
      </Button>
    </div>
  )
}

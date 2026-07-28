"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  inicioDelDiaAR,
  inicioDiaSiguienteAR,
  inicioSemanaAR,
  inicioMesAR,
  sumarDiasAR,
  claveDiaAR,
  fechaISOAR,
  instanteAR,
  formatearFechaAR,
} from "@/lib/zona-horaria"

interface DateRangeSelectorProps {
  /**
   * `startDate` es el inicio (inclusivo) del rango a 00:00 AR; `endDate` es el fin
   * EXCLUSIVO = 00:00 AR del día siguiente al último día seleccionado. Los consumidores
   * filtran con `created_at >= startDate AND created_at < endDate` (medio-abierto).
   */
  onDateRangeChange: (startDate: Date, endDate: Date) => void
}

const MS_POR_DIA = 24 * 60 * 60 * 1000

function formatearFechaInput(date: Date) {
  return fechaISOAR(date)
}

function parsearFechaInput(valor: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor)
  if (!m) return null
  return instanteAR(Number(m[1]), Number(m[2]), Number(m[3]))
}

function formatoCorto(date: Date) {
  return formatearFechaAR(date, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

function mismoDia(a: Date, b: Date) {
  return claveDiaAR(a) === claveDiaAR(b)
}

export const DateRangeSelector = React.memo(function DateRangeSelector({
  onDateRangeChange,
}: DateRangeSelectorProps) {
  const hoy = React.useMemo(() => inicioDelDiaAR(new Date()), [])

  const [inicio, setInicio] = React.useState<Date>(() => inicioSemanaAR(new Date()))
  const [fin, setFin] = React.useState<Date>(() => inicioDelDiaAR(new Date()))
  const [inicioInput, setInicioInput] = React.useState(() => formatearFechaInput(inicioSemanaAR(new Date())))
  const [finInput, setFinInput] = React.useState(() => formatearFechaInput(new Date()))
  const [error, setError] = React.useState<string>("")

  const hoyStr = React.useMemo(() => formatearFechaInput(hoy), [hoy])

  const notificarCambio = React.useCallback(
    (nuevoInicio: Date, nuevoFin: Date) => {
      // fin exclusivo = 00:00 AR del día siguiente al último día del rango.
      onDateRangeChange(inicioDelDiaAR(nuevoInicio), inicioDiaSiguienteAR(nuevoFin))
    },
    [onDateRangeChange]
  )

  React.useEffect(() => {
    notificarCambio(inicio, fin)
    // Solo en el primer render — cambios posteriores se disparan en los handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const aplicarRango = React.useCallback(
    (nuevoInicio: Date, nuevoFin: Date) => {
      const ini = inicioDelDiaAR(nuevoInicio)
      const fi = inicioDelDiaAR(nuevoFin)
      setInicio(ini)
      setFin(fi)
      setInicioInput(formatearFechaInput(ini))
      setFinInput(formatearFechaInput(fi))
      setError("")
      notificarCambio(ini, fi)
    },
    [notificarCambio]
  )

  const handleInicioChange = React.useCallback((valor: string) => {
    setInicioInput(valor)
    const nuevoInicio = parsearFechaInput(valor)
    if (!nuevoInicio) return
    if (nuevoInicio > hoy) {
      setError("La fecha de inicio no puede ser futura.")
      return
    }
    if (nuevoInicio > fin) {
      setError("La fecha de inicio no puede ser posterior a la de fin.")
      return
    }
    setError("")
    setInicio(nuevoInicio)
    notificarCambio(nuevoInicio, fin)
  }, [fin, hoy, notificarCambio])

  const handleFinChange = React.useCallback((valor: string) => {
    setFinInput(valor)
    const nuevoFin = parsearFechaInput(valor)
    if (!nuevoFin) return
    if (nuevoFin > hoy) {
      setError("La fecha de fin no puede ser futura.")
      return
    }
    if (nuevoFin < inicio) {
      setError("La fecha de fin no puede ser anterior a la de inicio.")
      return
    }
    setError("")
    setFin(nuevoFin)
    notificarCambio(inicio, nuevoFin)
  }, [inicio, hoy, notificarCambio])

  const spanDias = React.useMemo(() => {
    const diff = inicioDelDiaAR(fin).getTime() - inicioDelDiaAR(inicio).getTime()
    return Math.round(diff / MS_POR_DIA) + 1
  }, [inicio, fin])

  const handlePrev = React.useCallback(() => {
    aplicarRango(sumarDiasAR(inicio, -spanDias), sumarDiasAR(fin, -spanDias))
  }, [inicio, fin, spanDias, aplicarRango])

  const handleNext = React.useCallback(() => {
    const nuevoInicio = sumarDiasAR(inicio, spanDias)
    let nuevoFin = sumarDiasAR(fin, spanDias)
    if (nuevoFin > hoy) nuevoFin = hoy
    if (nuevoInicio > hoy) return
    aplicarRango(nuevoInicio, nuevoFin)
  }, [inicio, fin, spanDias, hoy, aplicarRango])

  const nextDeshabilitado = React.useMemo(() => {
    return sumarDiasAR(inicio, spanDias) > hoy
  }, [inicio, spanDias, hoy])

  const presetHoy = React.useCallback(() => aplicarRango(hoy, hoy), [hoy, aplicarRango])
  const presetAyer = React.useCallback(() => {
    const ayer = sumarDiasAR(hoy, -1)
    aplicarRango(ayer, ayer)
  }, [hoy, aplicarRango])
  const presetSemana = React.useCallback(() => {
    aplicarRango(inicioSemanaAR(hoy), hoy)
  }, [hoy, aplicarRango])
  const presetUltimos7 = React.useCallback(() => {
    aplicarRango(sumarDiasAR(hoy, -6), hoy)
  }, [hoy, aplicarRango])
  const presetMes = React.useCallback(() => {
    aplicarRango(inicioMesAR(hoy), hoy)
  }, [hoy, aplicarRango])
  const presetUltimos30 = React.useCallback(() => {
    aplicarRango(sumarDiasAR(hoy, -29), hoy)
  }, [hoy, aplicarRango])

  const textoRango = React.useMemo(() => {
    if (mismoDia(inicio, fin)) return formatoCorto(inicio)
    return `${formatoCorto(inicio)} — ${formatoCorto(fin)}`
  }, [inicio, fin])

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4 bg-white shadow-sm">
      <div className="flex items-center gap-2">
        <Calendar className="h-5 w-5 text-gray-600" />
        <h3 className="text-lg font-semibold">Selecciona el período</h3>
      </div>

      <div className="grid gap-3">
        <div className="grid gap-1">
          <label htmlFor="fecha-inicio" className="text-xs font-medium text-gray-600">
            Desde
          </label>
          <Input
            id="fecha-inicio"
            type="date"
            value={inicioInput}
            max={hoyStr}
            onChange={(e) => handleInicioChange(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="fecha-fin" className="text-xs font-medium text-gray-600">
            Hasta
          </label>
          <Input
            id="fecha-fin"
            type="date"
            value={finInput}
            max={hoyStr}
            onChange={(e) => handleFinChange(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <div className="flex items-center justify-between gap-1">
        <Button variant="outline" size="icon" onClick={handlePrev} className="h-8 w-8">
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div className="flex-1 text-center">
          <Badge variant="secondary" className="text-sm font-medium px-3 py-1">
            {textoRango}
            <span className="ml-2 text-xs text-gray-500">
              ({spanDias} {spanDias === 1 ? "día" : "días"})
            </span>
          </Badge>
        </div>

        <Button
          variant="outline"
          size="icon"
          onClick={handleNext}
          disabled={nextDeshabilitado}
          className="h-8 w-8"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" onClick={presetHoy}>Hoy</Button>
        <Button variant="outline" size="sm" onClick={presetAyer}>Ayer</Button>
        <Button variant="outline" size="sm" onClick={presetSemana}>Esta semana</Button>
        <Button variant="outline" size="sm" onClick={presetUltimos7}>Últimos 7 días</Button>
        <Button variant="outline" size="sm" onClick={presetMes}>Este mes</Button>
        <Button variant="outline" size="sm" onClick={presetUltimos30}>Últimos 30 días</Button>
      </div>
    </div>
  )
})

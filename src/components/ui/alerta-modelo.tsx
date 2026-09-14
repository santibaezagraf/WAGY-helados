"use client"

import * as React from "react"
import Link from "next/link"
import { AlertTriangle, X } from "lucide-react"
import { createClient } from "@/lib/supabase-client"
import {
  getAlertasModeloActivas,
  resolverAlertasModelo,
  type AlertaModelo,
} from "@/lib/actions/alertas-modelo"

/**
 * Banner de alerta cuando el bot cae al modelo de fallback (429 / TPD del
 * primario). Sin esto, un primario caído era invisible (solo `console.warn`)
 * hasta que también se agotaba el siguiente y el cliente empezaba a recibir "no
 * te entendí". El bot registra cada salto en `alertas_modelo`; acá lo mostramos.
 *
 * Se monta dentro del Header, así aparece en todas las páginas del dashboard.
 * Carga inicial por server action + Realtime para prenderse en vivo. "Marcar
 * visto" resuelve todas las alertas de una (es un aviso global de ops, no por
 * fila) y esconde el banner.
 */
export function AlertaModelo() {
  const [alertas, setAlertas] = React.useState<AlertaModelo[]>([])
  const [resolviendo, setResolviendo] = React.useState(false)

  // Carga inicial: alertas sin resolver de las últimas 24h.
  React.useEffect(() => {
    let cancelado = false
    getAlertasModeloActivas()
      .then((data) => {
        if (!cancelado) setAlertas(data)
      })
      .catch(() => {
        /* el banner no es crítico: si falla, no molestamos */
      })
    return () => {
      cancelado = true
    }
  }, [])

  // En vivo: un INSERT (nuevo salto) suma la alerta al frente; un UPDATE que la
  // marca resuelta (desde esta u otra pestaña) la saca.
  React.useEffect(() => {
    const supabase = createClient()
    const canal = supabase
      .channel("alertas-modelo")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "alertas_modelo" },
        (payload) => {
          const fila = payload.new as (AlertaModelo & { resuelto?: boolean }) | null
          if (!fila || fila.resuelto === true) return
          setAlertas((prev) =>
            prev.some((a) => a.id === fila.id) ? prev : [fila, ...prev],
          )
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "alertas_modelo" },
        (payload) => {
          const fila = payload.new as (AlertaModelo & { resuelto?: boolean }) | null
          if (!fila) return
          if (fila.resuelto === true) {
            setAlertas((prev) => prev.filter((a) => a.id !== fila.id))
          }
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(canal)
    }
  }, [])

  const marcarVisto = async () => {
    setResolviendo(true)
    const previas = alertas
    setAlertas([]) // optimista: escondemos ya
    const ok = await resolverAlertasModelo().catch(() => false)
    if (!ok) setAlertas(previas) // volvió a fallar: restauramos para que se reintente
    setResolviendo(false)
  }

  if (alertas.length === 0) return null

  // Modelo del salto más reciente (primero de la lista, ordenada desc).
  const ultima = alertas[0]
  const cadenaAgotada = alertas.some((a) => a.modelo_fallback === null)

  return (
    <div className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-amber-900 sm:px-6 lg:px-8">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      {/* Todo el bloque de texto lleva a la página de estado de modelos. */}
      <Link
        href="/modelos"
        className="group min-w-0 flex-1 text-xs hover:underline sm:text-sm"
        title="Ver estado de modelos y uso de tokens"
      >
        <span className="font-semibold">
          {cadenaAgotada
            ? "El bot se quedó sin modelos de extracción (toda la cadena sin cuota)."
            : "El bot está usando un modelo de fallback."}
        </span>{" "}
        <span className="text-amber-800">
          Se agotó la cuota de <code className="font-mono">{ultima.modelo_agotado}</code>
          {ultima.modelo_fallback
            ? <> → se pasó a <code className="font-mono">{ultima.modelo_fallback}</code>.</>
            : <> y no quedaban alternativas.</>}
          {alertas.length > 1 && ` (${alertas.length} saltos en las últimas 24h)`}
          {" "}
          <span className="font-medium underline decoration-amber-400 underline-offset-2 group-hover:decoration-amber-600">
            Ver estado de modelos →
          </span>
        </span>
      </Link>
      <button
        type="button"
        onClick={marcarVisto}
        disabled={resolviendo}
        className="shrink-0 rounded p-1 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
        aria-label="Marcar alerta como vista"
        title="Marcar como visto"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

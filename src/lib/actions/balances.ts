"use server"

import { createClient } from "@/lib/supabase-server"

export interface Balance {
  total_agua: number
  total_crema: number
  plata_transferencia: number
  plata_efectivo: number
  costo_envio_total: number
  cantidad_envios: number
  total_gastos: number
  cantidad_gastos: number
  efectivo_final: number
  ingreso_total: number
}

export async function obtenerBalance(
  fechaInicio: Date,
  fechaFin: Date
): Promise<Balance | null> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase.rpc("obtener_balance", {
      fecha_inicio: fechaInicio.toISOString(),
      fecha_fin: fechaFin.toISOString(),
    })

    if (error) {
      console.error("Error obteniendo balance:", error)
      return null
    }

    if (data && data.length > 0) {
      return data[0] as Balance
    }

    return null
  } catch (error) {
    console.error("Error en obtenerBalance:", error)
    return null
  }
}

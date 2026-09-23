'use server'

import { revalidatePath } from "next/cache";
import { createClient } from "../supabase-server";
import { exigirPermiso } from "@/lib/auth-rol";
import { registrarActividad } from "@/lib/actividad";

export type Gasto = {
    id: number
    monto: number
    /** Descripción libre de en qué se gastó. Opcional: los gastos viejos no tienen. */
    concepto: string | null
    created_at: string
}

export async function IngresarGasto(
    monto: number,
    concepto?: string | null,
) {
    const sesion = await exigirPermiso('gastos.escribir')
    const supabase = await createClient()

    // Un concepto vacío se guarda como null, no como '': así el listado tiene un
    // solo caso de "sin concepto" para chequear.
    const conceptoLimpio = concepto?.trim() || null

    const { error } = await supabase
        .from("gastos")
        .insert({ monto, concepto: conceptoLimpio })

    if (error) throw new Error(`Error al ingresar gasto: ${error.message}`)

    registrarActividad(sesion, 'gasto.registrar', { detalle: { monto, concepto: conceptoLimpio } })
    revalidatePath('/')
    return { success: true }
}

export async function ObtenerGastos(fechaInicio: Date, fechaFin: Date): Promise<Gasto[]> {
    await exigirPermiso('balances.ver')
    const supabase = await createClient()

    const { data, error } = await supabase
        .from("gastos")
        .select("id, monto, concepto, created_at")
        .eq("activo", true)
        .gte("created_at", fechaInicio.toISOString())
        .lt("created_at", fechaFin.toISOString())
        .order("created_at", { ascending: false })

    if (error) throw new Error(`Error al obtener gastos: ${error.message}`)

    revalidatePath('/balances')

    return data || []
}

export async function EliminarGasto(id: number) {
    const sesion = await exigirPermiso('gastos.escribir')
    const supabase = await createClient()

    const { error } = await supabase
        .from("gastos")
        .update({ activo: false })
        .eq("id", id)

    if (error) throw new Error(`Error al eliminar gasto: ${error.message}`)

    registrarActividad(sesion, 'gasto.eliminar', { detalle: { gastoId: id } })
    revalidatePath('/balances')
    return { success: true }
}

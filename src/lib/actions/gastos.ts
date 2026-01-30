'use server'

import { revalidatePath } from "next/cache";
import { createClient } from "../supabase-server";



export async function IngresarGasto(
    monto: number,
) {
    const supabase = await createClient()

    const { error } = await supabase
        .from("gastos")
        .insert({ monto })

    if (error) throw new Error(`Error al ingresar gasto: ${error.message}`)

    revalidatePath('/')
    return { success: true }
}

export async function ObtenerGastos(fechaInicio: Date, fechaFin: Date): Promise<{ monto: number }[]> {
    const supabase = await createClient()

    const { data, error } = await supabase
        .from("gastos")
        .select("monto")
        .gte("created_at", fechaInicio.toISOString())
        .lte("created_at", fechaFin.toISOString())

    if (error) throw new Error(`Error al obtener gastos: ${error.message}`)

    return data || []
}

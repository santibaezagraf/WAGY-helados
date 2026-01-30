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

export async function ObtenerGastos(fechaInicio: Date, fechaFin: Date): Promise<{ id: number, monto: number }[]> {
    const supabase = await createClient()

    const { data, error } = await supabase
        .from("gastos")
        .select("id, monto")
        .eq("activo", true)
        .gte("created_at", fechaInicio.toISOString())
        .lte("created_at", fechaFin.toISOString())

    if (error) throw new Error(`Error al obtener gastos: ${error.message}`)

    revalidatePath('/balances')

    return data || []
}

export async function EliminarGasto(id: number) {
    const supabase = await createClient()

    const { error } = await supabase
        .from("gastos")
        .update({ activo: false })
        .eq("id", id)

    if (error) throw new Error(`Error al eliminar gasto: ${error.message}`)

    revalidatePath('/balances')
    return { success: true }
}

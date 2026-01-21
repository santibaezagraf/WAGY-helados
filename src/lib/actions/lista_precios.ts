'use server'

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase-server"

// Definimos el tipo de retorno para tener autocompletado en el front
type ActionResponse = {
    success: boolean
    message?: string
    error?: string
}

export async function guardarListaPrecios(
    nombre: string,
    agua: { fromQuantity: number; pricePerUnit: number }[],
    crema: { fromQuantity: number; pricePerUnit: number }[]
): Promise<ActionResponse> {
    
    // 1. Validaciones básicas antes de tocar la BD
    if (!nombre || nombre.trim() === "") {
        return { success: false, error: "El nombre de la lista es obligatorio." }
    }
    if (agua.length === 0 && crema.length === 0) {
        return { success: false, error: "Debes agregar al menos una regla de precio." }
    }

    const supabase = await createClient()

    // 2. Insertar la cabecera (Lista)
    const { data: listaData, error: listaError } = await supabase
        .from("listas_precios")
        .insert([{ 
            nombre,
            activa: true
        }])
        .select()
        .single() // Usamos .single() porque esperamos 1 solo registro

    if (listaError) {
        return { success: false, error: `Error al crear la lista: ${listaError.message}` }
    }

    const listaId = listaData.id

    try {
        // 3. Preparar los datos para inserción masiva
        // Unificamos agua y crema en un solo array para hacer 1 sola llamada a la BD
        const reglasParaInsertar = [
            ...agua.map((item) => ({
                lista_id: listaId,
                tipo_producto: "agua", // Asegúrate que tu DB acepte este string o sea un ENUM
                min_cantidad: item.fromQuantity,
                precio_unitario: item.pricePerUnit,
            })),
            ...crema.map((item) => ({
                lista_id: listaId,
                tipo_producto: "crema",
                min_cantidad: item.fromQuantity,
                precio_unitario: item.pricePerUnit,
            }))
        ]

        console.log("Reglas para insertar:", reglasParaInsertar)

        if (reglasParaInsertar.length > 0) {
            
            const { error: reglasError } = await supabase
                .from("reglas_precios")
                .insert(reglasParaInsertar)

            if (reglasError) throw new Error(reglasError.message)
        }

        // 4. Éxito total
        revalidatePath("/") // O la ruta específica donde se muestran las listas
        return { success: true, message: "Lista de precios guardada correctamente." }

    } catch (error: any) {
        // 5. ROLLBACK MANUAL (Estrategia de compensación)
        // Si fallaron los detalles, borramos la lista creada para no dejar basura en la BD
        console.error("Error en inserción de detalles, revirtiendo...", error)
        
        await supabase
            .from("listas_precios")
            .delete()
            .eq("id", listaId)

        return { success: false, error: `Error al guardar los detalles: ${error.message || error}` }
    }
}
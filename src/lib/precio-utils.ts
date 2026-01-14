import { createClient } from "@/lib/supabase-client"

interface PrecioCalculado {
    precioAgua: number
    precioCrema: number
}

export async function calcularPreciosUnitarios(
    cantidadAgua: number,
    cantidadCrema: number
): Promise<PrecioCalculado> {
    const supabase = createClient()

    // 1. Obtener la lista de precios activa
    const { data: listaActiva, error: errorLista } = await supabase
        .from("listas_precios")
        .select("id")
        .eq("activa", true)
        .limit(1)
        .single();

    if (errorLista) {
        throw new Error("Error al obtener la lista de precios activa: " + errorLista.message)
    } else if (!listaActiva) {
        throw new Error("No hay una lista de precios activa")
    }

    // 2. Obtener precio para AGUA
    let precioAgua = 0
    if (cantidadAgua > 0) {
        const { data: reglaAgua } = await supabase
            .from("reglas_precios")
            .select("precio_unitario")
            .eq("lista_id", listaActiva.id)
            .eq("tipo_producto", "agua")
            .lte("min_cantidad", cantidadAgua)
            .order("min_cantidad", { ascending: false })
            .limit(1)
            .single();

        if (!reglaAgua) {
            const { data: reglaAguaFallback, error: errorAgua } = await supabase
                .from("reglas_precios")
                .select("precio_unitario")
                .eq("lista_id", listaActiva.id)
                .eq("tipo_producto", "agua")
                .order("min_cantidad", { ascending: true })
                .limit(1)
                .single();

                if (errorAgua) {
                    throw new Error("Error al obtener la regla de precios para helados de agua: " + errorAgua.message)
                }

                precioAgua = reglaAguaFallback ? reglaAguaFallback.precio_unitario : 0;
        } else {
            precioAgua = reglaAgua.precio_unitario ;
        }
        
        
    }

    // 3. Obtener precio para CREMA
    let precioCrema = 0
    if (cantidadCrema > 0) {
        const { data: reglaCrema } = await supabase
            .from("reglas_precios")
            .select("precio_unitario")
            .eq("lista_id", listaActiva.id)
            .eq("tipo_producto", "crema")
            .lte("min_cantidad", cantidadCrema)
            .order("min_cantidad", { ascending: false })
            .limit(1)
            .single()

        if (!reglaCrema) {
            const { data: reglaCremaFallback, error: errorCrema } = await supabase
                .from("reglas_precios")
                .select("precio_unitario")
                .eq("lista_id", listaActiva.id)
                .eq("tipo_producto", "crema")
                .order("min_cantidad", { ascending: true })
                .limit(1)
                .single();

                if (errorCrema) {
                    throw new Error("Error al obtener la regla de precios para helados de crema: " + errorCrema.message)
                }

                precioCrema = reglaCremaFallback ? reglaCremaFallback.precio_unitario : 0;
        } else {
            precioCrema = reglaCrema.precio_unitario ;
        }

        
    }

    return { precioAgua, precioCrema }
}
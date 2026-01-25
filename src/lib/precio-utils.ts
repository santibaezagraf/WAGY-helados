import { createClient } from "./supabase-client";

export interface ReglaPrecios {
    id: number;
    lista_id: number;
    tipo_producto: "agua" | "crema";
    min_cantidad: number;
    precio_unitario: number;
}

interface PrecioCalculado {
    precioAgua: number;
    precioCrema: number;
}

export async function obtenerReglasListaActiva(): Promise<ReglaPrecios[]> {
    const supabase = createClient();

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

    const { data: reglas, error: errorReglas } = await supabase
        .from("reglas_precios")
        .select("*")
        .eq("lista_id", listaActiva.id);

    if (errorReglas) {
        throw new Error("Error al obtener las reglas de precios: " + errorReglas.message)
    }

    return reglas as ReglaPrecios[];
}

export function calcularPreciosUnitarios(
    cantidadAgua: number,
    cantidadCrema: number,
    reglas: ReglaPrecios[]
): PrecioCalculado {
    let precioAgua = 0;
    let precioCrema = 0;

    if (cantidadAgua > 0) {
        const reglasAgua = reglas
            .filter(regla => regla.tipo_producto === "agua")
            .sort((a, b) => b.min_cantidad - a.min_cantidad);
            
        const reglaAplicable = reglasAgua.find(r => r.min_cantidad <= cantidadAgua)
        precioAgua = reglaAplicable?.precio_unitario ?? reglasAgua[reglasAgua.length - 1]?.precio_unitario ?? 0
        }

    if (cantidadCrema > 0) {
        const reglasCrema = reglas
            .filter(regla => regla.tipo_producto === "crema")
            .sort((a, b) => b.min_cantidad - a.min_cantidad);
            
        const reglaAplicable = reglasCrema.find(r => r.min_cantidad <= cantidadCrema)
        precioCrema = reglaAplicable?.precio_unitario ?? reglasCrema[reglasCrema.length - 1]?.precio_unitario ?? 0
    }

    return { precioAgua, precioCrema };
}

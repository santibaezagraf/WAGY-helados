"use client"

import * as React from "react"
import { DataTable } from "@/components/pedidos/data-table"
import { createColumns } from "@/components/pedidos/columns"
import { createClient } from "@/lib/supabase-client"
import { Pedido } from "@/types/pedidos"

interface PedidosClientProps {
  initialData: Pedido[]
}

export function PedidosClient({ initialData }: PedidosClientProps) {
  const [pedidos, setPedidos] = React.useState<Pedido[]>(initialData)

  const handleRefresh = React.useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await supabase
      .from("pedidos")
      .select("*")
      .order("created_at", { ascending: false })

    if (!error && data) {
      setPedidos(data)
    }
  }, [])

  const columns = React.useMemo(
    () => createColumns(handleRefresh), 
    [handleRefresh]
  )

  return <DataTable columns={columns} data={pedidos} onRefresh={handleRefresh} />
}

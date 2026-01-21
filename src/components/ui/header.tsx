"use client"

import { Logo } from "@/components/ui/logo"
import { Button } from "@/components/ui/button"
import { PriceListModal } from "@/components/pedidos/price-list-modal"
import * as React from "react"
import { DollarSign } from "lucide-react"

export function Header() {
  const [priceListModalOpen, setPriceListModalOpen] = React.useState(false)

  return (
    <>
      <header className="bg-cyan-600 border-b-2 border-cyan-300 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <Logo size="sm" />
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">
                WAGY Helados
              </h1>
            </div>
            <Button
              onClick={() => setPriceListModalOpen(true)}
              className="gap-2 bg-white text-cyan-600 hover:bg-slate-100 font-medium"
            >
              <DollarSign className="h-4 w-4" />
              <span className="hidden sm:inline">Listas de Precios</span>
              <span className="sm:hidden">Precios</span>
            </Button>
          </div>
        </div>
      </header>

      <PriceListModal
        open={priceListModalOpen}
        onOpenChange={setPriceListModalOpen}
      />
    </>
  )
}

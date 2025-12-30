'use client'

import { useRouter } from 'next/navigation'

export default function RefreshButton() {
  const router = useRouter()

  const handleRefresh = () => {
    router.refresh()
  }

  return (
    <button 
      onClick={handleRefresh}
      className="rounded-lg bg-green-600 px-6 py-3 text-white font-semibold hover:bg-green-700 transition-colors shadow-md"
    >
      🔄 Refrescar Pedidos
    </button>
  )
}

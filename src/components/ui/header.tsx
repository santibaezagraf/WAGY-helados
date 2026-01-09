import { Logo } from "@/components/ui/logo"

export function Header() {
  return (
    <header className="bg-cyan-600 border-b-2 border-cyan-300 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3 py-4">
          <Logo size="sm" />
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-800">
            WAGY Helados
          </h1>
        </div>
      </div>
    </header>
  )
}

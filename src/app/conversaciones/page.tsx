import { createClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import { Header } from '@/components/ui/header'
import { getConversacionesRecientes } from '@/lib/actions/mensajes'
import { getInboxConversaciones } from '@/lib/actions/conversaciones'
import { type Conversacion } from '@/lib/conversaciones-utils'
import { ConversacionesInbox } from '@/components/conversaciones/conversaciones-inbox'

// Inbox completo de conversaciones (complementa el dropdown de 24h del header):
// listado paginado de los últimos 30 días, con búsqueda por teléfono y filtros
// Todas / Pendientes / Bloqueadas. Las bloqueadas se pueden desbloquear desde acá
// aunque el número lleve rato mudo (lo que el menú de 24h no permitía).
export default async function ConversacionesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Estado inicial: primera página del filtro por defecto ('todas'). El resto de
  // la navegación (tabs, búsqueda, paginación) la maneja el cliente vía la action.
  const inicial = await getInboxConversaciones('todas', '', 1)

  // El header necesita sus conversaciones recientes (mismo prop que en las otras
  // páginas); si falla, no rompemos el inbox.
  let conversaciones: Conversacion[] = []
  try {
    conversaciones = await getConversacionesRecientes()
  } catch {
    /* noop */
  }

  return (
    // h-screen + overflow-hidden: el layout tipo WhatsApp Web fija el alto (lista
    // y chat scrollean por dentro), no crece la página.
    <div className="flex h-screen flex-col overflow-hidden">
      <Header conversacionesIniciales={conversaciones} />
      <main className="min-h-0 flex-1 bg-slate-50">
        <ConversacionesInbox inicial={inicial} />
      </main>
    </div>
  )
}

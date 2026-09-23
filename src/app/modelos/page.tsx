import { sesionActual } from '@/lib/auth-rol'
import { puede } from '@/lib/rol'
import { redirect } from 'next/navigation'
import { Header } from '@/components/ui/header'
import { getConversacionesRecientes } from '@/lib/actions/mensajes'
import { getEstadoModelos } from '@/lib/actions/uso-modelo'
import { type Conversacion } from '@/lib/conversaciones-utils'
import { PanelModelos } from '@/components/modelos/panel-modelos'

// Estado de los modelos LLM del bot: qué modelo está activo, cuántos tokens se
// llevan consumidos hoy vs. el límite diario de Groq (TPD), la serie de consumo
// de las últimas 2 semanas y los saltos de fallback recientes. Se llega desde el
// botón del header o clickeando el banner de alerta de fallback.
export default async function ModelosPage() {
  const sesion = await sesionActual()
  if (!sesion) redirect('/login')
  if (!puede(sesion.rol, 'modelos.ver')) redirect('/')

  const inicial = await getEstadoModelos()

  let conversaciones: Conversacion[] = []
  try {
    conversaciones = await getConversacionesRecientes()
  } catch {
    /* el header no es crítico para esta página */
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header conversacionesIniciales={conversaciones} rol={sesion.rol} />
      <PanelModelos inicial={inicial} />
    </div>
  )
}

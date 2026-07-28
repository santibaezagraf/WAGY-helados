'use server'

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient as createUserClient } from '@/lib/supabase-server'

// Cliente service-role: lee/escribe `alertas_modelo` bypasseando RLS. La tabla es
// nueva y todavía no está en src/types/supabase.ts (no corrimos update-types),
// así que el cliente va SIN tipar — misma decisión que el helper del bot
// (alertas.ts) y que atencion-humana.ts. La página valida sesión, pero las
// actions son invocables por su cuenta, así que exigimos usuario abajo.
const supabaseAdmin = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// Ventana de relevancia del banner: una alerta más vieja que esto ya no aporta
// (la cuota de Groq se resetea a diario); si sigue sin resolver, deja de molestar.
const HORAS_VENTANA = 24

export type AlertaModelo = {
  id: number
  created_at: string
  modelo_agotado: string
  modelo_fallback: string | null
  telefono: string | null
}

/** Aborta si no hay usuario autenticado (estas actions usan service-role). */
async function exigirUsuario() {
  const supabase = await createUserClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')
}

/**
 * Alertas de fallback SIN resolver de las últimas HORAS_VENTANA, más recientes
 * primero. Es lo que alimenta el banner en el carga inicial; después Realtime lo
 * mantiene al día. Fail-soft: ante error devuelve [] (el banner no es crítico).
 */
export async function getAlertasModeloActivas(): Promise<AlertaModelo[]> {
  await exigirUsuario()
  const desde = new Date(Date.now() - HORAS_VENTANA * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabaseAdmin
    .from('alertas_modelo')
    .select('id, created_at, modelo_agotado, modelo_fallback, telefono')
    .eq('resuelto', false)
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    console.error('⚠️ No se pudieron leer las alertas de modelo:', error.message)
    return []
  }
  return (data ?? []) as AlertaModelo[]
}

/**
 * Marca como resueltas todas las alertas sin resolver (el banner es un "visto"
 * global, no por fila). Devuelve true si salió bien.
 */
export async function resolverAlertasModelo(): Promise<boolean> {
  await exigirUsuario()
  const { error } = await supabaseAdmin
    .from('alertas_modelo')
    .update({ resuelto: true })
    .eq('resuelto', false)
  if (error) {
    console.error('⚠️ No se pudieron resolver las alertas de modelo:', error.message)
    return false
  }
  return true
}

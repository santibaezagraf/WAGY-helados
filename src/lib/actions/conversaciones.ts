'use server'

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient as createUserClient } from '@/lib/supabase-server'
import { armarPreviewMensaje } from '@/lib/conversaciones-utils'

// Cliente service-role: lee la vista `conversaciones_inbox` y atencion_humana
// bypasseando RLS (igual que el resto del pipeline del dashboard). La vista es
// nueva y no está en los tipos generados, así que va SIN el genérico Database —
// mismo criterio que atencion-humana.ts / alertas.ts.
const supabaseAdmin = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export type FiltroInbox = 'todas' | 'pendientes' | 'bloqueadas'

export type FilaInbox = {
  telefono: string
  // Preview del último mensaje (null en bloqueados mudos, sin actividad).
  preview: string | null
  ultimoAt: string | null
  requiereAtencion: boolean
  tomaActiva: boolean
  bloqueado: boolean
}

export type PaginaInbox = {
  items: FilaInbox[]
  // Cantidad total de conversaciones que matchean (para la paginación).
  // `null` = NO se recontó en esta llamada (refetch de fondo con conCount=false):
  // el cliente conserva el total que ya tenía.
  total: number | null
  page: number
  pageSize: number
}

const PAGE_SIZE = 25

/** Aborta si no hay usuario autenticado (esta action usa service-role). */
async function exigirUsuario() {
  const supabase = await createUserClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')
}

// Fila cruda de la vista conversaciones_inbox.
type FilaVista = {
  telefono: string
  ultimo_at: string | null
  ultimo_texto: string | null
  ultimo_tipo: string | null
  ultimo_media_caption: string | null
  ultimo_rol: string | null
  requiere_atencion: boolean
  bloqueado: boolean
  toma_activa: boolean
}

/**
 * Página del inbox de conversaciones.
 *  - 'todas' / 'pendientes': leen la vista `conversaciones_inbox` (últimos 30
 *    días, 1 fila por teléfono), ordenadas por recencia, con búsqueda por
 *    teléfono. 'pendientes' filtra `requiere_atencion=true`.
 *  - 'bloqueadas': lee atencion_humana (bloqueado=true) SIN ventana temporal, así
 *    un número bloqueado que se quedó mudo sigue apareciendo y se puede
 *    desbloquear (el límite que esta vista viene a cerrar).
 *
 * Fail-soft: ante error devuelve una página vacía (no rompemos la pantalla).
 *
 * `conCount` (default true): si es false NO se pide el `count: 'exact'`, que sobre
 * la vista `distinct on` obliga a materializar TODO el conjunto para contarlo.
 * Los refetch de FONDO (Realtime, marcar-atendido, desbloquear) lo pasan en false
 * — solo reordenan/actualizan flags, el total casi nunca cambia — y devuelven
 * `total: null` para que el cliente conserve el que ya tenía. El count solo se
 * recalcula al NAVEGAR (cambio de tab/búsqueda/página), que es cuando el
 * conjunto realmente cambia.
 */
export async function getInboxConversaciones(
  filtro: FiltroInbox = 'todas',
  busqueda = '',
  page = 1,
  conCount = true,
): Promise<PaginaInbox> {
  await exigirUsuario()

  const pageNum = Math.max(1, page)
  const from = (pageNum - 1) * PAGE_SIZE
  const to = from + PAGE_SIZE - 1
  const q = busqueda.trim()
  // Solo pedimos el conteo cuando hace falta; sin esta opción PostgREST no cuenta.
  const opcionesCount = conCount ? { count: 'exact' as const } : undefined
  const totalDe = (count: number | null) => (conCount ? count ?? 0 : null)

  if (filtro === 'bloqueadas') {
    let query = supabaseAdmin
      .from('atencion_humana')
      .select('telefono, updated_at', opcionesCount)
      .eq('bloqueado', true)
      .order('updated_at', { ascending: false })
      .range(from, to)
    if (q) query = query.ilike('telefono', `%${q}%`)

    const { data, error, count } = await query
    if (error) {
      console.error('⚠️ No se pudieron leer los números bloqueados:', error.message)
      return { items: [], total: 0, page: pageNum, pageSize: PAGE_SIZE }
    }
    const items: FilaInbox[] = (data ?? []).map((r: { telefono: string; updated_at: string | null }) => ({
      telefono: r.telefono,
      preview: null,
      ultimoAt: r.updated_at,
      requiereAtencion: false,
      tomaActiva: false,
      bloqueado: true,
    }))
    return { items, total: totalDe(count), page: pageNum, pageSize: PAGE_SIZE }
  }

  let query = supabaseAdmin
    .from('conversaciones_inbox')
    .select('*', opcionesCount)
    .order('ultimo_at', { ascending: false })
    .range(from, to)
  if (filtro === 'pendientes') query = query.eq('requiere_atencion', true)
  if (q) query = query.ilike('telefono', `%${q}%`)

  const { data, error, count } = await query
  if (error) {
    console.error('⚠️ No se pudo leer el inbox de conversaciones:', error.message)
    return { items: [], total: 0, page: pageNum, pageSize: PAGE_SIZE }
  }

  const items: FilaInbox[] = (data ?? []).map((r: FilaVista) => ({
    telefono: r.telefono,
    preview: armarPreviewMensaje({
      tipo: r.ultimo_tipo,
      texto: r.ultimo_texto,
      media_caption: r.ultimo_media_caption,
      rol: r.ultimo_rol,
    }),
    ultimoAt: r.ultimo_at,
    requiereAtencion: r.requiere_atencion,
    tomaActiva: r.toma_activa,
    bloqueado: r.bloqueado,
  }))
  return { items, total: totalDe(count), page: pageNum, pageSize: PAGE_SIZE }
}

'use server'

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { exigirPermiso } from '@/lib/auth-rol'
import {
  MODELOS_EXTRACCION,
  MODELOS_CONSULTA,
  MODELOS_CONOCIDOS,
  LIMITE_TPD,
  PROVEEDOR_LLM,
  limiteDeModelo,
  type ProveedorModelo,
  type MetricaLimite,
} from '@/lib/bot/modelos'
import { fechaISOAR, sumarDiasAR } from '@/lib/zona-horaria'

// Cliente service-role: lee la vista `uso_modelo_diario` y la tabla
// `alertas_modelo` bypasseando RLS. Las dos son nuevas y no están en los tipos
// generados, así que el cliente va SIN el genérico Database — mismo criterio que
// conversaciones.ts / alertas-modelo.ts.
const supabaseAdmin = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// Cuántos días de historia muestran los gráficos. La vista guarda 30; mostramos
// los últimos 14 (2 semanas) que es lo útil para ver tendencia sin ruido.
const DIAS_SERIE = 14

/** Un día de la serie: tokens totales y llamadas de ese día (0 si no hubo uso). */
export type UsoDiario = {
  dia: string // YYYY-MM-DD (día calendario AR)
  tokens: number
  llamadas: number
}

/** Estado consolidado de un modelo de la(s) cadena(s). */
export type EstadoModelo = {
  modelo: string
  /** Proveedor del modelo (groq | google), derivado del id. */
  proveedor: ProveedorModelo
  /** Índice en la cadena de extracción (0 = primario), o null si no la integra. */
  rolExtraccion: number | null
  /** Índice en la cadena de consulta (0 = primario), o null si no la integra. */
  rolConsulta: number | null
  tokensHoy: number
  llamadasHoy: number
  /** Métrica diaria que ata para este proveedor: 'tokens' (Groq) | 'requests' (Gemini). */
  metrica: MetricaLimite
  /** Valor de la métrica principal HOY (tokensHoy o llamadasHoy según `metrica`). */
  usoHoy: number
  /** Tope diario de la métrica principal (TPD para Groq, RPD para Gemini). 0 = sin dato. */
  limiteDiario: number
  /** Etiqueta legible de la métrica principal (ej. "tokens/día (TPD)"). */
  etiquetaMetrica: string
  /** Límites de rate por minuto, de referencia (Gemini). */
  rpm: number | null
  tpm: number | null
  /** Serie diaria de los últimos DIAS_SERIE días, en orden cronológico. */
  serie: UsoDiario[]
  /** Saltos de fallback HOY donde ESTE modelo se quedó sin cuota (429). */
  saltosHoy: number
  /** ¿Se agotó hoy? (tuvo al menos un 429 registrado hoy) */
  agotadoHoy: boolean
}

export type AlertaFallback = {
  id: number
  created_at: string
  modelo_agotado: string
  modelo_fallback: string | null
}

export type EstadoModelosResp = {
  modelos: EstadoModelo[]
  /** Proveedor activo en producción (según env LLM_PROVIDER). */
  proveedorActivo: ProveedorModelo
  /** Métrica del gráfico diario principal, según el proveedor activo. */
  metricaActiva: MetricaLimite
  cadenaExtraccion: string[]
  cadenaConsulta: string[]
  limiteTPD: number
  diasSerie: number
  totalTokensHoy: number
  totalLlamadasHoy: number
  /** Serie diaria SUMANDO todos los modelos (para el gráfico principal). */
  serieTotal: UsoDiario[]
  alertasRecientes: AlertaFallback[]
  generadoEn: string
}

// Fila cruda de la vista uso_modelo_diario.
type FilaUso = {
  modelo: string
  tipo: string
  dia: string
  llamadas: number
  tokens_input: number
  tokens_output: number
  tokens_total: number
}

// El gate de permiso es la ÚNICA protección: esta action usa el cliente
// service-role, que bypassea la RLS. No hay segunda capa.

/** Lista de claves YYYY-MM-DD (AR) de los últimos `dias` días, cronológica. */
function ultimosDiasAR(dias: number): string[] {
  const hoy = new Date()
  const claves: string[] = []
  for (let i = dias - 1; i >= 0; i--) {
    claves.push(fechaISOAR(sumarDiasAR(hoy, -i)))
  }
  return claves
}

/**
 * Estado consolidado de los modelos LLM del bot: cadenas + roles, uso de tokens
 * de hoy vs. el TPD, serie diaria de 2 semanas y saltos de fallback recientes.
 *
 * Fuente de verdad de las cadenas: `@/lib/bot/modelos` (lo mismo que corre el
 * bot). El uso sale de la vista agregada; las alertas, de `alertas_modelo`.
 */
export async function getEstadoModelos(): Promise<EstadoModelosResp> {
  await exigirPermiso('modelos.ver')

  const claves = ultimosDiasAR(DIAS_SERIE)
  const hoyClave = claves[claves.length - 1]

  // Uso agregado (la vista ya recorta a 30 días y agrupa por modelo/tipo/día AR).
  const { data: filasUso, error: errUso } = await supabaseAdmin
    .from('uso_modelo_diario')
    .select('modelo, tipo, dia, llamadas, tokens_input, tokens_output, tokens_total')
  if (errUso) {
    console.error('⚠️ No se pudo leer uso_modelo_diario:', errUso.message)
  }
  const filas = (filasUso ?? []) as FilaUso[]

  // Alertas de fallback sin filtrar por resuelto (queremos el histórico de saltos
  // de hoy para marcar "agotado"), de las últimas 24h, más recientes primero.
  const desde24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: filasAlerta, error: errAlerta } = await supabaseAdmin
    .from('alertas_modelo')
    .select('id, created_at, modelo_agotado, modelo_fallback')
    .gte('created_at', desde24h)
    .order('created_at', { ascending: false })
    .limit(50)
  if (errAlerta) {
    console.error('⚠️ No se pudieron leer las alertas de modelo:', errAlerta.message)
  }
  const alertas = (filasAlerta ?? []) as AlertaFallback[]

  // Saltos de HOY por modelo agotado (para el flag agotadoHoy). "Hoy" es el día
  // calendario AR; comparamos la clave del created_at contra la de hoy.
  const saltosHoyPorModelo = new Map<string, number>()
  for (const a of alertas) {
    if (fechaISOAR(new Date(a.created_at)) !== hoyClave) continue
    saltosHoyPorModelo.set(
      a.modelo_agotado,
      (saltosHoyPorModelo.get(a.modelo_agotado) ?? 0) + 1,
    )
  }

  // Índice de uso: modelo -> (díaClave -> {tokens, llamadas}) sumando tipos.
  const usoPorModelo = new Map<string, Map<string, { tokens: number; llamadas: number }>>()
  for (const f of filas) {
    const porDia = usoPorModelo.get(f.modelo) ?? new Map()
    const prev = porDia.get(f.dia) ?? { tokens: 0, llamadas: 0 }
    prev.tokens += Number(f.tokens_total ?? 0)
    prev.llamadas += Number(f.llamadas ?? 0)
    porDia.set(f.dia, prev)
    usoPorModelo.set(f.modelo, porDia)
  }

  const rolExtraccion = (m: string) => {
    const i = (MODELOS_EXTRACCION as readonly string[]).indexOf(m)
    return i === -1 ? null : i
  }
  const rolConsulta = (m: string) => {
    const i = (MODELOS_CONSULTA as readonly string[]).indexOf(m)
    return i === -1 ? null : i
  }

  // Todos los modelos conocidos (aunque no tengan uso todavía) + los que
  // aparezcan en el uso/alertas pero ya no estén en la cadena (histórico).
  const modelosSet = new Set<string>(MODELOS_CONOCIDOS)
  for (const m of usoPorModelo.keys()) modelosSet.add(m)
  for (const m of saltosHoyPorModelo.keys()) modelosSet.add(m)

  const modelos: EstadoModelo[] = Array.from(modelosSet).map((modelo) => {
    const porDia = usoPorModelo.get(modelo)
    const serie: UsoDiario[] = claves.map((dia) => {
      const u = porDia?.get(dia)
      return { dia, tokens: u?.tokens ?? 0, llamadas: u?.llamadas ?? 0 }
    })
    const hoy = serie[serie.length - 1]
    const saltos = saltosHoyPorModelo.get(modelo) ?? 0
    const lim = limiteDeModelo(modelo)
    const usoHoy = lim.metrica === 'tokens' ? hoy.tokens : hoy.llamadas
    return {
      modelo,
      proveedor: lim.proveedor,
      rolExtraccion: rolExtraccion(modelo),
      rolConsulta: rolConsulta(modelo),
      tokensHoy: hoy.tokens,
      llamadasHoy: hoy.llamadas,
      metrica: lim.metrica,
      usoHoy,
      limiteDiario: lim.limiteDiario,
      etiquetaMetrica: lim.etiquetaMetrica,
      rpm: lim.rpm ?? null,
      tpm: lim.tpm ?? null,
      serie,
      saltosHoy: saltos,
      agotadoHoy: saltos > 0,
    }
  })

  // Orden: primero los de la cadena de extracción (por rol), después el resto.
  modelos.sort((a, b) => {
    const ra = a.rolExtraccion ?? a.rolConsulta ?? 99
    const rb = b.rolExtraccion ?? b.rolConsulta ?? 99
    return ra - rb
  })

  // Serie total (suma de todos los modelos por día).
  const serieTotal: UsoDiario[] = claves.map((dia) => {
    let tokens = 0
    let llamadas = 0
    for (const m of modelos) {
      const u = m.serie.find((s) => s.dia === dia)
      if (u) {
        tokens += u.tokens
        llamadas += u.llamadas
      }
    }
    return { dia, tokens, llamadas }
  })

  const totalTokensHoy = modelos.reduce((s, m) => s + m.tokensHoy, 0)
  const totalLlamadasHoy = modelos.reduce((s, m) => s + m.llamadasHoy, 0)

  return {
    modelos,
    proveedorActivo: PROVEEDOR_LLM,
    metricaActiva: PROVEEDOR_LLM === 'google' ? 'requests' : 'tokens',
    cadenaExtraccion: [...MODELOS_EXTRACCION],
    cadenaConsulta: [...MODELOS_CONSULTA],
    limiteTPD: LIMITE_TPD,
    diasSerie: DIAS_SERIE,
    totalTokensHoy,
    totalLlamadasHoy,
    serieTotal,
    alertasRecientes: alertas,
    generadoEn: new Date().toISOString(),
  }
}

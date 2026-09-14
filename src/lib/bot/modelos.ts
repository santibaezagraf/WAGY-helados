// Fuente de verdad ÚNICA de las cadenas de modelos LLM del bot y su límite de
// cuota. Antes cada llamador (extracción en procesar.ts, respuesta acotada en
// consultas-negocio.ts) declaraba su propia copia de la cadena; ahora la
// importan de acá, y la página de estado de modelos (`/modelos`) también la lee,
// así el dashboard muestra exactamente la cadena que corre en producción sin
// duplicar (y sin poder desincronizarse).
//
// Cadena de FALLBACK: el PRIMARIO (índice 0) es el único que se testea en el
// nightly (por eso el harness y /api/dev/test-ia lo dejan hardcodeado). Los demás
// son fallback SOLO de producción: si el primario se queda sin cuota (429 / TPD),
// seguimos con el siguiente en vez de contestar "no te entendí". Todos bancan
// structured output y tienen cubeta TPD SEPARADA en Groq, así que si se agotó el
// primario es muy probable que el siguiente siga disponible.
// (moonshotai/kimi-k2-instruct y qwen/qwen3-32b fueron dados de baja por Groq —
// verificado 2026-08-22 contra GET /openai/v1/models — reemplazados/quitados.)

// PROVEEDOR LLM ACTIVO. Toggle por env `LLM_PROVIDER`: 'google' usa Gemini (Google
// AI Studio), cualquier otra cosa (o ausente) mantiene Groq —el default, para no
// cambiar producción sin querer—. La instanciación del modelo vive en
// proveedor-llm.ts; acá solo decidimos QUÉ cadena de ids se recorre.
export const PROVEEDOR_LLM: 'groq' | 'google' =
  process.env.LLM_PROVIDER === 'google' ? 'google' : 'groq';

// --- Cadenas por proveedor ---
// Groq: cada modelo tiene cubeta TPD separada (200k/día), por eso el fallback ante
// 429 sirve. (kimi-k2 y qwen3-32b fueron dados de baja — ver nota arriba.)
const EXTRACCION_GROQ = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b',
] as const;
const CONSULTA_GROQ = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.6-27b',
] as const;

// Google (Gemini): primario flash (rápido/barato, análogo a gpt-oss-20b), con
// fallback a otros modelos del free tier de AI Studio —cada modelo tiene su propio
// límite RPM/RPD, así que saltar ante 429 también ayuda—. Todos bancan structured
// output (generateObject). Los ids son los nativos de Gemini (sin prefijo de org).
// Verificado 2026-08-27 contra generateContent con la key de AI Studio: las 2.5
// están dadas de baja para cuentas NUEVAS (404 → usar la línea 3.x), y gemini-3.7
// / gemini-flash-latest devolvían 503 (sobrecargados), así que el primario es la
// 3.6 que Google recomienda y que respondía 200. Evitamos los alias `-latest`
// porque se mueven solos hacia el modelo más nuevo (hoy 3.7, sobrecargado).
const EXTRACCION_GOOGLE = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
] as const;
const CONSULTA_GOOGLE = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
] as const;

/** Cadena de extracción del pedido (`generateObject` con PedidoIASchema). */
export const MODELOS_EXTRACCION: readonly string[] =
  PROVEEDOR_LLM === 'google' ? EXTRACCION_GOOGLE : EXTRACCION_GROQ;

/** Cadena de la respuesta libre acotada (consulta de negocio / pregunta de tipo). */
export const MODELOS_CONSULTA: readonly string[] =
  PROVEEDOR_LLM === 'google' ? CONSULTA_GOOGLE : CONSULTA_GROQ;

/**
 * Límite de tokens por día (TPD) del free-tier de Groq, POR MODELO. Cada modelo
 * de la cadena tiene su propia cubeta de 200k/día; por eso el fallback funciona
 * (agotar uno no agota los otros). Es el denominador de las barras de uso en la
 * página de estado. Si Groq cambia el plan, se ajusta acá.
 */
export const LIMITE_TPD = 200_000;

/** Tipo de llamada registrada en `uso_modelo` (para desglosar el consumo). */
export type TipoUsoModelo = 'extraccion' | 'consulta';

/**
 * Unión de todos los modelos que el bot puede llegar a usar, en orden de
 * preferencia y sin repetir. La página los recorre para mostrar una tarjeta por
 * modelo aunque hoy no haya registros de uso todavía.
 */
export const MODELOS_CONOCIDOS: readonly string[] = Array.from(
  new Set<string>([...MODELOS_EXTRACCION, ...MODELOS_CONSULTA]),
);

// ─── Límites de cuota POR PROVEEDOR ──────────────────────────────────────────
//
// Groq y Gemini no se limitan igual, así que la página no puede mostrar "200k
// tokens" para todos:
//   - Groq (free tier): la restricción que nos importa es TPD = tokens por día,
//     200k POR MODELO (cubeta separada, por eso el fallback ante 429 sirve).
//   - Gemini (free tier de AI Studio): la restricción que ata es de REQUESTS —
//     RPD (requests/día) y RPM (requests/minuto)— más un TPM (tokens/minuto). NO
//     hay un tope de tokens/día como Groq. Por eso la métrica diaria principal de
//     un modelo Gemini es "requests/día", no tokens.
//
// Los números de Gemini son del free tier y CAMBIAN seguido (Google recortó el
// free tier un 50-80% en dic-2025 y ya no los publica en la doc: se ven en
// https://aistudio.google.com/rate-limit). Ajustalos ahí si Google los mueve.

export type ProveedorModelo = 'groq' | 'google';

/** Qué métrica diaria es la que ata para este proveedor. */
export type MetricaLimite = 'tokens' | 'requests';

export type LimiteModelo = {
  proveedor: ProveedorModelo;
  /** Métrica de la barra diaria principal: tokens (Groq) o requests (Gemini). */
  metrica: MetricaLimite;
  /** Tope diario de la métrica principal. */
  limiteDiario: number;
  /** Etiqueta legible de la métrica principal (ej. "tokens/día (TPD)"). */
  etiquetaMetrica: string;
  /** Límites de RATE (por minuto), de referencia — no se grafican como barra diaria. */
  rpm?: number;
  tpm?: number;
};

/** Deriva el proveedor de un id de modelo (robusto ante historial mixto). */
export function proveedorDeModelo(modelo: string): ProveedorModelo {
  return modelo.startsWith('gemini') ? 'google' : 'groq';
}

// Tabla de límites por id de modelo. Editá acá cuando cambie el plan.
const LIMITES_MODELO: Record<string, LimiteModelo> = {
  // Groq — TPD 200k por modelo.
  'openai/gpt-oss-20b': {
    proveedor: 'groq', metrica: 'tokens', limiteDiario: LIMITE_TPD, etiquetaMetrica: 'tokens/día (TPD)',
  },
  'openai/gpt-oss-120b': {
    proveedor: 'groq', metrica: 'tokens', limiteDiario: LIMITE_TPD, etiquetaMetrica: 'tokens/día (TPD)',
  },
  'qwen/qwen3.6-27b': {
    proveedor: 'groq', metrica: 'tokens', limiteDiario: LIMITE_TPD, etiquetaMetrica: 'tokens/día (TPD)',
  },
  // Gemini — free tier de AI Studio. La métrica diaria que ata es RPD.
  //
  // ⚠️ RPD = 20, MEDIDO (no estimado) el 2026-08-28 con la key real: al agotarse,
  // la API devuelve 429 con
  //   quotaId:    "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
  //   quotaValue: "20"
  // y NO se recupera esperando (es por día, no por minuto). Acá decía 1.500 RPD
  // —el número histórico de la doc— y es 75× optimista: con eso la barra de uso
  // del dashboard marcaría ~1% cuando en realidad la cuota ya está quemada.
  // Es "per project per model", así que cada modelo de la cadena tiene su propia
  // cubeta de 20 (por eso el fallback ante 429 sirve), pero el total del día son
  // ~60 requests entre los tres. Verificá en https://aistudio.google.com/rate-limit.
  'gemini-3.6-flash': {
    proveedor: 'google', metrica: 'requests', limiteDiario: 20, etiquetaMetrica: 'requests/día (RPD)', rpm: 10, tpm: 250_000,
  },
  'gemini-3.5-flash': {
    proveedor: 'google', metrica: 'requests', limiteDiario: 20, etiquetaMetrica: 'requests/día (RPD)', rpm: 10, tpm: 250_000,
  },
  'gemini-3.5-flash-lite': {
    proveedor: 'google', metrica: 'requests', limiteDiario: 20, etiquetaMetrica: 'requests/día (RPD)', rpm: 15, tpm: 250_000,
  },
};

/**
 * Límites de un modelo. Si el id no está en la tabla, cae a un default sensato
 * según el proveedor derivado del id (Groq → TPD 200k; Gemini → sin dato de RPD
 * conocido, 0 = "sin límite configurado").
 */
export function limiteDeModelo(modelo: string): LimiteModelo {
  const conocido = LIMITES_MODELO[modelo];
  if (conocido) return conocido;
  const proveedor = proveedorDeModelo(modelo);
  return proveedor === 'google'
    ? { proveedor, metrica: 'requests', limiteDiario: 0, etiquetaMetrica: 'requests/día (RPD)' }
    : { proveedor, metrica: 'tokens', limiteDiario: LIMITE_TPD, etiquetaMetrica: 'tokens/día (TPD)' };
}

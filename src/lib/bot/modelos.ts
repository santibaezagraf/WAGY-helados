// Fuente de verdad ÚNICA de las cadenas de modelos LLM del bot y su límite de
// cuota. Antes cada llamador (extracción en procesar.ts, respuesta acotada en
// consultas-negocio.ts) declaraba su propia copia de la cadena; ahora la
// importan de acá, y la página de estado de modelos (`/modelos`) también la lee,
// así el dashboard muestra exactamente la cadena que corre en producción sin
// duplicar (y sin poder desincronizarse).
//
// Cadena de FALLBACK: si el PRIMARIO (índice 0) se queda sin cuota (429 / TPD),
// seguimos con el siguiente en vez de contestar "no te entendí". Todos bancan
// structured output. Desde 2026-09-15 la cadena por defecto es CRUZADA: 3 de
// Groq (cada uno con su propia cubeta TPD, así que agotar uno deja a los otros
// disponibles) y, como último recurso (4ta/5ta/6ta opción), 3 de Google —ver
// EXTRACCION_GOOGLE/CONSULTA_GOOGLE más abajo para el detalle y el requisito de
// GOOGLE_GENERATIVE_AI_API_KEY—.
//
// Quién recorre la cadena y quién no: el fallback vive en el loop de extracción
// de procesar.ts y en `generarAcotado` de consultas-negocio.ts, así que TODO lo
// que pase por `procesarMensajesDeCliente` la hereda — incluido
// /api/dev/simular-conversacion y, por lo tanto, `npm run probar-bot` y el
// nightly, que llaman al camino de producción en vez de instanciar su propio
// modelo. El único fijado al primario a propósito es /api/dev/test-ia (`npm run
// eval`): ese suite mide el prompt contra EL modelo que atiende clientes, así que
// un 429 ahí tiene que verse, no taparse.
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
  'qwen/qwen3.8-27b',
] as const;
const CONSULTA_GROQ = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
] as const;

// Google (Gemini): primario un *-flash-lite. Cambio 2026-09-15: la cadena
// original (3.6-flash → 3.5-flash → 3.5-flash-lite) se agotaba en ~20 requests
// porque los modelos "flash" NO -lite del free tier de AI Studio tienen un RPD
// (requests/día) mucho más bajo que los -lite —medido contra la key real:
// gemini-3.6-flash devolvió 429 con quotaId
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue "20"—, y ese
// eval necesita ~66 llamadas para una corrida completa. Los `*-flash-lite` en
// cambio muestran (aistudio.google.com/app/rate-limit, panel del proyecto,
// 2026-09-15 — no medido por 429 como el dato de arriba, es lo que reporta la
// página oficial): 500 RPD / 15 RPM / 250k TPM. 25× más cupo diario que la
// cadena vieja, alcanza para correr el eval completo varias veces por día.
// Ambos ids existen y responden 200 hoy (2026-09-15, verificado contra
// generateContent con la key real) — no fueron dados de baja como pasó con la
// línea 2.5. Se deja gemini-3.5-flash como último escalón (no-lite, RPD bajo
// medido) solo por si algún día hace falta más capacidad de razonamiento que
// las lite y se acepta gastarlo rápido; NO se agrega 3.6-flash de vuelta —ver
// nota arriba, es la que se agotó en la corrida real.
const EXTRACCION_GOOGLE = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
] as const;
const CONSULTA_GOOGLE = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
] as const;

// Composición final de cada cadena (decisión 2026-09-15: fallback CRUZADO de
// producción). Dos modos:
//   - Default (`LLM_PROVIDER` ausente o != 'google', producción normal): Groq
//     primero (3 modelos, su propia cubeta TPD de 200k/día c/u) y los 3 de
//     Google COMO COLA de la MISMA cadena — 4ta/5ta/6ta opción, solo se tocan
//     si los tres de Groq ya agotaron cuota. `crearModeloLLM` (proveedor-llm.ts)
//     elige el SDK POR ID (`proveedorDeModelo`), así que una cadena con ids
//     mixtos funciona sin rama especial.
//   - `LLM_PROVIDER=google` (pruebas / A-B): cadena PURA de Google, sin Groq —
//     para medir el prompt contra Gemini solo, sin que un 429 salte a Groq y
//     ensucie la comparación.
//
// ⚠️ Requisito operativo: para que la cola de Google (4/5/6) funcione de
// verdad cuando se llegue a ella, `GOOGLE_GENERATIVE_AI_API_KEY` tiene que
// estar seteada donde sea que esta cadena corra en modo default —producción
// (Vercel) y, si se quiere ejercer el fallback ahí también, los secrets del
// nightly de CI—. Si falta la key, el SDK de Google recién falla al hacer la
// llamada real (`loadApiKey` es perezoso), con un error que NO matchea
// `esRateLimit` ni `esModeloInexistente` → se trata como fallo de validación:
// se reintenta el MISMO modelo `MAX_ATTEMPTS` veces y después el loop se
// RINDE sin probar los eslabones siguientes de la cola. Sin la key, entonces,
// llegar al 4to modelo cuesta 3 intentos perdidos y el cliente igual termina
// en "no te entendí" — ligeramente peor que hoy (más latencia), no mejor.
export const MODELOS_EXTRACCION: readonly string[] =
  PROVEEDOR_LLM === 'google' ? EXTRACCION_GOOGLE : [...EXTRACCION_GROQ, ...EXTRACCION_GOOGLE];

/** Cadena de la respuesta libre acotada (consulta de negocio / pregunta de tipo). */
export const MODELOS_CONSULTA: readonly string[] =
  PROVEEDOR_LLM === 'google' ? CONSULTA_GOOGLE : [...CONSULTA_GROQ, ...CONSULTA_GOOGLE];

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
  'qwen/qwen3.8-27b': {
    proveedor: 'groq', metrica: 'tokens', limiteDiario: LIMITE_TPD, etiquetaMetrica: 'tokens/día (TPD)',
  },
  // Gemini — free tier de AI Studio. La métrica diaria que ata es RPD.
  //
  // Los "flash" NO -lite tienen un RPD bajo, MEDIDO (no estimado) el 2026-08-28
  // contra la key real: al agotarse, gemini-3.6-flash devolvió 429 con
  //   quotaId:    "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
  //   quotaValue: "20"
  // y no se recupera esperando (es por día, no por minuto). gemini-3.5-flash
  // comparte la misma familia de límite (no confirmado con 429 propio, pero
  // mismo tier que 3.6 en la doc) — se deja igual por precaución hasta medirlo.
  //
  // Los *-flash-lite en cambio muestran 500 RPD / 15 RPM / 250k TPM en
  // aistudio.google.com/app/rate-limit (panel del proyecto, 2026-09-15) — DECLARADO
  // por la página oficial, no confirmado por 429 propio (verificarlo requeriría
  // agotar las 500 requests del día, no vale la pena solo para confirmar el techo).
  // Si algún día se ve un 429 antes de la request #500, actualizar este número.
  // Es "per project per model" (cubeta separada por modelo, por eso el fallback
  // ante 429 sirve).
  'gemini-3.1-flash-lite': {
    proveedor: 'google', metrica: 'requests', limiteDiario: 500, etiquetaMetrica: 'requests/día (RPD)', rpm: 15, tpm: 250_000,
  },
  'gemini-3.5-flash-lite': {
    proveedor: 'google', metrica: 'requests', limiteDiario: 500, etiquetaMetrica: 'requests/día (RPD)', rpm: 15, tpm: 250_000,
  },
  'gemini-3.5-flash': {
    proveedor: 'google', metrica: 'requests', limiteDiario: 20, etiquetaMetrica: 'requests/día (RPD)', rpm: 10, tpm: 250_000,
  },
  // Ya NO está en la cadena activa (ver nota arriba, es la que se agotó en la
  // corrida real de npm run eval), pero se deja su límite conocido para que el
  // dashboard —que une MODELOS_CONOCIDOS con lo que ya se usó en el pasado, vía
  // uso_modelo_diario— no le muestre 0 RPD (el default de "modelo desconocido")
  // a un uso histórico real de 20 RPD.
  'gemini-3.6-flash': {
    proveedor: 'google', metrica: 'requests', limiteDiario: 20, etiquetaMetrica: 'requests/día (RPD)', rpm: 10, tpm: 250_000,
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

// Selector de PROVEEDOR LLM (Groq vs Google AI Studio / Gemini).
//
// El bot corría 100% sobre Groq. Esta capa permite PROBAR los modelos de Google
// (Gemini) sin reescribir la pipeline: un env var elige el proveedor en runtime y
// el resto del código sigue pidiendo un modelo por su id de cadena (procesar.ts y
// consultas-negocio.ts llaman `crearModeloLLM(id)` en vez de `groq(id)`).
//
// La ELECCIÓN de cadena (qué ids se recorren y en qué orden) vive en
// @/lib/bot/modelos.ts —fuente de verdad, sin importar SDKs, para que tests y
// páginas de estado no arrastren los paquetes de proveedor—. Este módulo solo
// sabe INSTANCIAR el modelo del proveedor activo a partir de ese id.
//
// La política de fallback ante 429 (saltar al siguiente id de la cadena, cada uno
// con su propia cubeta de cuota) es idéntica para ambos proveedores, así que
// `esRateLimit` / `siguienteModelo` no cambian.

import { createGroq } from '@ai-sdk/groq';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { PROVEEDOR_LLM } from '@/lib/bot/modelos';

// Instancias del SDK creadas una sola vez. Cada `create*` lee su API key del env
// implícitamente: Groq → GROQ_API_KEY, Google → GOOGLE_GENERATIVE_AI_API_KEY
// (la que se genera en Google AI Studio). Instanciamos solo la del proveedor
// activo de forma perezosa para no exigir la key del otro.
let _groq: ReturnType<typeof createGroq> | null = null;
let _google: ReturnType<typeof createGoogleGenerativeAI> | null = null;

/**
 * Devuelve el `LanguageModel` del proveedor activo para el id de modelo dado.
 * `id` es un elemento de la cadena correspondiente en modelos.ts, ya en el
 * formato nativo del proveedor activo (ej. 'openai/gpt-oss-20b' para Groq,
 * 'gemini-2.5-flash' para Google).
 */
export function crearModeloLLM(id: string): LanguageModel {
  if (PROVEEDOR_LLM === 'google') {
    if (!_google) _google = createGoogleGenerativeAI();
    return _google(id);
  }
  if (!_groq) _groq = createGroq();
  return _groq(id);
}

// Selector de PROVEEDOR LLM (Groq vs Google AI Studio / Gemini).
//
// El bot corría 100% sobre Groq. Esta capa permite USAR los modelos de Google
// (Gemini) sin reescribir la pipeline: el resto del código sigue pidiendo un
// modelo por su id de cadena (procesar.ts y consultas-negocio.ts llaman
// `crearModeloLLM(id)` en vez de `groq(id)`/`google(id)`).
//
// La ELECCIÓN de cadena (qué ids se recorren y en qué orden) vive en
// @/lib/bot/modelos.ts —fuente de verdad, sin importar SDKs, para que tests y
// páginas de estado no arrastren los paquetes de proveedor—. Este módulo solo
// sabe INSTANCIAR el modelo correcto a partir de ese id.
//
// Decisión 2026-09-15: `crearModeloLLM` elige el SDK POR ID (`proveedorDeModelo`,
// modelos.ts: un id empieza con "gemini" → Google, si no → Groq) en vez de por el
// toggle global `PROVEEDOR_LLM`. Hace falta porque la cadena default (producción)
// ahora es CRUZADA — 3 modelos Groq seguidos de 3 Google como último recurso
// (ver modelos.ts) — así que una sola llamada a `crearModeloLLM` puede recibir
// ids de ambos proveedores en la misma corrida, según en qué eslabón de la
// cadena vaya. El toggle `LLM_PROVIDER=google` (cadena pura, para A/B) sigue
// funcionando igual: sus ids también empiezan con "gemini", así que caen en la
// misma rama sin necesitar el toggle acá.
//
// La política de fallback ante 429 (saltar al siguiente id de la cadena, cada uno
// con su propia cubeta de cuota) es idéntica para ambos proveedores, así que
// `esRateLimit` / `siguienteModelo` no cambian.
//
// ⚠️ Requisito operativo: si la cadena default llega a agotar los 3 modelos de
// Groq y sigue a la cola de Google, necesita `GOOGLE_GENERATIVE_AI_API_KEY`
// seteada en el entorno donde esto corre (producción, y el nightly de CI si se
// quiere ejercer el fallback ahí). Sin la key, `createGoogleGenerativeAI()` NO
// falla acá (`loadApiKey` es perezoso) — recién falla al hacer la llamada real,
// con un error que el loop de `procesar.ts`/`consultas-negocio.ts` no reconoce
// como "sin cuota" ni "modelo inexistente", así que lo trata como fallo de
// validación (reintenta el mismo modelo y se rinde sin probar los siguientes de
// la cola). Ver la nota completa en modelos.ts.

import { createGroq } from '@ai-sdk/groq';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { proveedorDeModelo } from '@/lib/bot/modelos';

// Instancias del SDK creadas una sola vez. Cada `create*` lee su API key del env
// implícitamente: Groq → GROQ_API_KEY, Google → GOOGLE_GENERATIVE_AI_API_KEY
// (la que se genera en Google AI Studio). Se instancian de forma perezosa: si
// una corrida nunca llega a necesitar el otro proveedor (caso común — Groq casi
// nunca agota los 3 modelos), no hace falta tener su key.
let _groq: ReturnType<typeof createGroq> | null = null;
let _google: ReturnType<typeof createGoogleGenerativeAI> | null = null;

/**
 * Devuelve el `LanguageModel` para el id de modelo dado, resolviendo el SDK
 * correcto por el propio id (`proveedorDeModelo`) — no por ningún toggle global.
 * `id` es un elemento de una de las cadenas en modelos.ts, ya en el formato
 * nativo de su proveedor (ej. 'openai/gpt-oss-20b' para Groq, 'gemini-3.1-flash-lite'
 * para Google).
 */
export function crearModeloLLM(id: string): LanguageModel {
  if (proveedorDeModelo(id) === 'google') {
    if (!_google) _google = createGoogleGenerativeAI();
    return _google(id);
  }
  if (!_groq) _groq = createGroq();
  return _groq(id);
}

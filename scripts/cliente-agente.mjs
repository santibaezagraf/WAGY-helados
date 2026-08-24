// Saneamiento del texto que devuelve el cliente-agente LLM de los exploratorios.
//
// POR QUÉ EXISTE: el cliente-agente corre en un modelo de razonamiento híbrido
// (qwen3.x), que emite bloques `<think>…</think>` antes de la respuesta real. En
// la corrida 32609751045 el harness NO los filtraba, así que los 5/5 escenarios
// le mandaron al bot mensajes con 1500-3000 palabras de razonamiento en inglés
// pegadas por delante del texto en español. Consecuencias: ningún escenario
// cerró con `FIN` (la comparación corría sobre el crudo, que nunca es "FIN"),
// la ventana de contexto del bot se llenó de ruido, y los transcripts dejaron de
// ser representativos de un cliente real.
//
// La causa raíz se ataca en `probar-bot.mjs` apagando el razonamiento
// (`reasoningFormat: 'hidden'`); esto es el cinturón de seguridad, porque depende
// de que Groq respete la opción y de que el modelo del día la soporte.
//
// Funciones puras (testeadas en cliente-agente.test.mjs): sin red, sin estado.

// Ningún cliente real manda una burbuja de WhatsApp más larga que esto. Si el
// mensaje limpio la supera, asumimos fuga de razonamiento (o que el modelo se
// puso a explicar en vez de actuar) y cortamos el escenario RUIDOSAMENTE, en vez
// de contaminar la conversación en silencio como pasó en la corrida 32609751045.
export const MAX_CHARS_MENSAJE_CLIENTE = 600;

const CIERRE = '</think>';

/**
 * Saca el razonamiento del texto crudo del cliente-agente y devuelve solo la
 * burbuja de WhatsApp. Devuelve '' cuando no hay mensaje real que rescatar.
 *
 * @param {unknown} crudo
 * @returns {string}
 */
export function limpiarMensajeCliente(crudo) {
  let texto = String(crudo ?? '');

  // 1. Bloques completos `<think>…</think>` (el caso normal).
  texto = texto.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // 2. Cierre huérfano: la respuesta arrancó dentro del razonamiento (sin
  //    apertura visible) y el mensaje real quedó después del último `</think>`.
  const ultimoCierre = texto.toLowerCase().lastIndexOf(CIERRE);
  if (ultimoCierre !== -1) texto = texto.slice(ultimoCierre + CIERRE.length);

  // 3. Apertura sin cierre: la generación se cortó a mitad del razonamiento
  //    (límite de tokens), así que NUNCA llegó a escribir el mensaje real. No
  //    hay nada que rescatar; mandar el razonamiento sería el bug original.
  if (/<think>/i.test(texto)) return '';

  return texto.trim();
}

/**
 * ¿El mensaje limpio es usable como turno de cliente? Mismo criterio ruidoso que
 * `esTranscripcionUtil` para Whisper: preferimos cortar el escenario con una nota
 * visible antes que alimentar basura al bot bajo prueba.
 *
 * @param {string} texto  ya pasado por limpiarMensajeCliente
 * @returns {{ ok: boolean, motivo?: string }}
 */
export function validarMensajeCliente(texto) {
  if (!texto) {
    return {
      ok: false,
      motivo:
        'el cliente-agente devolvió un mensaje vacío después de sacarle el razonamiento ' +
        '(probablemente la generación se cortó a mitad del bloque <think>: subí maxOutputTokens ' +
        'o revisá que reasoningFormat=hidden lo esté respetando el modelo).',
    };
  }
  if (texto.length > MAX_CHARS_MENSAJE_CLIENTE) {
    return {
      ok: false,
      motivo:
        `el cliente-agente devolvió ${texto.length} caracteres (tope ${MAX_CHARS_MENSAJE_CLIENTE}). ` +
        'Ningún cliente real manda eso: casi seguro es razonamiento filtrado que el limpiador no ' +
        'reconoció. Se cortó el escenario para no contaminar el transcript.',
    };
  }
  return { ok: true };
}

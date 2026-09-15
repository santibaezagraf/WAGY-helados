import { generateObject } from 'ai';
import { z } from 'zod';
import { esRateLimit } from '@/lib/bot/procesar';
import type { PedidoActivoContext } from '@/lib/bot/procesar';
import { registrarAlertaFallback, registrarUsoModelo, siguienteModelo } from '@/lib/bot/alertas';
import { MODELOS_CONSULTA } from '@/lib/bot/modelos';
import { crearModeloLLM } from '@/lib/bot/proveedor-llm';
import {
  SABORES,
  ENVIOS,
  ENTREGA,
  PAGO_TRANSFERENCIA,
  formatearPesos,
  type ListaPreciosPublica,
} from '@/lib/precios-publico';

/**
 * RESPUESTA LIBRE ACOTADA A CONSULTAS DE NEGOCIO.
 *
 * El bot es determinista: el LLM de extracción (`PedidoIASchema`) solo cambia
 * estados, TS decide las respuestas. Pero crear un estado por cada pregunta
 * posible ("¿tenés de agua o de crema?", "¿cuánto es mi total?", "¿cuánto
 * demora?") es tedioso y frágil, y hasta ahora TODAS esas preguntas se delegaban
 * a un humano —incluso las que el bot conoce de memoria— generando loops de
 * "esa no te la puedo responder" (hallazgo #1 del informe nightly).
 *
 * Este módulo agrega un paso ACOTADO: una llamada LLM aparte, alimentada SOLO
 * con un bloque de contexto curado (constantes del negocio + el pedido en curso),
 * que responde la pregunta en 1-2 frases o —si el dato NO está en el contexto—
 * devuelve `puede_responder=false` para que el flujo delegue a un humano como
 * siempre. El texto libre queda confinado a este schema chico y a este camino;
 * la extracción del pedido no se toca y la delegación a humano sigue siendo el
 * piso ante cualquier duda o falla.
 */

// La cadena de consulta (MODELOS_CONSULTA) y su política de fallback (ante un 429
// saltamos al siguiente modelo, que tiene cubeta TPD separada) viven ahora en
// @/lib/bot/modelos.ts, misma fuente de verdad que la extracción.

// Timeout defensivo: esto corre en el worker de QStash (no en el webhook), pero
// igual no queremos que una llamada colgada frene el resto del turno.
const TIMEOUT_MS = 12000;

/**
 * Schema chico y cerrado de la respuesta libre. Es lo que le da "estructura" a
 * la generación (consigna): el modelo o responde con una frase breve, o admite
 * que no sabe. No hay lugar para que se vaya de tema.
 */
export const ConsultaNegocioSchema = z.object({
  puede_responder: z
    .boolean()
    .describe('true SOLO si la respuesta está contenida en el CONTEXTO. false si el dato no está, o si la pregunta no tiene que ver con la heladería.'),
  respuesta: z
    .string()
    .nullable()
    .describe('La respuesta breve (1-2 frases) en rioplatense informal. null si puede_responder es false.'),
});

export type ConsultaNegocioResultado = z.infer<typeof ConsultaNegocioSchema>;

/**
 * Sabores vigentes: los de la lista de precios ACTIVA (configurables desde el
 * dashboard) y, si no hay lista o vino sin sabores cargados, la constante
 * `SABORES` como piso. Exportada para test y para que los dos constructores de
 * contexto resuelvan los sabores por el mismo camino.
 */
export function saboresVigentes(
  listaPrecios: ListaPreciosPublica | null,
): { agua: string[]; crema: string[] } {
  return {
    agua: listaPrecios?.saboresAgua?.length ? listaPrecios.saboresAgua : [...SABORES.agua],
    crema: listaPrecios?.saboresCrema?.length ? listaPrecios.saboresCrema : [...SABORES.crema],
  };
}

/**
 * Arma el bloque de CONTEXTO curado que ve el modelo de respuesta. Es la ÚNICA
 * fuente de verdad de la respuesta libre: todo lo que no esté acá, el modelo lo
 * trata como "no lo sé" y delega. Pura y exportada para test.
 *
 * Incluye: constantes del negocio (tipos, sabores, envíos, demora, pago), los
 * tiers de precio de la lista activa (si se pasan), y —clave para "¿cuánto es mi
 * total?"— los datos del pedido en curso del cliente, `precio_total` incluido.
 * Cierra con un bloque explícito de "lo que NO sabés" para anclar el escape hatch.
 */
export function construirContextoNegocio(
  pedidoActivo: PedidoActivoContext | null,
  listaPrecios: ListaPreciosPublica | null,
  // Cambios que el MISMO mensaje está por aplicarle al pedido (los arma
  // `construirCambiosPendientes` en procesar.ts). Sin esto, el contexto que ve la
  // respuesta acotada refleja el pedido de ANTES del merge —este bloque corre
  // antes—, y una pregunta sobre el cambio en curso ("¿me los mandan ahí?") es
  // imposible de contestar: se delegaba a un humano y la burbuja siguiente,
  // el resumen actualizado, la contestaba igual.
  cambiosPendientes: string[] = [],
): string {
  const partes: string[] = [];

  // Los sabores son configurables por lista de precios (columnas `sabores_agua`/
  // `sabores_crema` de `listas_precios`, editables desde el dashboard). Hasta la
  // corrida 34900965360 este contexto usaba SIEMPRE la constante `SABORES`: si el
  // staff cambiaba los sabores, la página /precios se actualizaba y el bot seguía
  // nombrando los viejos. La constante queda como fallback para cuando no hay lista
  // activa (o quedó sin sabores cargados).
  const { agua: saboresAgua, crema: saboresCrema } = saboresVigentes(listaPrecios);

  // QUÉ SOS: una pregunta meta ("¿qué sabés hacer?", "¿sos un bot?") no es una
  // consulta de negocio real, pero sin este bloque el contexto no tenía con qué
  // contestarla y caía en la delegación a un humano — usarla de cajón de sastre
  // para la PRIMERA pregunta de un cliente (hallazgo menor del informe 32740622175).
  partes.push('QUÉ SOS Y QUÉ PODÉS HACER (si te preguntan esto, contestalo vos, NO lo delegues):');
  partes.push('- Sos el asistente de WhatsApp de WAGY helados: tomás pedidos de helado por acá.');
  partes.push('- Armás el pedido pidiendo: cuántos y de qué tipo (agua o crema), la dirección de envío o si pasa a retirar, y la forma de pago.');
  partes.push('- También pasás precios y sabores, y le mostrás el resumen para que confirme antes de mandarlo a la cocina.');
  partes.push('- Puede cambiar o cancelar el pedido mientras no haya salido para entrega.');
  partes.push('');

  partes.push('CONOCIMIENTO DEL NEGOCIO (WAGY helados, heladería):');
  partes.push('- Vendemos DOS tipos de helado, ambos siempre disponibles: de AGUA y de CREMA.');
  partes.push('- Se venden POR UNIDAD (no por kilo, gramo, pote, porción, bola ni cucurucho).');
  // GLOSARIO: "palito" es como se le dice acá al producto. Sin esta línea, "¿qué
  // tenés de helados de palito?" era una pregunta sobre algo que el contexto ni
  // nombraba, y el modelo delegaba a un humano (corrida 34900965360: la
  // conversación se murió en el primer mensaje del cliente).
  partes.push('- Al helado también se le dice "palito", "palita", "paleta" o "bombón": son la MISMA cosa que vendemos, solo que nombrada por su formato. NO son un producto aparte ni un sabor. Si te hablan de "palitos", te están hablando de nuestros helados de agua o de crema.');
  partes.push(`- Sabores de los de agua: ${saboresAgua.join(', ')}.`);
  partes.push(`- Sabores de los de crema: ${saboresCrema.join(', ')}.`);
  // CATÁLOGO != STOCK. Esta distinción es la que faltaba: el bloque "LO QUE NO
  // SABÉS" decía "stock del día o si hay un sabor puntual disponible", y una
  // pregunta como "¿qué tenés de crema?" se lee como disponibilidad, así que el
  // escape hatch le ganaba a la regla de los sabores y el bot delegaba una lista
  // que tenía delante. Ahora se nombra el contraste de los dos lados.
  partes.push('- Las dos listas de arriba son el CATÁLOGO y lo sabés SIEMPRE. Si te preguntan qué sabores hay, cuáles son, qué tenés, qué me recomendás, o te piden que elijas/propongas uno, contestá con la lista del tipo que corresponda (o las dos si no aclararon). Eso NO es una pregunta de stock y NUNCA se delega a una persona.');
  partes.push(
    `- Envíos: GRATIS en compras de ${formatearPesos(ENVIOS.minimoGratis)} o más. Por menos de eso, se consulta el costo o el cliente pasa a retirar por el local.`,
  );
  partes.push(`- Demora estimada de entrega: ${ENTREGA.tiempoEstimado}.`);
  partes.push(
    `- Formas de pago: efectivo o transferencia (alias "${PAGO_TRANSFERENCIA.alias}", a nombre de ${PAGO_TRANSFERENCIA.titular}).`,
  );

  if (listaPrecios) {
    const bloqueTiers = (titulo: string, tiers: ListaPreciosPublica['agua']) => {
      if (!tiers.length) return;
      const linea = tiers
        .map((t) => `desde ${t.min_cantidad}: ${formatearPesos(t.precio_unitario)} c/u`)
        .join('; ');
      partes.push(`- Precios ${titulo} (según cantidad): ${linea}.`);
    };
    bloqueTiers('de agua', listaPrecios.agua);
    bloqueTiers('de crema', listaPrecios.crema);
  }

  if (pedidoActivo) {
    partes.push('');
    partes.push(`PEDIDO EN CURSO DEL CLIENTE (estado: ${pedidoActivo.estado}):`);
    if (pedidoActivo.cantidad_agua > 0) partes.push(`- Helados de agua: ${pedidoActivo.cantidad_agua}`);
    if (pedidoActivo.cantidad_crema > 0) partes.push(`- Helados de crema: ${pedidoActivo.cantidad_crema}`);
    if (pedidoActivo.observaciones) partes.push(`- Sabores/detalles: ${pedidoActivo.observaciones}`);
    if (pedidoActivo.direccion) {
      partes.push(
        pedidoActivo.direccion === 'retira'
          ? '- Entrega: pasa a retirar por el local'
          : `- Dirección de envío: ${pedidoActivo.direccion}`,
      );
    }
    if (pedidoActivo.metodo_pago) partes.push(`- Forma de pago: ${pedidoActivo.metodo_pago}`);
    partes.push(
      typeof pedidoActivo.precio_total === 'number'
        ? `- Total del pedido: ${formatearPesos(pedidoActivo.precio_total)}`
        : '- Total del pedido: a confirmar (todavía no está cerrado)',
    );
    partes.push(
      '- El cliente PUEDE modificar (cantidades, sabores, dirección, pago) o cancelar este pedido mientras no haya salido para entrega. Si pregunta si se puede cambiar/cancelar, respondele que sí y pedile el cambio.',
    );
  } else {
    partes.push('');
    partes.push(
      'PEDIDO EN CURSO DEL CLIENTE: no tiene ningún pedido activo en este momento (si pregunta cuánto sale o cuál es el total "de su pedido", contestale que no tenés ningún pedido en curso de él/ella y que te diga qué quiere pedir).',
    );
  }

  if (cambiosPendientes.length) {
    partes.push('');
    partes.push('CAMBIOS QUE EL CLIENTE PIDE EN ESTE MISMO MENSAJE (se aplican AHORA, apenas termines de responder; el pedido va a quedar así):');
    for (const cambio of cambiosPendientes) partes.push(cambio);
    partes.push(
      '- Si la pregunta es sobre estos cambios ("¿me los mandan ahí?", "¿queda así?", "¿entonces son 30?"), confirmáselo VOS: sí, ya quedan aplicados. Eso NO lo tiene que ver una persona.',
    );
  }

  partes.push('');
  partes.push('LO QUE NO SABÉS (si te preguntan esto, puede_responder=false para que lo tome una persona del equipo):');
  partes.push('- Horarios de atención exactos.');
  partes.push('- Zonas de entrega / cobertura puntual (si llegan a tal barrio o localidad).');
  partes.push('- Si un sabor puntual está AGOTADO hoy (eso es stock del día, y no lo ves). Ojo: la LISTA de sabores sí la sabés y está más arriba — enumerarla nunca es una pregunta de stock.');
  partes.push('- Promociones, descuentos o venta mayorista.');
  partes.push('- Facturación, o reclamos/problemas con un pedido ya entregado.');

  return partes.join('\n');
}

const SYSTEM_PROMPT_CONSULTA = `Sos el asistente de WhatsApp de WAGY helados (una heladería). Hablás en español rioplatense informal (usás "vos").

Te paso un CONTEXTO con TODO lo que sabés del negocio y, si existe, el pedido en curso del cliente. Tu única tarea es responder la PREGUNTA del cliente de forma BREVE y exacta, o admitir que no la sabés.

REGLAS ESTRICTAS (para no inventar ni filtrar información de más):
1. Respondé ÚNICAMENTE con información que esté LITERALMENTE en el CONTEXTO. Si el dato no está, NO lo sabés: devolvé puede_responder=false y respuesta=null.
2. NUNCA inventes horarios, zonas de cobertura, promos, stock, precios ni sabores que no figuren en el CONTEXTO.
3. Máximo 2 frases. Nada de saludos largos ni listas innecesarias. Como mucho 1 emoji.
4. Si la pregunta no tiene NADA que ver con la heladería (bromas, off-topic, sinsentidos), puede_responder=false.
5. Cuando la respuesta sirva para avanzar el pedido, cerrá reencauzando (ej: "¿cuántos querés?").
6. No confirmes ni modifiques el pedido; solo respondé la pregunta.
7. Los SABORES (de agua y de crema) SIEMPRE están en el CONTEXTO: enumerarlos es CATÁLOGO, no stock. Si preguntan qué sabores hay, cuáles son, qué tenés, si tenés tal sabor, qué recomendás, o te piden que elijas uno, respondé con la lista y NUNCA delegues. Ejemplos: "¿qué sabores de crema hay?" → listás los de crema. "¿qué palitos tenés?" → "palito" es nuestro helado, así que listás los sabores. "Elegime uno de crema" → proponés uno de la lista. Lo ÚNICO que no sabés de sabores es si uno está AGOTADO hoy.

Devolvé el objeto { puede_responder, respuesta }.`;

/**
 * Motor compartido de las respuestas libres ACOTADAS de este módulo (consulta de
 * negocio y pregunta por el tipo de helado): una llamada con schema chico,
 * temperature 0, timeout, y la misma política de fallback por 429 que la
 * extracción. NO testeada (network), como `transcribirAudio`: lo testeable son
 * los constructores de contexto y los schemas.
 *
 * FAIL-SAFE: ante cualquier error (timeout, validación, cuota agotada en toda la
 * cadena) devuelve `null` y el llamador cae a su camino determinista (delegar a
 * un humano / texto fijo). Una respuesta libre que falla nunca rompe la
 * conversación.
 */
async function generarAcotado<T>(
  etiqueta: string,
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
  telefono: string | null,
): Promise<T | null> {
  for (let idx = 0; idx < MODELOS_CONSULTA.length; idx++) {
    const modelo = MODELOS_CONSULTA[idx];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const { object, usage } = await generateObject({
        model: crearModeloLLM(modelo),
        system,
        prompt,
        schema,
        temperature: 0,
        abortSignal: controller.signal,
      });
      clearTimeout(timeout);
      // Telemetría de tokens (fail-open, no bloqueante), igual que la extracción.
      void registrarUsoModelo(modelo, 'consulta', usage, telefono);
      return object;
    } catch (error) {
      clearTimeout(timeout);
      // Solo saltamos de modelo ante 429 (cuota); cualquier otro error → fail-safe.
      if (esRateLimit(error)) {
        const fallback = siguienteModelo(idx, MODELOS_CONSULTA);
        console.warn(`⚠️ ${etiqueta}: "${modelo}" sin cuota (429). Fallback → ${fallback ?? 'ninguno'}.`);
        void registrarAlertaFallback(modelo, fallback, telefono);
        continue; // probamos el siguiente modelo de la cadena
      }
      console.warn(`⚠️ ${etiqueta} con "${modelo}" falló (se usa el camino determinista):`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  // Cadena agotada por 429: fail-safe.
  return null;
}

/**
 * Llama al modelo para responder UNA consulta de negocio con el contexto curado.
 *
 * FAIL-SAFE: si el dato no está en el contexto (o el modelo falla), devuelve
 * `{ puede_responder: false, respuesta: null }` — el llamador delega a un humano,
 * que es exactamente el comportamiento previo a esta mejora.
 */
export async function responderConsultaNegocio(
  pregunta: string,
  contexto: string,
  telefono: string | null = null,
): Promise<ConsultaNegocioResultado> {
  const noSe: ConsultaNegocioResultado = { puede_responder: false, respuesta: null };

  const object = await generarAcotado(
    'Consulta de negocio',
    SYSTEM_PROMPT_CONSULTA,
    `CONTEXTO:\n${contexto}\n\nPREGUNTA DEL CLIENTE: "${pregunta}"`,
    ConsultaNegocioSchema,
    telefono,
  );
  if (!object) return noSe;

  // Coherencia: si dijo que puede pero no trajo texto, lo tratamos como "no sé".
  if (object.puede_responder && object.respuesta && object.respuesta.trim()) {
    return { puede_responder: true, respuesta: object.respuesta.trim() };
  }
  return noSe;
}

// ─── Pregunta acotada por el TIPO de helado (agua o crema) ───────────────────
//
// Caso real: "quiero 50 helados de frutilla". El cliente dio la cantidad pero NO
// dijo si son de agua o de crema, y no se puede deducir: frutilla existe en los
// dos tipos. El modelo de extracción venía ADIVINANDO (metía los 50 en
// `cantidad_agua` y "los de agua frutilla" en observaciones), o sea escribía un
// pedido que el cliente nunca hizo.
//
// Acá el cliente no cometió un "error" con una respuesta fija: lo que conviene
// decirle depende del sabor que mencionó y de en qué tipos existe. Pero es un área
// que el bot SÍ conoce (SABORES es una constante del sistema), así que en vez de
// sumar otro texto hardcodeado le damos el mismo tratamiento que a las consultas
// de negocio: respuesta LIBRE pero ACOTADA a un contexto curado + schema chico,
// con un texto determinista como piso si el modelo falla o se va de tema.

/**
 * Schema chico y cerrado de la pregunta por el tipo: un solo campo de texto, sin
 * lugar para confirmar el pedido ni irse de tema.
 */
export const PreguntaTipoHeladoSchema = z.object({
  pregunta: z
    .string()
    .describe('La pregunta breve (1-2 frases, rioplatense informal) para que el cliente elija si los quiere de agua o de crema. Tiene que repetir la cantidad con números.'),
});

// Largo máximo aceptable de la pregunta redactada: más que esto no son 1-2 frases,
// es el modelo yéndose de tema. Cae al texto determinista.
const LARGO_MAX_PREGUNTA_TIPO = 300;

/**
 * Contexto curado de la pregunta por el tipo: la cantidad, lo que escribió el
 * cliente y los sabores reales de cada tipo. Es TODO lo que ve el modelo, así que
 * no puede inventar sabores ni hablar de otra cosa. Pura y exportada para test.
 */
export function construirContextoTipoHelado(
  cantidad: number,
  textoCliente: string,
  listaPrecios: ListaPreciosPublica | null = null,
): string {
  const { agua, crema } = saboresVigentes(listaPrecios);
  return [
    'SITUACIÓN: el cliente pidió helados pero NO dijo de qué tipo son (de agua o de crema), y no se puede deducir.',
    `- Cantidad que pidió: ${cantidad} (repetila con números).`,
    `- Lo que escribió, textual: "${textoCliente}"`,
    '',
    'CONOCIMIENTO DEL NEGOCIO (WAGY helados, heladería):',
    '- Hay DOS tipos de helado, los dos siempre disponibles: de AGUA y de CREMA. Se venden por unidad.',
    '- Al helado también se le dice "palito", "palita", "paleta" o "bombón": es la misma cosa, nombrada por su formato. NO es un sabor ni un producto aparte.',
    `- Sabores de los de agua: ${agua.join(', ')}.`,
    `- Sabores de los de crema: ${crema.join(', ')}.`,
    '- Un mismo sabor puede existir en los dos tipos; en ese caso el cliente igual tiene que elegir el tipo.',
  ].join('\n');
}

const SYSTEM_PROMPT_TIPO_HELADO = `Sos el asistente de WhatsApp de WAGY helados (una heladería). Hablás en español rioplatense informal (usás "vos").

El cliente pidió una cantidad de helados pero NO dijo si los quiere de AGUA o de CREMA. Tu ÚNICA tarea es escribir la pregunta para que elija el tipo. El mensaje se manda con dos botones ("N de agua" / "N de crema"), así que no hace falta explicarle cómo contestar.

REGLAS ESTRICTAS (para no inventar ni desviarte):
1. Máximo 2 frases. Como mucho 1 emoji. Sin saludos largos.
2. Repetí la cantidad con NÚMEROS, así el cliente ve que la tomaste bien.
3. Si mencionó un sabor, usá SOLO las listas del CONTEXTO: decile en qué tipo está. Si está en los dos, decíselo. Si no está en ninguna, avisale que ese sabor no lo tenés y nombrale algunos que sí.
4. NUNCA inventes sabores, precios, horarios, promos, demoras ni ningún dato que no esté en el CONTEXTO.
5. Cerrá preguntando si los quiere de agua o de crema. NO pidas dirección ni forma de pago, NO confirmes ni armes el pedido, NO des precios.
6. El cliente no se equivocó en nada: no lo corrijas ni te disculpes, solo preguntá.

Devolvé el objeto { pregunta }.`;

/**
 * Redacta la pregunta por el tipo de helado. Devuelve el texto, o `null` si el
 * modelo falló o se fue de los límites (largo, o no repitió la cantidad): en ese
 * caso el llamador manda el texto determinista.
 */
export async function redactarPreguntaTipoHelado(
  cantidad: number,
  textoCliente: string,
  telefono: string | null = null,
  listaPrecios: ListaPreciosPublica | null = null,
): Promise<string | null> {
  const object = await generarAcotado(
    'Pregunta de tipo de helado',
    SYSTEM_PROMPT_TIPO_HELADO,
    construirContextoTipoHelado(cantidad, textoCliente, listaPrecios),
    PreguntaTipoHeladoSchema,
    telefono,
  );

  const texto = object?.pregunta?.trim();
  if (!texto) return null;
  // Guardas de que la redacción respetó el encargue: breve y con la cantidad que
  // le pasamos (si no la repite, ignoró el contexto). Cualquiera que falle → texto
  // determinista, que siempre cumple las dos.
  if (texto.length > LARGO_MAX_PREGUNTA_TIPO) {
    console.warn(`⚠️ Pregunta de tipo de helado demasiado larga (${texto.length} chars). Uso el texto fijo.`);
    return null;
  }
  if (!texto.includes(String(cantidad))) {
    console.warn('⚠️ Pregunta de tipo de helado sin la cantidad. Uso el texto fijo.');
    return null;
  }
  return texto;
}

// ─── Textos de delegación (rotables) ─────────────────────────────────────────
// Cuando el bot NO puede responder y delega a un humano, rota entre variantes
// para no repetir el MISMO texto palabra por palabra si el cliente insiste
// (hallazgo #4 del informe). `yaAvisado` cambia el mensaje a un "ya avisé" cuando
// la conversación ya tenía el flag requiere_atencion levantado (delegación
// reciente), en vez de sonar como si recién se enterara.

const DELEGACIONES = [
  'Buena pregunta 🙌 Esa te la responde mejor una persona del equipo, en un ratito te escriben 🙏',
  'Esa la dejo para alguien del equipo, que te va a poder ayudar mejor 🙏 En un momento te contestan.',
  'Uh, esa no la manejo yo 😅 Ya le avisé a una persona del equipo para que te responda 🙏',
];

// Variantes para cuando la conversación YA tenía requiere_atencion levantado
// (delegación reciente): suenan a "ya avisé", no a recién enterarse. También
// rotables — si el cliente insiste varias veces con el flag ya activo, el texto
// no debe repetirse palabra por palabra (spec punto 10; hallazgo del informe
// nightly, donde se repitió idéntico 5 veces seguidas).
const DELEGACIONES_YA_AVISADO = [
  'Tranqui, ya le pasé tu consulta a una persona del equipo 🙏 En un ratito te responden.',
  'Sí, ya quedó avisada una persona del equipo para que te conteste 🙌 Aguantá un toque.',
  'Ya está en manos de alguien del equipo, en breve te escriben 🙏',
];

/**
 * Elige el texto de delegación a humano. Pura y exportada para test.
 * - `yaAvisado=true` (ya había requiere_atencion) → rota entre `DELEGACIONES_YA_AVISADO`.
 * - Si no, rota entre `DELEGACIONES`.
 * En ambos casos rota según un seed determinista, para no repetir palabra por
 * palabra cuando el cliente insiste con la misma consulta (spec punto 10).
 */
export function elegirTextoDelegacion(seed = 0, yaAvisado = false): string {
  const variantes = yaAvisado ? DELEGACIONES_YA_AVISADO : DELEGACIONES;
  return variantes[Math.abs(seed) % variantes.length];
}

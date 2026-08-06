import { generateObject } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import { esRateLimit } from '@/lib/bot/procesar';
import type { PedidoActivoContext } from '@/lib/bot/procesar';
import { registrarAlertaFallback, siguienteModelo } from '@/lib/bot/alertas';
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

const groq = createGroq();

// Misma cadena y misma política de fallback que la extracción: ante un 429
// (cuota TPD agotada) saltamos al siguiente modelo, que tiene cubeta separada.
const MODELOS_CONSULTA = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct',
] as const;

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
): string {
  const partes: string[] = [];

  partes.push('CONOCIMIENTO DEL NEGOCIO (WAGY helados, heladería):');
  partes.push('- Vendemos DOS tipos de helado, ambos siempre disponibles: de AGUA y de CREMA.');
  partes.push('- Se venden POR UNIDAD (no por kilo, gramo, pote, porción, bola ni cucurucho).');
  partes.push(`- Sabores de los de agua: ${SABORES.agua.join(', ')}.`);
  partes.push(`- Sabores de los de crema: ${SABORES.crema.join(', ')}.`);
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

  partes.push('');
  partes.push('LO QUE NO SABÉS (si te preguntan esto, puede_responder=false para que lo tome una persona del equipo):');
  partes.push('- Horarios de atención exactos.');
  partes.push('- Zonas de entrega / cobertura puntual (si llegan a tal barrio o localidad).');
  partes.push('- Stock del día o si hay un sabor puntual disponible ahora mismo.');
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

Devolvé el objeto { puede_responder, respuesta }.`;

/**
 * Llama al modelo para responder UNA consulta de negocio con el contexto curado.
 * NO testeada (network), como `transcribirAudio`: la lógica testeable vive en
 * `construirContextoNegocio` y en el schema.
 *
 * FAIL-SAFE: ante cualquier error (timeout, validación, cuota agotada en toda la
 * cadena) devuelve `{ puede_responder: false, respuesta: null }` — el llamador
 * delega a un humano, que es exactamente el comportamiento previo. Una respuesta
 * libre que falla nunca rompe la conversación.
 */
export async function responderConsultaNegocio(
  pregunta: string,
  contexto: string,
  telefono: string | null = null,
): Promise<ConsultaNegocioResultado> {
  const noSe: ConsultaNegocioResultado = { puede_responder: false, respuesta: null };

  for (let idx = 0; idx < MODELOS_CONSULTA.length; idx++) {
    const modelo = MODELOS_CONSULTA[idx];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const { object } = await generateObject({
        model: groq(modelo),
        system: SYSTEM_PROMPT_CONSULTA,
        prompt: `CONTEXTO:\n${contexto}\n\nPREGUNTA DEL CLIENTE: "${pregunta}"`,
        schema: ConsultaNegocioSchema,
        temperature: 0,
        abortSignal: controller.signal,
      });
      clearTimeout(timeout);
      // Coherencia: si dijo que puede pero no trajo texto, lo tratamos como "no sé".
      if (object.puede_responder && object.respuesta && object.respuesta.trim()) {
        return { puede_responder: true, respuesta: object.respuesta.trim() };
      }
      return noSe;
    } catch (error) {
      clearTimeout(timeout);
      // Solo saltamos de modelo ante 429 (cuota); cualquier otro error → fail-safe.
      if (esRateLimit(error)) {
        const fallback = siguienteModelo(idx, MODELOS_CONSULTA);
        console.warn(`⚠️ Consulta de negocio: "${modelo}" sin cuota (429). Fallback → ${fallback ?? 'ninguno'}.`);
        void registrarAlertaFallback(modelo, fallback, telefono);
        continue; // probamos el siguiente modelo de la cadena
      }
      console.warn(`⚠️ Consulta de negocio con "${modelo}" falló (se delega a humano):`, error instanceof Error ? error.message : error);
      return noSe;
    }
  }

  // Cadena agotada por 429: fail-safe → delegar.
  return noSe;
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

const DELEGACION_YA_AVISADO =
  'Tranqui, ya le pasé tu consulta a una persona del equipo 🙏 En un ratito te responden.';

/**
 * Elige el texto de delegación a humano. Pura y exportada para test.
 * - `yaAvisado=true` (ya había requiere_atencion) → variante "ya avisé".
 * - Si no, rota entre `DELEGACIONES` según un seed determinista.
 */
export function elegirTextoDelegacion(seed = 0, yaAvisado = false): string {
  if (yaAvisado) return DELEGACION_YA_AVISADO;
  return DELEGACIONES[Math.abs(seed) % DELEGACIONES.length];
}

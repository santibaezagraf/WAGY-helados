// Etiquetas de día para los separadores del chat (estilo WhatsApp).
// Pura y testeable: la comparación se hace por fecha en la zona horaria de Argentina
// (año-mes-día AR, vía `zona-horaria`), no por diff en ms — así 23:59 y 00:01 son
// días distintos aunque estén a 2 minutos, y el corte de día no depende del huso del
// runtime (servidor UTC o navegador).

import { claveDiaAR, partesAR, sumarDiasAR } from './zona-horaria'

/** true si los dos ISO son del mismo día AR. Ambos deben ser fechas válidas. */
export function mismoDia(isoA: string, isoB: string): boolean {
  return claveDiaAR(new Date(isoA)) === claveDiaAR(new Date(isoB))
}

// Meses en español (rioplatense), sin acentos raros — el separador se lee "19
// de julio" o, si el año no es el actual, "19 de julio de 2024".
const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

/**
 * Etiqueta del día para un separador de chat:
 *  - "Hoy" si es hoy
 *  - "Ayer" si es ayer
 *  - "19 de julio" si es este año
 *  - "19 de julio de 2024" si es otro año
 * `ahora` es inyectable para test; en producción se pasa `new Date()`.
 * Todo se decide en fecha de Argentina.
 */
export function etiquetaFecha(iso: string, ahora: Date = new Date()): string {
  const d = new Date(iso)
  const claveMsj = claveDiaAR(d)
  const claveHoy = claveDiaAR(ahora)

  if (claveMsj === claveHoy) return 'Hoy'

  if (claveMsj === claveDiaAR(sumarDiasAR(ahora, -1))) return 'Ayer'

  const p = partesAR(d)
  return p.anio === partesAR(ahora).anio
    ? `${p.dia} de ${MESES_ES[p.mes - 1]}`
    : `${p.dia} de ${MESES_ES[p.mes - 1]} de ${p.anio}`
}

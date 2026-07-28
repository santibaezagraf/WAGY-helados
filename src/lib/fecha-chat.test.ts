import { describe, it, expect } from 'vitest';
import { etiquetaFecha, mismoDia } from './fecha-chat';

// Los tests usan instantes UTC explícitos y razonan en hora de Argentina (UTC-3).
// Mediodía AR = 15:00 UTC; para forzar una hora AR concreta uso `Z` sumando 3h.
// Ancla fija: 15 de julio 2026, 12:00 AR.
const AHORA = new Date('2026-07-15T15:00:00Z');

/** ISO (UTC) para una fecha/hora de pared de Argentina (UTC-3). */
function isoAR(y: number, m: number, d: number, h = 12, min = 0): string {
  return new Date(Date.UTC(y, m - 1, d, h + 3, min)).toISOString();
}

describe('etiquetaFecha', () => {
  it('mismo día AR → "Hoy"', () => {
    expect(etiquetaFecha(isoAR(2026, 7, 15), AHORA)).toBe('Hoy');
    // 23:59 AR del mismo día también es Hoy (misma clave de día AR).
    expect(etiquetaFecha(isoAR(2026, 7, 15, 23, 59), AHORA)).toBe('Hoy');
  });

  it('un día atrás → "Ayer"', () => {
    expect(etiquetaFecha(isoAR(2026, 7, 14), AHORA)).toBe('Ayer');
  });

  it('mismo año, más de 2 días atrás → "N de mes"', () => {
    expect(etiquetaFecha(isoAR(2026, 7, 10), AHORA)).toBe('10 de julio');
    expect(etiquetaFecha(isoAR(2026, 1, 1), AHORA)).toBe('1 de enero');
  });

  it('otro año → "N de mes de YYYY"', () => {
    expect(etiquetaFecha(isoAR(2024, 12, 31), AHORA)).toBe('31 de diciembre de 2024');
  });

  it('cruce de año atrás cuenta como año distinto (no "Ayer")', () => {
    const primerDiaAño = new Date('2026-01-01T15:00:00Z'); // 12:00 AR del 01/01/2026
    // 31/12/2025 desde el 01/01/2026 → "Ayer".
    expect(etiquetaFecha(isoAR(2025, 12, 31), primerDiaAño)).toBe('Ayer');
    // Pero un día antes de ese (30/12/2025) sí muestra el año.
    expect(etiquetaFecha(isoAR(2025, 12, 30), primerDiaAño)).toBe('30 de diciembre de 2025');
  });

  it('la franja 21:00–23:59 AR sigue siendo el mismo día AR (no el siguiente UTC)', () => {
    // 22:00 AR del 15/07 = 01:00 UTC del 16/07 — no debe leerse como "16".
    expect(etiquetaFecha(isoAR(2026, 7, 15, 22, 0), AHORA)).toBe('Hoy');
  });
});

describe('mismoDia', () => {
  it('true si ambos ISO caen en el mismo día AR', () => {
    expect(mismoDia(isoAR(2026, 7, 15, 0, 1), isoAR(2026, 7, 15, 23, 59))).toBe(true);
  });

  it('false para días distintos, aunque estén a minutos de diferencia', () => {
    expect(mismoDia(isoAR(2026, 7, 15, 23, 59), isoAR(2026, 7, 16, 0, 1))).toBe(false);
  });
});

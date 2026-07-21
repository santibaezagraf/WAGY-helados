import { describe, it, expect } from 'vitest';
import { superaRateLimit, calcularDesdeRateLimitMs, RATE_LIMIT_MAX, RATE_LIMIT_VENTANA_MS } from './rate-limit';

describe('superaRateLimit', () => {
  it('por debajo del tope no rate-limitea', () => {
    expect(superaRateLimit(0)).toBe(false);
    expect(superaRateLimit(RATE_LIMIT_MAX - 1)).toBe(false);
  });
  it('al alcanzar el tope ya frena (contamos ANTES de insertar el mensaje actual)', () => {
    expect(superaRateLimit(RATE_LIMIT_MAX)).toBe(true);
  });
  it('por encima del tope frena', () => {
    expect(superaRateLimit(RATE_LIMIT_MAX + 50)).toBe(true);
  });
  it('respeta un límite custom', () => {
    expect(superaRateLimit(5, 10)).toBe(false);
    expect(superaRateLimit(10, 10)).toBe(true);
  });
});

describe('calcularDesdeRateLimitMs', () => {
  const AHORA = 1_000_000_000_000; // instante fijo (evitamos Date.now real en el test)

  it('sin reset devuelve el inicio de la ventana deslizante', () => {
    expect(calcularDesdeRateLimitMs(AHORA, null)).toBe(AHORA - RATE_LIMIT_VENTANA_MS);
  });

  it('un reset RECIENTE (posterior al inicio de la ventana) manda: cuenta desde el reset', () => {
    const resetAt = new Date(AHORA - 60_000).toISOString(); // hace 1 min
    expect(calcularDesdeRateLimitMs(AHORA, resetAt)).toBe(AHORA - 60_000);
  });

  it('un reset VIEJO (anterior al inicio de la ventana) se ignora: gana la ventana', () => {
    const resetAt = new Date(AHORA - 3 * RATE_LIMIT_VENTANA_MS).toISOString();
    expect(calcularDesdeRateLimitMs(AHORA, resetAt)).toBe(AHORA - RATE_LIMIT_VENTANA_MS);
  });

  it('un reset justo AHORA hace que el conteo arranque de cero (desde ahora)', () => {
    const resetAt = new Date(AHORA).toISOString();
    expect(calcularDesdeRateLimitMs(AHORA, resetAt)).toBe(AHORA);
  });
});

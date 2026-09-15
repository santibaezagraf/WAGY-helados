import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extraerIdsDeModelo, proveedorDe } from './verificar-modelos.mjs';

// El parser es lo único testeable sin red del guard de modelos: si deja de
// encontrar los ids, el chequeo pasaría "verificando" un conjunto vacío — el peor
// modo de falla posible para un guard. El script además sale con error si no
// encuentra ninguno; acá fijamos que sobre el fuente REAL sí los encuentra.

describe('extraerIdsDeModelo', () => {
  it('saca los ids con forma org/modelo y los de gemini', () => {
    const fuente = `
      const EXTRACCION_GROQ = [
        'openai/gpt-oss-20b',
        'openai/gpt-oss-120b',
        'qwen/qwen3.8-27b',
      ] as const;
      const EXTRACCION_GOOGLE = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'] as const;
    `;
    expect(extraerIdsDeModelo(fuente).sort()).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
    ]);
  });

  it('deduplica (los ids se repiten en la tabla de límites)', () => {
    const fuente = `['openai/gpt-oss-20b'] ... { 'openai/gpt-oss-20b': { limiteDiario: 1 } }`;
    expect(extraerIdsDeModelo(fuente)).toEqual(['openai/gpt-oss-20b']);
  });

  it('no confunde rutas de import ni URLs con ids de modelo', () => {
    const fuente = `
      import { x } from '@/lib/bot/alertas';
      const URL = 'https://api.groq.com/openai/v1/models';
      const doc = "aistudio.google.com/rate-limit";
    `;
    // '@/lib/bot/alertas' no matchea porque empieza con '@' (el patrón exige
    // que el primer carácter sea alfanumérico).
    expect(extraerIdsDeModelo(fuente)).not.toContain('@/lib/bot/alertas');
    // Una URL completa tampoco: el patrón no admite ':' ni '//'.
    expect(extraerIdsDeModelo(fuente).some((id) => id.includes('api.groq.com'))).toBe(false);
  });

  it('encuentra los ids en el fuente REAL de modelos.ts', () => {
    // Guard del guard: si alguien reestructura modelos.ts y el parser deja de
    // encontrar ids, este test falla antes de que el chequeo pase en vacío.
    const ids = extraerIdsDeModelo(readFileSync('src/lib/bot/modelos.ts', 'utf8'));
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids).toContain('openai/gpt-oss-20b');
  });
});

describe('proveedorDe', () => {
  it('separa gemini de groq igual que proveedorDeModelo', () => {
    expect(proveedorDe('gemini-3.1-flash-lite')).toBe('google');
    expect(proveedorDe('openai/gpt-oss-20b')).toBe('groq');
    expect(proveedorDe('qwen/qwen3.8-27b')).toBe('groq');
  });
});

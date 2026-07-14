import { describe, it, expect } from 'vitest';
import {
  debeSilenciarBotPorOperador,
  VENTANA_MENSAJE_OPERADOR_MS,
} from './atencion-humana';

// Tiempos relativos a un "ahora" fijo para que los casos sean deterministas.
const AHORA = new Date('2026-07-13T12:00:00Z').getTime();
const haceMs = (ms: number) => new Date(AHORA - ms).toISOString();
const HORA = 60 * 60 * 1000;

describe('debeSilenciarBotPorOperador (gate por mensajes de la toma humana)', () => {
  it('sin mensaje de operador → el bot responde normal', () => {
    expect(debeSilenciarBotPorOperador(null, null, AHORA)).toBe(false);
  });

  it('operador habló hace 2h y no hay fila de atencion_humana → silenciar (red de seguridad: falló la activación)', () => {
    expect(debeSilenciarBotPorOperador(haceMs(2 * HORA), null, AHORA)).toBe(true);
  });

  it('operador habló hace más de la ventana (7h) → el bot responde', () => {
    expect(debeSilenciarBotPorOperador(haceMs(7 * HORA), null, AHORA)).toBe(false);
  });

  it('justo fuera de la ventana → responde; justo adentro → silencia', () => {
    expect(
      debeSilenciarBotPorOperador(haceMs(VENTANA_MENSAJE_OPERADOR_MS + 1), null, AHORA),
    ).toBe(false);
    expect(
      debeSilenciarBotPorOperador(haceMs(VENTANA_MENSAJE_OPERADOR_MS - 1), null, AHORA),
    ).toBe(true);
  });

  it('"Devolver al bot" DESPUÉS del último mensaje del operador → la devolución explícita gana, el bot responde', () => {
    const atencion = { activa: false, updated_at: haceMs(1 * HORA) };
    expect(debeSilenciarBotPorOperador(haceMs(2 * HORA), atencion, AHORA)).toBe(false);
  });

  it('fila con activa=false pero ANTERIOR al mensaje del operador → silenciar (la devolución quedó vieja)', () => {
    const atencion = { activa: false, updated_at: haceMs(3 * HORA) };
    expect(debeSilenciarBotPorOperador(haceMs(2 * HORA), atencion, AHORA)).toBe(true);
  });

  it('fila con activa=true (aunque la vigencia la maneje atencionHumanaActiva) → silenciar', () => {
    const atencion = { activa: true, updated_at: haceMs(2 * HORA) };
    expect(debeSilenciarBotPorOperador(haceMs(2 * HORA), atencion, AHORA)).toBe(true);
  });
});

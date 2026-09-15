import { describe, it, expect } from 'vitest';
import { notaDeFalloExtraccion, estimarCorrida } from './probar-bot.mjs';

// Esta nota es lo que impide que el juez vuelva a leer un "no te entendí" por
// falta de cuota como una regresión del bot (corrida 34928105031).
describe('notaDeFalloExtraccion', () => {
  it('no anota nada cuando el turno sí es evaluable', () => {
    expect(notaDeFalloExtraccion({ ok: true }, 1)).toBeNull();
    expect(notaDeFalloExtraccion(undefined, 1)).toBeNull();
  });

  it('marca NO EVALUABLE y culpa a la infraestructura ante cuota o modelo muerto', () => {
    const cuota = notaDeFalloExtraccion({ falloExtraccion: 'sin_cuota' }, 3);
    expect(cuota).toContain('Turno 3');
    expect(cuota).toContain('NO EVALUABLE');
    expect(cuota).toMatch(/NO del bot/);

    const muerto = notaDeFalloExtraccion({ falloExtraccion: 'modelo_inexistente' }, 2);
    expect(muerto).toContain('NO EVALUABLE');
    expect(muerto).toContain('verificar-modelos');
  });

  it('un fallo de validación SÍ se atribuye al bot', () => {
    const nota = notaDeFalloExtraccion({ falloExtraccion: 'validacion' }, 1);
    expect(nota).not.toContain('NO EVALUABLE');
    expect(nota).toMatch(/SÍ es un fallo del bot/);
  });
});

// La estimación se imprime ANTES de arrancar para poder decidir si conviene
// correr la suite entera hoy: una corrida completa se come ~92% del TPD de un
// modelo del free-tier.
describe('estimarCorrida', () => {
  it('no cuenta los clicks de botón (se resuelven inline, 0 tokens)', () => {
    const esc = [{ tipo: 'guionado', turnos: [{ texto: 'a' }, { boton: 'confirmar_borrador' }, { texto: 'b' }] }];
    expect(estimarCorrida(esc, 0).llamadas).toBe(2);
  });

  it('cuenta dos llamadas por turno exploratorio (cliente-agente + bot)', () => {
    const esc = [{ tipo: 'exploratorio' }];
    expect(estimarCorrida(esc, 0, 4093, 200000, 6).llamadas).toBe(12);
  });

  it('traduce llamadas a tokens, % del TPD y minutos', () => {
    const esc = [{ tipo: 'guionado', turnos: [{ texto: 'a' }, { texto: 'b' }] }];
    const e = estimarCorrida(esc, 31000, 4000, 200000);
    expect(e.tokens).toBe(8000);
    expect(e.porcentajeTPD).toBe(4);
    expect(e.minutos).toBe(2);
  });

  it('una suite vacía no estima nada', () => {
    expect(estimarCorrida([], 31000)).toMatchObject({ llamadas: 0, tokens: 0, minutos: 0 });
  });
});

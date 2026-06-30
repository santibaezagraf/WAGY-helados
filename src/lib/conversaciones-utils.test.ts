import { describe, it, expect } from 'vitest';
import { construirConversaciones } from './conversaciones-utils';

describe('construirConversaciones', () => {
  it('deduplica preservando el orden de recencia (primera aparición gana)', () => {
    const filas = [
      { telefono: '5491111' }, // más reciente
      { telefono: '5492222' },
      { telefono: '5491111' }, // repetido, más viejo → se ignora
      { telefono: '5493333' },
    ];
    expect(construirConversaciones(filas, []).map((c) => c.telefono)).toEqual([
      '5491111',
      '5492222',
      '5493333',
    ]);
  });

  it('marca requiereAtencion según el set de pendientes', () => {
    const filas = [{ telefono: '5491111' }, { telefono: '5492222' }];
    expect(construirConversaciones(filas, ['5492222'])).toEqual([
      { telefono: '5491111', requiereAtencion: false },
      { telefono: '5492222', requiereAtencion: true },
    ]);
  });

  it('ignora filas sin teléfono (null)', () => {
    const filas = [{ telefono: null }, { telefono: '5491111' }, { telefono: null }];
    expect(construirConversaciones(filas, [])).toEqual([
      { telefono: '5491111', requiereAtencion: false },
    ]);
  });

  it('un pendiente repetido se marca una sola vez (en su aparición más reciente)', () => {
    const filas = [
      { telefono: '5491111' },
      { telefono: '5491111' },
    ];
    const out = construirConversaciones(filas, ['5491111']);
    expect(out).toEqual([{ telefono: '5491111', requiereAtencion: true }]);
  });

  it('un pendiente sin actividad reciente no aparece en la lista', () => {
    // El badge de la tabla puede marcar un teléfono que no esté entre las filas
    // recientes; la lista del header solo incluye los que tienen actividad.
    expect(construirConversaciones([], ['5499999'])).toEqual([]);
  });

  it('lista vacía → resultado vacío', () => {
    expect(construirConversaciones([], [])).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { siguienteModelo } from './alertas';

// Misma cadena que MODELOS_EXTRACCION en procesar.ts (no la importamos para no
// arrastrar el cliente service-role de ese módulo; el contrato es el orden).
const CADENA = ['a', 'b', 'c'] as const;

describe('siguienteModelo', () => {
  it('devuelve el siguiente de la cadena cuando se agota uno intermedio', () => {
    expect(siguienteModelo(0, CADENA)).toBe('b');
    expect(siguienteModelo(1, CADENA)).toBe('c');
  });

  it('devuelve null cuando se agota el ÚLTIMO (cadena agotada)', () => {
    expect(siguienteModelo(2, CADENA)).toBeNull();
  });

  it('devuelve null si el índice queda fuera de rango', () => {
    expect(siguienteModelo(5, CADENA)).toBeNull();
  });
});

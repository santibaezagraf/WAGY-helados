import { describe, it, expect } from 'vitest';
import {
  limpiarMensajeCliente,
  validarMensajeCliente,
  MAX_CHARS_MENSAJE_CLIENTE,
} from './cliente-agente.mjs';

describe('limpiarMensajeCliente', () => {
  it('saca un bloque <think> completo y deja la burbuja real', () => {
    const crudo = '<think>The user wants ice cream. I should ask...</think>\n\nhola, 20 de agua';
    expect(limpiarMensajeCliente(crudo)).toBe('hola, 20 de agua');
  });

  it('saca varios bloques <think> y respeta mayúsculas/minúsculas del tag', () => {
    const crudo = '<think>uno</think>che <THINK>dos</THINK>, 20 de crema';
    expect(limpiarMensajeCliente(crudo)).toBe('che , 20 de crema');
  });

  it('con un cierre huérfano se queda con lo que viene después (caso real corrida 32609751045)', () => {
    // El transcript real arrancaba dentro del razonamiento, sin <think> visible,
    // y el mensaje en español quedaba después del </think>.
    const crudo = 'The user is being off-topic, so I should\n</think>\n\nche, hoy';
    expect(limpiarMensajeCliente(crudo)).toBe('che, hoy');
  });

  it('con varios cierres huérfanos usa el último', () => {
    expect(limpiarMensajeCliente('a</think>b</think>hola')).toBe('hola');
  });

  it('devuelve vacío si hay apertura sin cierre (generación cortada a mitad del razonamiento)', () => {
    const crudo = '<think>The user wants me to keep reasoning but I ran out of tok';
    expect(limpiarMensajeCliente(crudo)).toBe('');
  });

  it('deja intacto (trim aparte) un mensaje limpio', () => {
    expect(limpiarMensajeCliente('  dale, mandalo a Mitre 950  ')).toBe('dale, mandalo a Mitre 950');
  });

  it('no rompe con null/undefined/vacío', () => {
    expect(limpiarMensajeCliente(null)).toBe('');
    expect(limpiarMensajeCliente(undefined)).toBe('');
    expect(limpiarMensajeCliente('')).toBe('');
  });

  it('deja pasar FIN para que el llamador corte la conversación', () => {
    expect(limpiarMensajeCliente('<think>objetivo cumplido</think>\nFIN')).toBe('FIN');
  });
});

describe('validarMensajeCliente', () => {
  it('acepta una burbuja normal', () => {
    expect(validarMensajeCliente('hola, 20 de agua').ok).toBe(true);
  });

  it('rechaza el vacío con un motivo accionable', () => {
    const r = validarMensajeCliente('');
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/vacío/);
  });

  it('rechaza un mensaje más largo que el tope (fuga de razonamiento no reconocida)', () => {
    const r = validarMensajeCliente('a'.repeat(MAX_CHARS_MENSAJE_CLIENTE + 1));
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/caracteres/);
  });

  it('acepta exactamente el tope', () => {
    expect(validarMensajeCliente('a'.repeat(MAX_CHARS_MENSAJE_CLIENTE)).ok).toBe(true);
  });
});

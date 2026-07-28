import { describe, it, expect } from 'vitest';
import { construirConversaciones, armarPreviewMensaje, marcaPendiente } from './conversaciones-utils';

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

describe('armarPreviewMensaje', () => {
  it('texto de cliente → el texto tal cual', () => {
    expect(armarPreviewMensaje({ tipo: 'text', texto: 'quiero 10 de agua', rol: 'cliente' }))
      .toBe('quiero 10 de agua');
  });

  it('saliente (bot/operador) lleva prefijo "Vos:"', () => {
    expect(armarPreviewMensaje({ tipo: 'text', texto: 'listo, confirmás?', rol: 'bot' }))
      .toBe('Vos: listo, confirmás?');
    expect(armarPreviewMensaje({ tipo: 'text', texto: 'te llamo', rol: 'operador' }))
      .toBe('Vos: te llamo');
  });

  it('media → etiqueta del tipo, con caption si hay', () => {
    expect(armarPreviewMensaje({ tipo: 'image', rol: 'cliente' })).toBe('Foto');
    expect(armarPreviewMensaje({ tipo: 'location', rol: 'cliente' })).toBe('Ubicación');
    expect(armarPreviewMensaje({ tipo: 'image', media_caption: 'mi casa', rol: 'cliente' }))
      .toBe('Foto: mi casa');
  });

  it('texto vacío → "(sin texto)"', () => {
    expect(armarPreviewMensaje({ tipo: 'text', texto: '   ', rol: 'cliente' })).toBe('(sin texto)');
  });

  it('recorta con elipsis cuando supera el máximo', () => {
    const largo = 'a'.repeat(80);
    const out = armarPreviewMensaje({ tipo: 'text', texto: largo, rol: 'cliente' }, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('tipo desconocido cae en "Adjunto"', () => {
    expect(armarPreviewMensaje({ tipo: 'contacts', rol: 'cliente' })).toBe('Adjunto');
  });
});

describe('marcaPendiente', () => {
  it('mensaje del bot/operador → nunca es pendiente', () => {
    expect(marcaPendiente({ rol: 'bot', tipo: 'text', procesado: true })).toBe(false);
    expect(marcaPendiente({ rol: 'operador', tipo: 'text', procesado: true })).toBe(false);
  });

  it('media/ubicación de cliente → pendiente (aunque procesado sea false)', () => {
    expect(marcaPendiente({ rol: 'cliente', tipo: 'image', procesado: false })).toBe(true);
    expect(marcaPendiente({ rol: 'cliente', tipo: 'audio' })).toBe(true);
    expect(marcaPendiente({ rol: 'cliente', tipo: 'location' })).toBe(true);
  });

  it('texto de cliente con procesado=true (toma humana / rate-limit) → pendiente', () => {
    expect(marcaPendiente({ rol: 'cliente', tipo: 'text', procesado: true })).toBe(true);
  });

  it('texto normal de cliente (lo procesa el bot) → NO pendiente', () => {
    expect(marcaPendiente({ rol: 'cliente', tipo: 'text', procesado: false })).toBe(false);
  });
});

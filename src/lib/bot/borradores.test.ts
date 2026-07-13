import { describe, it, expect } from 'vitest';
import {
  decidirAccionBorrador,
  esBorradorCompleto,
  AUTO_RECHAZO_HORAS,
  AVISO_CANCELACION_HORAS,
} from './borradores';

const MIN = 60 * 1000;
const HORA = 60 * MIN;

// Caso base: borrador completo, joven, sin recordatorio, cliente callado,
// nada en vuelo. Cada test pisa lo que le importa.
function params(extra: Partial<Parameters<typeof decidirAccionBorrador>[0]> = {}) {
  return {
    msDesdeCreacion: 30 * MIN,
    esCompleto: true,
    recordatorioEnviado: false,
    clienteActivoReciente: false,
    hayMensajesEnVuelo: false,
    ...extra,
  };
}

describe('decidirAccionBorrador', () => {
  it('borrador completo, callado y sin recordatorio previo → recordar', () => {
    expect(decidirAccionBorrador(params())).toEqual({ accion: 'recordar' });
  });

  it('cliente activo hace poco → nada (todavía está conversando)', () => {
    expect(decidirAccionBorrador(params({ clienteActivoReciente: true })))
      .toEqual({ accion: 'nada' });
  });

  it('recordatorio ya enviado → nada (es one-shot)', () => {
    expect(decidirAccionBorrador(params({ recordatorioEnviado: true })))
      .toEqual({ accion: 'nada' });
  });

  it('borrador parcial (incompleto) nunca recibe recordatorio', () => {
    expect(decidirAccionBorrador(params({ esCompleto: false })))
      .toEqual({ accion: 'nada' });
  });

  it('mensajes sin procesar en vuelo → nada, incluso si está vencido', () => {
    expect(decidirAccionBorrador(params({ hayMensajesEnVuelo: true })))
      .toEqual({ accion: 'nada' });
    expect(decidirAccionBorrador(params({ hayMensajesEnVuelo: true, msDesdeCreacion: 10 * HORA })))
      .toEqual({ accion: 'nada' });
  });

  it('pasadas las horas de auto-rechazo → rechazar avisando al cliente', () => {
    expect(decidirAccionBorrador(params({ msDesdeCreacion: (AUTO_RECHAZO_HORAS + 1) * HORA })))
      .toEqual({ accion: 'rechazar', avisarCliente: true });
  });

  it('el umbral de rechazo es inclusivo (exactamente 6h → rechazar)', () => {
    expect(decidirAccionBorrador(params({ msDesdeCreacion: AUTO_RECHAZO_HORAS * HORA })))
      .toEqual({ accion: 'rechazar', avisarCliente: true });
  });

  it('justo antes del umbral todavía puede recordar', () => {
    expect(decidirAccionBorrador(params({ msDesdeCreacion: AUTO_RECHAZO_HORAS * HORA - 1 })))
      .toEqual({ accion: 'recordar' });
  });

  it('zombie más viejo que la ventana de aviso → rechaza sin escribirle', () => {
    expect(decidirAccionBorrador(params({ msDesdeCreacion: (AVISO_CANCELACION_HORAS + 1) * HORA })))
      .toEqual({ accion: 'rechazar', avisarCliente: false });
  });

  it('los parciales vencidos también se rechazan (limpieza de abandonados)', () => {
    expect(decidirAccionBorrador(params({ esCompleto: false, msDesdeCreacion: 7 * HORA })))
      .toEqual({ accion: 'rechazar', avisarCliente: true });
  });
});

describe('esBorradorCompleto', () => {
  const base = { direccion: 'Mitre 950', metodo_pago: 'efectivo', cantidad_agua: 10, cantidad_crema: 0 };

  it('completo con una sola cantidad > 0', () => {
    expect(esBorradorCompleto(base)).toBe(true);
    expect(esBorradorCompleto({ ...base, cantidad_agua: 0, cantidad_crema: 5 })).toBe(true);
  });

  it("los placeholders '' de los parciales cuentan como faltantes", () => {
    expect(esBorradorCompleto({ ...base, direccion: '' })).toBe(false);
    expect(esBorradorCompleto({ ...base, metodo_pago: '' })).toBe(false);
  });

  it('sin ninguna cantidad no está completo', () => {
    expect(esBorradorCompleto({ ...base, cantidad_agua: 0 })).toBe(false);
  });
});

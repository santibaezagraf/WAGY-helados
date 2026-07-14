import { describe, it, expect } from 'vitest';
import {
  decidirAccionBorrador,
  decidirAccionEsperandoCancelacion,
  esBorradorCompleto,
  AUTO_RECHAZO_HORAS,
  AVISO_CANCELACION_HORAS,
  CANCELACION_SILENCIO_HORAS,
} from './borradores';

const MIN = 60 * 1000;
const HORA = 60 * MIN;

// Caso base: borrador completo, joven, sin recordatorio, cliente callado hace
// 30 min (> umbral completo), nada en vuelo. Cada test pisa lo que le importa.
function params(extra: Partial<Parameters<typeof decidirAccionBorrador>[0]> = {}) {
  return {
    msDesdeCreacion: 30 * MIN,
    esCompleto: true,
    recordatorioEnviado: false,
    msSilencioCliente: 30 * MIN,
    hayMensajesEnVuelo: false,
    ...extra,
  };
}

describe('decidirAccionBorrador', () => {
  it('borrador completo, callado y sin recordatorio previo → recordar', () => {
    expect(decidirAccionBorrador(params())).toEqual({ accion: 'recordar' });
  });

  it('cliente activo hace poco → nada (todavía está conversando)', () => {
    expect(decidirAccionBorrador(params({ msSilencioCliente: 5 * MIN })))
      .toEqual({ accion: 'nada' });
  });

  it('recordatorio ya enviado → nada (es one-shot)', () => {
    expect(decidirAccionBorrador(params({ recordatorioEnviado: true })))
      .toEqual({ accion: 'nada' });
    expect(decidirAccionBorrador(params({ recordatorioEnviado: true, esCompleto: false, msSilencioCliente: 2 * HORA })))
      .toEqual({ accion: 'nada' });
  });

  it('borrador parcial con silencio suficiente → recordar_parcial (re-pide el dato)', () => {
    expect(decidirAccionBorrador(params({ esCompleto: false, msSilencioCliente: 61 * MIN })))
      .toEqual({ accion: 'recordar_parcial' });
  });

  it('borrador parcial pero con silencio corto → nada (usa umbral parcial, más largo)', () => {
    // 30 min alcanza para el completo, no para el parcial (60 min).
    expect(decidirAccionBorrador(params({ esCompleto: false, msSilencioCliente: 30 * MIN })))
      .toEqual({ accion: 'nada' });
  });

  it('sin mensajes del cliente (silencio null) → recordar', () => {
    expect(decidirAccionBorrador(params({ msSilencioCliente: null })))
      .toEqual({ accion: 'recordar' });
  });

  it('mensajes sin procesar en vuelo → nada, incluso si está vencido', () => {
    expect(decidirAccionBorrador(params({ hayMensajesEnVuelo: true })))
      .toEqual({ accion: 'nada' });
    expect(decidirAccionBorrador(params({ hayMensajesEnVuelo: true, msSilencioCliente: 10 * HORA })))
      .toEqual({ accion: 'nada' });
  });

  it('cliente callado más de las horas de auto-rechazo → rechazar avisando', () => {
    expect(decidirAccionBorrador(params({ msSilencioCliente: (AUTO_RECHAZO_HORAS + 1) * HORA })))
      .toEqual({ accion: 'rechazar', avisarCliente: true });
  });

  it('el umbral de rechazo es inclusivo (exactamente 6h de silencio → rechazar)', () => {
    expect(decidirAccionBorrador(params({ msSilencioCliente: AUTO_RECHAZO_HORAS * HORA })))
      .toEqual({ accion: 'rechazar', avisarCliente: true });
  });

  it('justo antes del umbral todavía puede recordar', () => {
    expect(decidirAccionBorrador(params({ msSilencioCliente: AUTO_RECHAZO_HORAS * HORA - 1, recordatorioEnviado: false })))
      .toEqual({ accion: 'recordar' });
  });

  it('el rechazo mide SILENCIO, no edad: borrador viejo con cliente activo NO se rechaza', () => {
    // Caso real: pedido 'pendiente' creado hace 7h que el cliente acaba de
    // modificar → vuelve a 'borrador' con el created_at original. Medir por
    // edad lo auto-rechazaba a los minutos con el cliente esperando el resumen.
    expect(decidirAccionBorrador(params({ msDesdeCreacion: 7 * HORA, msSilencioCliente: 5 * MIN })))
      .toEqual({ accion: 'nada' });
    // Y con silencio de 30 min (recordatorio re-armado por el resumen) recuerda.
    expect(decidirAccionBorrador(params({ msDesdeCreacion: 7 * HORA, msSilencioCliente: 30 * MIN })))
      .toEqual({ accion: 'recordar' });
  });

  it('zombie más callado que la ventana de aviso → rechaza sin escribirle', () => {
    expect(decidirAccionBorrador(params({ msSilencioCliente: (AVISO_CANCELACION_HORAS + 1) * HORA })))
      .toEqual({ accion: 'rechazar', avisarCliente: false });
  });

  it('los parciales abandonados también se rechazan (limpieza)', () => {
    expect(decidirAccionBorrador(params({ esCompleto: false, msSilencioCliente: 7 * HORA })))
      .toEqual({ accion: 'rechazar', avisarCliente: true });
  });

  it('sin mensajes del cliente, la edad del borrador es el fallback del silencio', () => {
    expect(decidirAccionBorrador(params({ msSilencioCliente: null, msDesdeCreacion: 7 * HORA })))
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

describe('decidirAccionEsperandoCancelacion', () => {
  const UMBRAL = CANCELACION_SILENCIO_HORAS * HORA;

  it('cliente callado más del umbral → cancelar (se respeta el pedido de cancelación) con aviso', () => {
    expect(decidirAccionEsperandoCancelacion({ msSilencioCliente: UMBRAL + MIN, hayMensajesEnVuelo: false }))
      .toEqual({ accion: 'cancelar', avisarCliente: true });
  });

  it('cliente escribió hace poco → nada (el flow normal resuelve)', () => {
    expect(decidirAccionEsperandoCancelacion({ msSilencioCliente: UMBRAL - MIN, hayMensajesEnVuelo: false }))
      .toEqual({ accion: 'nada' });
  });

  it('mensajes en vuelo → nada aunque haya pasado el umbral', () => {
    expect(decidirAccionEsperandoCancelacion({ msSilencioCliente: UMBRAL + HORA, hayMensajesEnVuelo: true }))
      .toEqual({ accion: 'nada' });
  });

  it('silencio muy largo (zombie) → cancelar sin avisar (fuera de la ventana de Meta)', () => {
    expect(decidirAccionEsperandoCancelacion({
      msSilencioCliente: (AVISO_CANCELACION_HORAS + 1) * HORA,
      hayMensajesEnVuelo: false,
    })).toEqual({ accion: 'cancelar', avisarCliente: false });
  });

  it('justo en el umbral → cancelar', () => {
    expect(decidirAccionEsperandoCancelacion({ msSilencioCliente: UMBRAL, hayMensajesEnVuelo: false }))
      .toEqual({ accion: 'cancelar', avisarCliente: true });
  });
});

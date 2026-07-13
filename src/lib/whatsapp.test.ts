import { describe, it, expect } from 'vitest';
import { mimeAExtension, mensajeConfirmacion } from './whatsapp';
import { PAGO_TRANSFERENCIA, ENTREGA } from './precios-publico';

// Función pura: mapeo mime -> extensión para el nombre del archivo en Storage.
// (El resto de whatsapp.ts es red/Storage y no se testea acá.)
describe('mimeAExtension', () => {
  it('mapea los mimes conocidos de WhatsApp', () => {
    expect(mimeAExtension('image/jpeg')).toBe('jpg');
    expect(mimeAExtension('image/png')).toBe('png');
    expect(mimeAExtension('audio/ogg')).toBe('ogg');
    expect(mimeAExtension('audio/mpeg')).toBe('mp3');
    expect(mimeAExtension('video/mp4')).toBe('mp4');
    expect(mimeAExtension('application/pdf')).toBe('pdf');
  });

  it('ignora los parámetros del mime (codecs, charset)', () => {
    // WhatsApp suele mandar los audios como "audio/ogg; codecs=opus".
    expect(mimeAExtension('audio/ogg; codecs=opus')).toBe('ogg');
    expect(mimeAExtension('image/jpeg ;charset=binary')).toBe('jpg');
  });

  it('cae al subtipo cuando el mime no está en el mapa', () => {
    expect(mimeAExtension('application/zip')).toBe('zip');
    expect(mimeAExtension('image/heic')).toBe('heic');
  });

  it('sanea el subtipo dejando solo alfanuméricos', () => {
    expect(mimeAExtension('application/vnd.ms-excel')).toBe('vndmsexcel');
  });

  it('devuelve "bin" para null / undefined / vacío', () => {
    expect(mimeAExtension(null)).toBe('bin');
    expect(mimeAExtension(undefined)).toBe('bin');
    expect(mimeAExtension('')).toBe('bin');
  });

  it('devuelve "bin" cuando no hay subtipo aprovechable', () => {
    expect(mimeAExtension('application/')).toBe('bin');
    expect(mimeAExtension('rarodemas')).toBe('bin');
  });
});

// Función pura: texto de confirmación según envío/retiro y método de pago.
describe('mensajeConfirmacion', () => {
  it('envío a domicilio con efectivo: ETA de entrega, sin datos de transferencia', () => {
    const msg = mensajeConfirmacion('Mitre 950', 'efectivo');
    expect(msg).toContain('¡Confirmado!');
    expect(msg).toContain(`Te llega en aproximadamente ${ENTREGA.tiempoEstimado}`);
    expect(msg).not.toContain(PAGO_TRANSFERENCIA.alias);
  });

  it('retiro: ETA de retiro en vez de entrega', () => {
    const msg = mensajeConfirmacion('retira', 'efectivo');
    expect(msg).toContain('lo podés pasar a buscar');
    expect(msg).not.toContain('Te llega');
  });

  it('transferencia: incluye alias y titular', () => {
    const msg = mensajeConfirmacion('Mitre 950', 'transferencia');
    expect(msg).toContain(PAGO_TRANSFERENCIA.alias);
    expect(msg).toContain(PAGO_TRANSFERENCIA.titular);
  });
});

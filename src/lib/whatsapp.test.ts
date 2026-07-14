import { describe, it, expect } from 'vitest';
import { mimeAExtension, mensajeConfirmacion, construirResumenPedido } from './whatsapp';
import { PAGO_TRANSFERENCIA, ENTREGA, formatearPesos } from './precios-publico';

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

// Función pura: texto del resumen con botones de confirmación.
describe('construirResumenPedido', () => {
  const base = {
    id: 1,
    cantidad_crema: 10,
    cantidad_agua: 20,
    observaciones: 'los de agua de frutilla',
    direccion: 'Mitre 950',
    aclaracion: 'depto 6',
    metodo_pago: 'efectivo',
    precio_total: 12000,
  };

  it('incluye cantidades, sabores, envío con aclaración, pago y total formateado', () => {
    const msg = construirResumenPedido(base, false);
    expect(msg).toContain('*Tu pedido:*');
    expect(msg).toContain('• Crema: 10');
    expect(msg).toContain('• Agua: 20');
    expect(msg).toContain('_Sabores: los de agua de frutilla_');
    expect(msg).toContain('• Envío a: Mitre 950 (depto 6)');
    expect(msg).toContain('• Pago: efectivo');
    expect(msg).toContain(`• *Total: ${formatearPesos(12000)}*`);
  });

  it('precio_total null cae a "a confirmar" (nunca "$null")', () => {
    const msg = construirResumenPedido({ ...base, precio_total: null }, false);
    expect(msg).toContain('• *Total: a confirmar*');
    expect(msg).not.toContain('null');
  });

  it('retira: muestra retiro en sucursal y no la dirección', () => {
    const msg = construirResumenPedido({ ...base, direccion: 'retira' }, false);
    expect(msg).toContain('• Retira en sucursal');
    expect(msg).not.toContain('Envío a');
  });

  it('modificación: cambia el encabezado', () => {
    const msg = construirResumenPedido(base, true);
    expect(msg).toContain('*Pedido actualizado:*');
    expect(msg).not.toContain('*Tu pedido:*');
  });

  it('avisa cuando la dirección salió del historial, salvo en retiro', () => {
    const conAviso = construirResumenPedido(base, false, true);
    expect(conAviso).toContain('Usé la dirección de tu último pedido');

    const sinFlag = construirResumenPedido(base, false, false);
    expect(sinFlag).not.toContain('Usé la dirección');

    const retira = construirResumenPedido({ ...base, direccion: 'retira' }, false, true);
    expect(retira).not.toContain('Usé la dirección');
  });

  it('omite la línea de un tipo con cantidad 0', () => {
    const msg = construirResumenPedido({ ...base, cantidad_crema: 0 }, false);
    expect(msg).not.toContain('• Crema');
    expect(msg).toContain('• Agua: 20');
  });
});

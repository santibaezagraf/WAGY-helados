import { describe, it, expect } from 'vitest';
import { mimeAExtension, mensajeConfirmacion, construirResumenPedido, esErrorTimeoutPropio, esTranscripcionUtil, esSegmentoAlucinado, filtrarSegmentosConfiables } from './whatsapp';
import { PAGO_TRANSFERENCIA, ENTREGA, formatearPesos } from './precios-publico';

// Clasificación del error de un fetch a Meta: solo el timeout propio (AbortError)
// es "posible entrega ya hecha" y por eso NO se reintenta (reintentar duplicaría,
// la Cloud API no tiene idempotencia en outbound). El resto sí es reintentable.
describe('esErrorTimeoutPropio', () => {
  it('reconoce el AbortError de nuestro AbortController (por name)', () => {
    // Node/undici lanza un DOMException con name 'AbortError' y este mensaje.
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(esErrorTimeoutPropio(abort)).toBe(true);
  });

  it('NO trata como timeout un fallo de conexión (fetch failed / DNS / ECONNREFUSED)', () => {
    // Esos llegan como TypeError 'fetch failed' → la request no salió → reintentable.
    expect(esErrorTimeoutPropio(new TypeError('fetch failed'))).toBe(false);
    const dns = new Error('getaddrinfo ENOTFOUND graph.facebook.com');
    expect(esErrorTimeoutPropio(dns)).toBe(false);
  });

  it('es defensiva ante no-errores', () => {
    expect(esErrorTimeoutPropio(null)).toBe(false);
    expect(esErrorTimeoutPropio(undefined)).toBe(false);
    expect(esErrorTimeoutPropio('AbortError')).toBe(false); // string suelto, no Error
    expect(esErrorTimeoutPropio({ name: 'AbortError' })).toBe(false); // objeto plano, no instanceof Error
  });
});

describe('esTranscripcionUtil', () => {
  it('acepta texto con contenido real', () => {
    expect(esTranscripcionUtil('quiero 10 de crema en Mitre 951')).toBe(true);
    expect(esTranscripcionUtil('sí')).toBe(true);
    expect(esTranscripcionUtil('  dale  ')).toBe(true);
  });

  it('rechaza null, vacío y solo espacios', () => {
    expect(esTranscripcionUtil(null)).toBe(false);
    expect(esTranscripcionUtil('')).toBe(false);
    expect(esTranscripcionUtil('   ')).toBe(false);
  });

  it('rechaza ruido sin alfanuméricos (silencio/alucinación)', () => {
    expect(esTranscripcionUtil('...')).toBe(false);
    expect(esTranscripcionUtil('♪')).toBe(false);
    expect(esTranscripcionUtil('— , .')).toBe(false);
  });
});

// Segunda línea de defensa contra alucinaciones de Whisper: a diferencia de
// esTranscripcionUtil (que solo mira si el texto TIENE contenido), esto usa
// las señales de confianza que el propio Whisper devuelve por segmento
// (no_speech_prob/avg_logprob/compression_ratio, vía verbose_json) para
// detectar texto verosímil pero fabricado sobre silbidos/ruido/silencio —
// el caso real que motivó esto: "Tres de la cara de la tierra, el" sobre un
// audio de puro ruido de fondo, que pasaba esTranscripcionUtil sin problema.
describe('esSegmentoAlucinado', () => {
  it('no marca un segmento de habla real y confiable', () => {
    expect(
      esSegmentoAlucinado({ text: 'quiero 10 de agua', noSpeechProb: 0.05, avgLogprob: -0.2, compressionRatio: 1.3 }),
    ).toBe(false);
  });

  it('marca alto no_speech_prob + bajo avg_logprob (silencio/ruido no verbal)', () => {
    expect(
      esSegmentoAlucinado({ text: 'Tres de la cara de la tierra, el', noSpeechProb: 0.85, avgLogprob: -1.4, compressionRatio: 1.1 }),
    ).toBe(true);
  });

  it('no alcanza con un solo criterio débil (evita falsos positivos)', () => {
    // no_speech_prob alto solo: pasa en habla real bajita/con ruido de fondo.
    expect(
      esSegmentoAlucinado({ text: 'hola', noSpeechProb: 0.7, avgLogprob: -0.3, compressionRatio: 1.2 }),
    ).toBe(false);
    // avg_logprob bajo solo: pasa con acentos/audio de mala calidad.
    expect(
      esSegmentoAlucinado({ text: 'quiero cinco de crema', noSpeechProb: 0.2, avgLogprob: -1.3, compressionRatio: 1.2 }),
    ).toBe(false);
  });

  it('marca compression_ratio alto (texto repetitivo, loop típico de alucinación)', () => {
    expect(
      esSegmentoAlucinado({ text: 'gracias gracias gracias gracias', noSpeechProb: 0.1, avgLogprob: -0.3, compressionRatio: 2.8 }),
    ).toBe(true);
  });
});

describe('filtrarSegmentosConfiables', () => {
  it('concatena solo los segmentos confiables', () => {
    const texto = filtrarSegmentosConfiables([
      { text: ' quiero 10 de agua ', noSpeechProb: 0.05, avgLogprob: -0.2, compressionRatio: 1.3 },
      { text: 'Tres de la cara de la tierra, el', noSpeechProb: 0.9, avgLogprob: -1.5, compressionRatio: 1.1 },
      { text: 'en Mitre 951', noSpeechProb: 0.1, avgLogprob: -0.3, compressionRatio: 1.2 },
    ]);
    expect(texto).toBe('quiero 10 de agua en Mitre 951');
  });

  it('devuelve null si ningún segmento sobrevive (audio entero ruido/silbidos)', () => {
    const texto = filtrarSegmentosConfiables([
      { text: 'Tres de la cara de la tierra, el', noSpeechProb: 0.9, avgLogprob: -1.5, compressionRatio: 1.1 },
    ]);
    expect(texto).toBeNull();
  });

  it('devuelve null en una lista vacía', () => {
    expect(filtrarSegmentosConfiables([])).toBeNull();
  });
});

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

import { describe, it, expect } from 'vitest';
import {
  aplicarOperacionCantidad,
  aplicarOperacionAclaracion,
  resolverAclaracion,
  aplicarOperacionObs,
  leerSlots,
  reconstruirObservaciones,
  pareceDireccion,
  mencionaRetiro,
  mencionaRechazoCancelacion,
  mencionaCantidadEnUnidadNoSoportada,
  mencionaMetodoPagoNoSoportado,
  normalizarTextoShortCircuit,
  intentarShortCircuit,
  elegirRespuestaDatosFaltantes,
  estaDespachado,
  dentroDePlazoModificacionCocina,
  esRateLimit,
  esPreguntaNegocioReal,
  mencionaTipoHelado,
  normalizarMetodoPago,
  type PedidoActivoContext,
} from './procesar';

// Helper: arma un PedidoActivoContext completo a partir de un parcial, para no
// repetir los campos que no importan en cada test.
function pa(extra: Partial<PedidoActivoContext>): PedidoActivoContext {
  return {
    estado: 'borrador',
    cantidad_agua: 0,
    cantidad_crema: 0,
    direccion: 'Mitre 951',
    aclaracion: null,
    observaciones: null,
    observaciones_detalle: null,
    metodo_pago: 'efectivo',
    ...extra,
  };
}

describe('aplicarOperacionCantidad', () => {
  it('suma sobre el actual', () => {
    expect(aplicarOperacionCantidad('sumar', 5, 70)).toBe(75);
  });
  it('resta sobre el actual', () => {
    expect(aplicarOperacionCantidad('restar', 3, 10)).toBe(7);
  });
  it('nunca devuelve negativos al restar', () => {
    expect(aplicarOperacionCantidad('restar', 20, 5)).toBe(0);
  });
  it('reemplaza ignorando el actual', () => {
    expect(aplicarOperacionCantidad('reemplazar', 25, 70)).toBe(25);
  });
  it('reemplazar tampoco devuelve negativos', () => {
    expect(aplicarOperacionCantidad('reemplazar', -5, 10)).toBe(0);
  });
  it('mantener conserva el actual', () => {
    expect(aplicarOperacionCantidad('mantener', 0, 42)).toBe(42);
  });
});

describe('aplicarOperacionAclaracion', () => {
  it('mantener conserva el actual', () => {
    expect(aplicarOperacionAclaracion('mantener', null, 'depto 6')).toBe('depto 6');
  });
  it('agregar concatena con coma sin perder lo viejo', () => {
    expect(aplicarOperacionAclaracion('agregar', 'piso 3', 'depto 6')).toBe('depto 6, piso 3');
  });
  it('agregar sobre actual null devuelve solo el texto nuevo', () => {
    expect(aplicarOperacionAclaracion('agregar', 'casa verde', null)).toBe('casa verde');
  });
  it('agregar sin texto nuevo no toca el actual', () => {
    expect(aplicarOperacionAclaracion('agregar', null, 'depto 6')).toBe('depto 6');
  });
  it('reemplazar pisa con el texto corregido completo', () => {
    expect(aplicarOperacionAclaracion('reemplazar', 'casa verde, de 2 pisos', 'casa marron, de 2 pisos'))
      .toBe('casa verde, de 2 pisos');
  });
  it('reemplazar sin texto (defensivo) no borra el actual', () => {
    expect(aplicarOperacionAclaracion('reemplazar', null, 'depto 6')).toBe('depto 6');
  });
});

describe('resolverAclaracion', () => {
  it('sin cambio de dirección se comporta como el merge normal (agregar concatena)', () => {
    expect(resolverAclaracion('agregar', 'piso 3', 'depto 6', 'Mitre 951', 'Mitre 951'))
      .toBe('depto 6, piso 3');
  });
  it('misma dirección: mantener conserva la aclaración vieja', () => {
    expect(resolverAclaracion('mantener', null, 'porton rojo', 'Mitre 951', 'Mitre 951'))
      .toBe('porton rojo');
  });
  it('cambia la dirección + agregar: descarta la vieja, solo queda lo nuevo', () => {
    expect(resolverAclaracion('agregar', 'la casa de ladrillo', 'porton rojo, puerta gris', 'Vergara 2664', 'Mitre 951'))
      .toBe('la casa de ladrillo');
  });
  it('cambia la dirección + mantener: descarta la aclaración vieja por completo', () => {
    expect(resolverAclaracion('mantener', null, 'porton rojo, puerta gris', 'Vergara 2664', 'Mitre 951'))
      .toBeNull();
  });
  it('dirección nueva basura (no pasa pareceDireccion) NO descarta la aclaración', () => {
    // "depto 6" no es calle+altura → no cuenta como cambio de dirección real.
    expect(resolverAclaracion('agregar', 'piso 3', 'depto 6', 'depto 6', 'Mitre 951'))
      .toBe('depto 6, piso 3');
  });
  it('sin dirección previa (pedido nuevo) no descarta nada', () => {
    expect(resolverAclaracion('agregar', 'casa verde', null, 'Mitre 951', null))
      .toBe('casa verde');
  });
});

describe('aplicarOperacionObs', () => {
  it('mantener conserva el actual', () => {
    expect(aplicarOperacionObs('mantener', null, 'de chocolate')).toBe('de chocolate');
  });
  it('reemplazar pisa el slot', () => {
    expect(aplicarOperacionObs('reemplazar', 'de frutilla', 'de vainilla')).toBe('de frutilla');
  });
  it('agregar concatena dentro del slot', () => {
    expect(aplicarOperacionObs('agregar', 'menta', 'frutilla')).toBe('frutilla, menta');
  });
  it('limpiar vacía el slot', () => {
    expect(aplicarOperacionObs('limpiar', null, 'de chocolate')).toBeNull();
  });
});

describe('leerSlots', () => {
  it('lee los slots del jsonb cuando existe', () => {
    const p = pa({ observaciones_detalle: { agua: 'de frutilla', crema: 'de chocolate', general: 'sin coco' } });
    expect(leerSlots(p)).toEqual({ agua: 'de frutilla', crema: 'de chocolate', general: 'sin coco' });
  });
  it('siembra general desde el texto plano cuando el jsonb es null (edición manual / fila vieja)', () => {
    const p = pa({ observaciones: 'lo que escribió el staff', observaciones_detalle: null });
    expect(leerSlots(p)).toEqual({ agua: null, crema: null, general: 'lo que escribió el staff' });
  });
  it('devuelve slots vacíos si no hay pedido ni texto', () => {
    expect(leerSlots(null)).toEqual({ agua: null, crema: null, general: null });
  });
  it('ignora un jsonb malformado (array) y cae al texto plano', () => {
    const p = pa({ observaciones: 'fallback', observaciones_detalle: ['x'] as unknown as PedidoActivoContext['observaciones_detalle'] });
    expect(leerSlots(p)).toEqual({ agua: null, crema: null, general: 'fallback' });
  });
  it('tolera slots parciales en el jsonb (campos faltantes -> null)', () => {
    const p = pa({ observaciones_detalle: { agua: 'de frutilla' } });
    expect(leerSlots(p)).toEqual({ agua: 'de frutilla', crema: null, general: null });
  });
});

describe('reconstruirObservaciones', () => {
  it('arma el texto con prefijos por tipo', () => {
    expect(reconstruirObservaciones({ agua: 'de frutilla', crema: 'de chocolate', general: null }))
      .toBe('los de agua de frutilla, los de crema de chocolate');
  });
  it('incluye el general sin prefijo', () => {
    expect(reconstruirObservaciones({ agua: null, crema: null, general: 'sin coco' }))
      .toBe('sin coco');
  });
  it('combina tipos y general', () => {
    expect(reconstruirObservaciones({ agua: 'de frutilla', crema: null, general: 'sin coco' }))
      .toBe('los de agua de frutilla, sin coco');
  });
  it('devuelve null si todos los slots están vacíos', () => {
    expect(reconstruirObservaciones({ agua: null, crema: null, general: null })).toBeNull();
  });
});

describe('pareceDireccion', () => {
  it('acepta calle + altura clásica', () => {
    expect(pareceDireccion('Mitre 951')).toBe(true);
  });
  it('acepta con abreviatura y tilde', () => {
    expect(pareceDireccion('Av. San Martín 1234')).toBe(true);
  });
  it('acepta calle que arranca con número ("9 de Julio 23")', () => {
    expect(pareceDireccion('9 de Julio 23')).toBe(true);
  });
  it('acepta "Calle 12 1450"', () => {
    expect(pareceDireccion('Calle 12 1450')).toBe(true);
  });
  it('acepta el sentinela "retira"', () => {
    expect(pareceDireccion('retira')).toBe(true);
  });
  it('rechaza una referencia de unidad sin calle ("depto 6")', () => {
    expect(pareceDireccion('depto 6')).toBe(false);
  });
  it('rechaza una calle sin altura ("Mitre")', () => {
    expect(pareceDireccion('Mitre')).toBe(false);
  });
  it('rechaza texto sin número ("la casa verde")', () => {
    expect(pareceDireccion('la casa verde')).toBe(false);
  });
  it('rechaza solo un número', () => {
    expect(pareceDireccion('1234')).toBe(false);
  });
  it('rechaza null / vacío', () => {
    expect(pareceDireccion(null)).toBe(false);
    expect(pareceDireccion('   ')).toBe(false);
  });
});

describe('mencionaRetiro', () => {
  it('detecta "paso a retirar" inline con el resto del pedido', () => {
    expect(mencionaRetiro('15 de crema, paso a retirar, pago en efectivo')).toBe(true);
  });
  it('detecta la conjugación "retiro"', () => {
    expect(mencionaRetiro('1234, retiro, efectivo')).toBe(true);
  });
  it('detecta "retira" y "retirar" sueltos', () => {
    expect(mencionaRetiro('retira')).toBe(true);
    expect(mencionaRetiro('lo voy a retirar yo')).toBe(true);
  });
  it('detecta "lo paso a buscar" / "lo busco"', () => {
    expect(mencionaRetiro('mejor lo paso a buscar')).toBe(true);
    expect(mencionaRetiro('no, lo busco yo')).toBe(true);
  });
  it('detecta "paso por el local"', () => {
    expect(mencionaRetiro('paso por el local a la tarde')).toBe(true);
  });
  it('tolera tildes y mayúsculas', () => {
    expect(mencionaRetiro('RETIRÁ')).toBe(true);
  });
  it('no dispara con una dirección de envío normal', () => {
    expect(mencionaRetiro('mandámelos a Mitre 951')).toBe(false);
    expect(mencionaRetiro('10 de crema a San Martín 456, efectivo')).toBe(false);
  });
  it('no dispara con null / vacío', () => {
    expect(mencionaRetiro(null)).toBe(false);
    expect(mencionaRetiro('')).toBe(false);
  });
});

describe('mencionaRechazoCancelacion', () => {
  it('detecta el caso del informe: "no lo cancelo" mezclado con un pedido de precio', () => {
    expect(mencionaRechazoCancelacion('No, no lo cancelo, dame el total ya')).toBe(true);
  });
  it('detecta variantes de negación explícita de cancelar', () => {
    expect(mencionaRechazoCancelacion('no lo canceles')).toBe(true);
    expect(mencionaRechazoCancelacion('no quiero cancelar')).toBe(true);
    expect(mencionaRechazoCancelacion('no, mantenelo')).toBe(true);
    expect(mencionaRechazoCancelacion('dejalo así')).toBe(true);
    expect(mencionaRechazoCancelacion('no lo anules')).toBe(true);
  });
  it('tolera tildes y mayúsculas', () => {
    expect(mencionaRechazoCancelacion('NO LO CANCELÉS')).toBe(true);
  });
  it('no dispara con un "sí, cancelalo" (confirmación de cancelación)', () => {
    expect(mencionaRechazoCancelacion('sí, cancelalo')).toBe(false);
    expect(mencionaRechazoCancelacion('dale, cancelá')).toBe(false);
  });
  it('no dispara con un "no" suelto (lo agarra el short-circuit / el modelo)', () => {
    expect(mencionaRechazoCancelacion('no')).toBe(false);
  });
  it('no dispara con null / vacío', () => {
    expect(mencionaRechazoCancelacion(null)).toBe(false);
    expect(mencionaRechazoCancelacion('')).toBe(false);
  });
});

describe('esPreguntaNegocioReal', () => {
  it('una pregunta real cuenta', () => {
    expect(esPreguntaNegocioReal('¿a qué hora entregan?')).toBe(true);
  });
  it('el string "null" que a veces devuelve el modelo NO cuenta (evita delegación fantasma)', () => {
    expect(esPreguntaNegocioReal('null')).toBe(false);
    expect(esPreguntaNegocioReal('NULL')).toBe(false);
    expect(esPreguntaNegocioReal(' null ')).toBe(false);
  });
  it('otros placeholders del modelo tampoco cuentan', () => {
    expect(esPreguntaNegocioReal('none')).toBe(false);
    expect(esPreguntaNegocioReal('undefined')).toBe(false);
    expect(esPreguntaNegocioReal('N/A')).toBe(false);
  });
  it('null / vacío / whitespace no cuentan', () => {
    expect(esPreguntaNegocioReal(null)).toBe(false);
    expect(esPreguntaNegocioReal(undefined)).toBe(false);
    expect(esPreguntaNegocioReal('')).toBe(false);
    expect(esPreguntaNegocioReal('   ')).toBe(false);
  });
});

describe('normalizarMetodoPago', () => {
  it('acepta los dos válidos (tolerando mayúsculas/espacios)', () => {
    expect(normalizarMetodoPago('efectivo')).toBe('efectivo');
    expect(normalizarMetodoPago('transferencia')).toBe('transferencia');
    expect(normalizarMetodoPago(' Efectivo ')).toBe('efectivo');
    expect(normalizarMetodoPago('TRANSFERENCIA')).toBe('transferencia');
  });
  it('el string "null" del modelo NO es un pago válido (no se cuela como "Pago: null")', () => {
    expect(normalizarMetodoPago('null')).toBeNull();
    expect(normalizarMetodoPago('none')).toBeNull();
  });
  it('null / vacío / valor inesperado caen a null', () => {
    expect(normalizarMetodoPago(null)).toBeNull();
    expect(normalizarMetodoPago(undefined)).toBeNull();
    expect(normalizarMetodoPago('')).toBeNull();
    expect(normalizarMetodoPago('mp')).toBeNull();
  });
});

describe('normalizarTextoShortCircuit', () => {
  it('saca tildes y pasa a minúsculas', () => {
    expect(normalizarTextoShortCircuit('SÍ')).toBe('si');
  });
  it('colapsa vocales estiradas y saca puntuación/emojis', () => {
    expect(normalizarTextoShortCircuit('Holaaa!! 👋')).toBe('hola');
  });
  it('normaliza una confirmación con signos', () => {
    expect(normalizarTextoShortCircuit('¡Dale!')).toBe('dale');
  });
});

describe('intentarShortCircuit', () => {
  it('en esperando_cancelacion, "sí" confirma la cancelación', () => {
    expect(intentarShortCircuit('sí', 'esperando_cancelacion')).toBe('confirmar_cancelacion');
  });
  it('en esperando_cancelacion, "no" la rechaza', () => {
    expect(intentarShortCircuit('no', 'esperando_cancelacion')).toBe('rechazar_cancelacion');
  });
  it('en borrador, una confirmación dispara "confirmar"', () => {
    expect(intentarShortCircuit('dale', 'borrador')).toBe('confirmar');
  });
  it('un saludo con estado conocido dispara "saludo"', () => {
    expect(intentarShortCircuit('holaaa', 'pendiente')).toBe('saludo');
  });
  it('un saludo SIN estado cae al LLM (null)', () => {
    expect(intentarShortCircuit('hola', null)).toBeNull();
  });
  it('un mensaje ambiguo no hace short-circuit', () => {
    expect(intentarShortCircuit('quiero 10 de crema', 'borrador')).toBeNull();
  });
  it('"dale" en borrador NO se confunde con confirmar_cancelacion', () => {
    expect(intentarShortCircuit('dale', 'esperando_cancelacion')).toBe('confirmar_cancelacion');
  });
});

// Decisión pura de cómo pedir los datos faltantes (botones vs lista de texto).
// La regla: botones solo cuando falta UN dato y es una elección cerrada.
describe('elegirRespuestaDatosFaltantes', () => {
  it('falta solo el pago → botones efectivo/transferencia', () => {
    expect(elegirRespuestaDatosFaltantes(false, false, true)).toEqual({ tipo: 'botones_pago' });
  });

  it('falta solo la dirección → botón de retiro', () => {
    expect(elegirRespuestaDatosFaltantes(false, true, false)).toEqual({ tipo: 'boton_retira' });
  });

  it('falta solo la cantidad → texto con un único ítem', () => {
    const r = elegirRespuestaDatosFaltantes(true, false, false);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') {
      expect(r.mensaje).toContain('Para armar tu pedido me falta:');
      expect(r.mensaje).toContain('Cantidades de helado');
      expect(r.mensaje).not.toContain('Dirección');
      expect(r.mensaje).not.toContain('Forma de pago');
    }
  });

  it('faltan dirección y pago → texto con ambos ítems (sin botones)', () => {
    const r = elegirRespuestaDatosFaltantes(false, true, true);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') {
      expect(r.mensaje).toContain('Dirección de envío');
      expect(r.mensaje).toContain('Forma de pago');
      expect(r.mensaje).not.toContain('Cantidades de helado');
    }
  });

  it('falta cantidad + otro dato → texto, nunca botones', () => {
    expect(elegirRespuestaDatosFaltantes(true, false, true).tipo).toBe('texto');
    expect(elegirRespuestaDatosFaltantes(true, true, false).tipo).toBe('texto');
  });

  it('faltan los tres → encabezado de bienvenida (seed por defecto = variante histórica)', () => {
    const r = elegirRespuestaDatosFaltantes(true, true, true);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') {
      expect(r.mensaje).toContain('¿Qué te gustaría pedir?');
      expect(r.mensaje).toContain('Cantidades de helado');
      expect(r.mensaje).toContain('Dirección de envío');
      expect(r.mensaje).toContain('Forma de pago');
    }
  });

  it('faltan los tres → el saludo varía con el seed, pero los 3 ítems no (#4)', () => {
    const encabezado = (seed: number) => {
      const r = elegirRespuestaDatosFaltantes(true, true, true, seed);
      // Primera línea = saludo; el resto son los bullets.
      return r.tipo === 'texto' ? r.mensaje.split('\n')[0] : '';
    };
    // Seeds que caen en variantes distintas dan saludos distintos.
    expect(encabezado(0)).not.toBe(encabezado(1));
    expect(encabezado(1)).not.toBe(encabezado(2));
    // Mismo seed → mismo saludo (determinista, sin Math.random).
    expect(encabezado(5)).toBe(encabezado(5));
    // Sea cual sea el saludo, los 3 datos siempre están.
    for (const seed of [0, 1, 2, 7, 13]) {
      const r = elegirRespuestaDatosFaltantes(true, true, true, seed);
      if (r.tipo === 'texto') {
        expect(r.mensaje).toContain('Cantidades de helado');
        expect(r.mensaje).toContain('Dirección de envío');
        expect(r.mensaje).toContain('Forma de pago');
      }
    }
  });
});

// Cuando el cliente expresa la cantidad en una unidad no soportada
// (kilo/pote/porción/bola/cucurucho), el mensaje genérico "me falta cantidad"
// entra en loop porque el cliente cree que ya la dio. El flag cambia el texto.
describe('elegirRespuestaDatosFaltantes con cantidadEnUnidadNoSoportada', () => {
  it('falta solo cantidad + unidad no soportada → mensaje aclaratorio, no bullet list', () => {
    const r = elegirRespuestaDatosFaltantes(true, false, false, 0, true);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') {
      expect(r.mensaje).toContain('por unidad');
      expect(r.mensaje).toContain('kilo');
      expect(r.mensaje).not.toContain('Para armar tu pedido me falta:');
    }
  });

  it('faltan varios + unidad no soportada → bullet de cantidad explicativo', () => {
    const r = elegirRespuestaDatosFaltantes(true, false, true, 0, true);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') {
      expect(r.mensaje).toContain('Para armar tu pedido me falta:');
      expect(r.mensaje).toContain('por unidad');
      expect(r.mensaje).toContain('Forma de pago');
      // El bullet viejo genérico ya no aplica cuando la señal está activa.
      expect(r.mensaje).not.toContain('Cantidades de helado (agua/crema)');
    }
  });

  it('flag=true pero NO falta la cantidad → sin cambios (solo botones de pago)', () => {
    // Escenario improbable pero cubre que el flag es defensivo, no autoritario.
    expect(elegirRespuestaDatosFaltantes(false, false, true, 0, true))
      .toEqual({ tipo: 'botones_pago' });
  });
});

describe('mencionaCantidadEnUnidadNoSoportada', () => {
  it('detecta kilos y variantes', () => {
    expect(mencionaCantidadEnUnidadNoSoportada('un kilo de chocolate')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('2 kilos de crema')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('medio kilo')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('500 gramos')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('500 gr o similar')).toBe(false); // "gr" solo es ambiguo, no lo tomamos
    expect(mencionaCantidadEnUnidadNoSoportada('quiero 1 kg')).toBe(true);
  });

  it('detecta unidades servidas (pote/porción/bola/cucurucho)', () => {
    expect(mencionaCantidadEnUnidadNoSoportada('un pote de chocolate')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('dos potes de crema')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('una porción con 2 bolas')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('porciones grandes')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('3 bolas de vainilla')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('una bolita más')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('un cucurucho de dulce de leche')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('2 cucuruchos')).toBe(true);
  });

  it('tolera tildes y mayúsculas', () => {
    expect(mencionaCantidadEnUnidadNoSoportada('una PORCIÓN')).toBe(true);
    expect(mencionaCantidadEnUnidadNoSoportada('Un Kilo')).toBe(true);
  });

  it('no falso-positivea sobre pedidos normales por unidad', () => {
    expect(mencionaCantidadEnUnidadNoSoportada('quiero 10 de agua y 5 de crema')).toBe(false);
    expect(mencionaCantidadEnUnidadNoSoportada('20 helados de frutilla')).toBe(false);
    expect(mencionaCantidadEnUnidadNoSoportada('Rivadavia 456, efectivo')).toBe(false);
    expect(mencionaCantidadEnUnidadNoSoportada('')).toBe(false);
    expect(mencionaCantidadEnUnidadNoSoportada(null)).toBe(false);
  });
});

describe('mencionaMetodoPagoNoSoportado', () => {
  it('detecta tarjeta, débito, crédito y variantes', () => {
    expect(mencionaMetodoPagoNoSoportado('pago con tarjeta')).toBe(true);
    expect(mencionaMetodoPagoNoSoportado('tengo débito')).toBe(true);
    expect(mencionaMetodoPagoNoSoportado('con crédito')).toBe(true);
    expect(mencionaMetodoPagoNoSoportado('tienen posnet?')).toBe(true);
    expect(mencionaMetodoPagoNoSoportado('puedo por Rapipago?')).toBe(true);
    expect(mencionaMetodoPagoNoSoportado('pago fácil')).toBe(true);
  });

  it('tolera tildes y mayúsculas', () => {
    expect(mencionaMetodoPagoNoSoportado('TARJETA DE DÉBITO')).toBe(true);
    expect(mencionaMetodoPagoNoSoportado('Crédito')).toBe(true);
  });

  it('no falso-positivea sobre métodos válidos', () => {
    expect(mencionaMetodoPagoNoSoportado('efectivo')).toBe(false);
    expect(mencionaMetodoPagoNoSoportado('transferencia')).toBe(false);
    expect(mencionaMetodoPagoNoSoportado('mercado pago')).toBe(false);
    expect(mencionaMetodoPagoNoSoportado('10 de agua')).toBe(false);
    expect(mencionaMetodoPagoNoSoportado('')).toBe(false);
    expect(mencionaMetodoPagoNoSoportado(null)).toBe(false);
  });
});

describe('elegirRespuestaDatosFaltantes con pagoNoSoportado', () => {
  it('falta solo pago + método no soportado → texto aclaratorio, no botones', () => {
    const r = elegirRespuestaDatosFaltantes(false, false, true, 0, false, true);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') {
      expect(r.mensaje).toContain('efectivo');
      expect(r.mensaje).toContain('transferencia');
    }
  });

  it('falta solo pago SIN método no soportado → botones normales', () => {
    expect(elegirRespuestaDatosFaltantes(false, false, true, 0, false, false))
      .toEqual({ tipo: 'botones_pago' });
  });

  it('flag=true pero NO falta el pago → sin efecto', () => {
    expect(elegirRespuestaDatosFaltantes(false, true, false, 0, false, true))
      .toEqual({ tipo: 'boton_retira' });
  });
});

describe('estaDespachado', () => {
  it('estado="enviado" → despachado (aunque enviado sea false/null)', () => {
    expect(estaDespachado({ estado: 'enviado', enviado: false })).toBe(true);
    expect(estaDespachado({ estado: 'enviado', enviado: null })).toBe(true);
  });

  it('enviado=true → despachado aunque el estado todavía sea "pendiente"', () => {
    // Caso central: se copió el mensaje al cadete (enviado=true) pero nadie
    // movió el estado a mano todavía.
    expect(estaDespachado({ estado: 'pendiente', enviado: true })).toBe(true);
  });

  it('pendiente sin enviar → no despachado', () => {
    expect(estaDespachado({ estado: 'pendiente', enviado: false })).toBe(false);
  });

  it('borrador / esperando_cancelacion sin enviar → no despachado', () => {
    expect(estaDespachado({ estado: 'borrador', enviado: false })).toBe(false);
    expect(estaDespachado({ estado: 'esperando_cancelacion', enviado: null })).toBe(false);
  });

  it('cancelado con enviado ausente → no despachado (patchConEnviadoCoherente fuerza enviado=false)', () => {
    expect(estaDespachado({ estado: 'cancelado' })).toBe(false);
  });

  it('la cancelación gana: cancelado + enviado=true colgado → NO despachado', () => {
    // Defensa contra un enviado=true que quedó sin limpiar al cancelar desde el
    // bot: no queremos re-disparar el viejo bug de "ya fue despachado".
    expect(estaDespachado({ estado: 'cancelado', enviado: true })).toBe(false);
  });

  it('campos ausentes → no despachado', () => {
    expect(estaDespachado({})).toBe(false);
  });
});

describe('dentroDePlazoModificacionCocina', () => {
  it('recién entrado a cocina (0ms) → dentro del plazo', () => {
    expect(dentroDePlazoModificacionCocina(0)).toBe(true);
  });

  it('a los 14 minutos → todavía dentro del plazo', () => {
    expect(dentroDePlazoModificacionCocina(14 * 60 * 1000)).toBe(true);
  });

  it('a los 15 minutos exactos → ya fuera del plazo (límite exclusivo)', () => {
    expect(dentroDePlazoModificacionCocina(15 * 60 * 1000)).toBe(false);
  });

  it('a los 20 minutos → fuera del plazo', () => {
    expect(dentroDePlazoModificacionCocina(20 * 60 * 1000)).toBe(false);
  });

  it('sin timestamp (fila pre-migración) → no bloqueamos (fail-open)', () => {
    expect(dentroDePlazoModificacionCocina(null)).toBe(true);
  });
});

// Detección del 429 que dispara el fallback de modelo. Es la señal de "modelo
// sin cuota"; un falso negativo dejaría al cliente sin respuesta en vez de saltar
// al siguiente modelo, así que cubrimos las dos formas del error (statusCode y
// texto crudo, como el que devuelve Groq al agotar el TPD).
describe('esRateLimit', () => {
  it('detecta por statusCode 429 (APICallError del SDK)', () => {
    expect(esRateLimit({ statusCode: 429, message: 'lo que sea' })).toBe(true);
  });
  it('detecta el mensaje crudo de TPD de Groq aunque no venga statusCode', () => {
    const err = new Error(
      'Rate limit reached for model `openai/gpt-oss-20b` ... on tokens per day (TPD): Limit 200000, Used 199159',
    );
    expect(esRateLimit(err)).toBe(true);
  });
  it('detecta "429" suelto en el mensaje', () => {
    expect(esRateLimit(new Error('request failed with status 429'))).toBe(true);
  });
  it('un error de validación (400) NO es rate limit → se reintenta el mismo modelo', () => {
    expect(esRateLimit({ statusCode: 400, message: 'json_validate_failed' })).toBe(false);
  });
  it('un error cualquiera sin señales de cuota no es rate limit', () => {
    expect(esRateLimit(new Error('ECONNRESET'))).toBe(false);
    expect(esRateLimit(null)).toBe(false);
    expect(esRateLimit(undefined)).toBe(false);
  });
});

// Red determinista que veta la señal `cantidad_sin_tipo` del modelo: si el cliente
// SÍ dijo el tipo, no hay nada que preguntar.
describe('mencionaTipoHelado', () => {
  it('detecta el tipo dicho de cualquier forma', () => {
    expect(mencionaTipoHelado('quiero 20 de agua')).toBe(true);
    expect(mencionaTipoHelado('50 helados de crema')).toBe(true);
    expect(mencionaTipoHelado('10 de AGUA y 5 de Crema')).toBe(true);
    expect(mencionaTipoHelado('los quiero al agua')).toBe(true);
    expect(mencionaTipoHelado('20 cremas')).toBe(true);
  });

  it('no confunde un sabor que contiene la palabra de un tipo con el tipo', () => {
    // "Crema del Cielo" es un sabor DE AGUA: nombrarlo no es decir el tipo.
    expect(mencionaTipoHelado('quiero 30 de crema del cielo')).toBe(false);
    expect(mencionaTipoHelado('30 de Crema del Cielo')).toBe(false);
    // ...pero si además dice el tipo, sí cuenta.
    expect(mencionaTipoHelado('30 de agua, de crema del cielo')).toBe(true);
  });

  it('devuelve false cuando el cliente no dijo el tipo', () => {
    expect(mencionaTipoHelado('quiero 50 helados de frutilla')).toBe(false);
    expect(mencionaTipoHelado('mandame 20 helados')).toBe(false);
    expect(mencionaTipoHelado(null)).toBe(false);
    expect(mencionaTipoHelado('')).toBe(false);
  });
});

describe('elegirRespuestaDatosFaltantes con el tipo sin definir', () => {
  it('cantidad sin tipo → botones agua/crema con la cantidad, no "me falta la cantidad"', () => {
    const r = elegirRespuestaDatosFaltantes(true, true, true, 0, false, false, 50);
    expect(r.tipo).toBe('botones_tipo_helado');
    if (r.tipo === 'botones_tipo_helado') {
      expect(r.cantidad).toBe(50);
      // El texto determinista (piso si falla la redacción libre) repite la cantidad.
      expect(r.mensaje).toContain('50');
      expect(r.mensaje).toMatch(/agua o de crema/);
      expect(r.mensaje).not.toContain('Dirección de envío');
    }
  });

  it('tiene prioridad sobre los demás faltantes, pero solo si falta la cantidad', () => {
    // Si el merge ya dejó cantidad cargada, no hay tipo que preguntar.
    expect(elegirRespuestaDatosFaltantes(false, false, true, 0, false, false, 50).tipo).toBe('botones_pago');
    expect(elegirRespuestaDatosFaltantes(false, true, false, 0, false, false, 50).tipo).toBe('boton_retira');
  });

  it('la unidad no soportada gana: sin unidades no hay número para ningún tipo', () => {
    const r = elegirRespuestaDatosFaltantes(true, false, false, 0, true, false, 2);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') expect(r.mensaje).toMatch(/por unidad/i);
  });

  it('sin señal se comporta igual que antes (pide la cantidad como texto)', () => {
    expect(elegirRespuestaDatosFaltantes(true, true, true, 0, false, false, 0).tipo).toBe('texto');
  });
});

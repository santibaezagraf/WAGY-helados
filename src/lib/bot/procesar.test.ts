import { describe, it, expect } from 'vitest';
import {
  aplicarOperacionCantidad,
  aplicarOperacionAclaracion,
  resolverAclaracion,
  aplicarOperacionObs,
  leerSlots,
  reconstruirObservaciones,
  pareceDireccion,
  normalizarTextoShortCircuit,
  intentarShortCircuit,
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

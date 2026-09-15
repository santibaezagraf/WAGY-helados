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
  cantidadVieneDeUnidadNoSoportada,
  mencionaMetodoPagoNoSoportado,
  normalizarTextoShortCircuit,
  intentarShortCircuit,
  elegirRespuestaDatosFaltantes,
  estaDespachado,
  dentroDePlazoModificacionCocina,
  esRateLimit,
  esModeloInexistente,
  clasificarFalloExtraccion,
  esPreguntaNegocioReal,
  mencionaTipoHelado,
  normalizarMetodoPago,
  mencionaConfirmacion,
  traeSenalDeConfirmacion,
  detectarCantidadPelada,
  detectarDeltaPelado,
  traeDatosDePedido,
  intencionesValidasPara,
  clampIntencionPorEstado,
  limpiarSaboresNoValidos,
  detectarSaborDescartadoPorFormato,
  colaSaborPendiente,
  construirCambiosPendientes,
  esConfirmacionRetoricaDeCambio,
  CONFIRMACIONES,
  NEGACIONES,
  SALUDOS,
  type PedidoActivoContext,
  type PedidoIA,
} from './procesar';
import { SABORES } from '@/lib/precios-publico';

// Helper: arma un PedidoIA completo "neutro" (todo en mantener, sin datos) para
// que cada test solo declare el campo que le importa.
function ia(extra: Partial<PedidoIA> = {}): PedidoIA {
  return {
    intencion: 'datos_pedido',
    direccion: null,
    aclaracion: null,
    aclaracion_operacion: 'mantener',
    cantidad_agua: 0,
    cantidad_agua_operacion: 'mantener',
    cantidad_crema: 0,
    cantidad_crema_operacion: 'mantener',
    cantidad_sin_tipo: 0,
    obs_agua: null,
    obs_agua_operacion: 'mantener',
    obs_crema: null,
    obs_crema_operacion: 'mantener',
    obs_general: null,
    obs_general_operacion: 'mantener',
    metodo_pago: null,
    pregunta_negocio: null,
    // Campos que TS agrega al schema del modelo (los calcula el flujo, no la IA).
    observaciones: null,
    observaciones_detalle: { agua: null, crema: null, general: null },
    datos_completos: false,
    ...extra,
  };
}

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

  it('faltan los tres → encabezado de bienvenida (ronda por defecto = variante histórica)', () => {
    const r = elegirRespuestaDatosFaltantes(true, true, true);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') {
      expect(r.mensaje).toContain('¿Qué te gustaría pedir?');
      expect(r.mensaje).toContain('Cantidades de helado');
      expect(r.mensaje).toContain('Dirección de envío');
      expect(r.mensaje).toContain('Forma de pago');
    }
  });

  it('faltan los tres → el saludo varía con la ronda, pero los 3 ítems no (#4)', () => {
    const encabezado = (ronda: number) => {
      const r = elegirRespuestaDatosFaltantes(true, true, true, ronda);
      // Primera línea = saludo; el resto son los bullets.
      return r.tipo === 'texto' ? r.mensaje.split('\n')[0] : '';
    };
    // Rondas distintas dan encabezados distintos.
    expect(encabezado(0)).not.toBe(encabezado(1));
    expect(encabezado(1)).not.toBe(encabezado(2));
    // Misma ronda → mismo encabezado (determinista, sin Math.random).
    expect(encabezado(5)).toBe(encabezado(5));
    // Sea cual sea el saludo, los 3 datos siempre están.
    for (const ronda of [0, 1, 2, 7, 13]) {
      const r = elegirRespuestaDatosFaltantes(true, true, true, ronda);
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

  // Regresión (2026-08-28): con Gemini el fallback NO se disparaba. El AI SDK
  // envuelve los reintentos en AI_RetryError, cuyo statusCode es undefined y que
  // guarda el 429 real en `lastError`; además el texto de Google no dice "rate
  // limit" sino "exceeded your current quota" (el único "rate-limits" está con
  // guion, dentro de la URL de doc). Mirando solo el error de arriba daba false y
  // el cliente recibía "no te entendí" con la cadena entera todavía disponible.
  it('detecta el 429 ANIDADO en lastError de un AI_RetryError (forma real de Gemini)', () => {
    const err = Object.assign(new Error('Failed after 3 attempts. Last error: quota'), {
      name: 'AI_RetryError',
      statusCode: undefined,
      lastError: { statusCode: 429, message: 'You exceeded your current quota' },
    });
    expect(esRateLimit(err)).toBe(true);
  });
  it('detecta el 429 anidado en `cause` (otra forma de envoltura del SDK)', () => {
    const err = Object.assign(new Error('algo salió mal'), {
      cause: { statusCode: 429, message: 'RESOURCE_EXHAUSTED' },
    });
    expect(esRateLimit(err)).toBe(true);
  });
  it('detecta la redacción de cuota de Google aunque no diga "rate limit" ni traiga statusCode', () => {
    const err = new Error(
      'You exceeded your current quota. * Quota exceeded for metric: ' +
        'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20',
    );
    expect(esRateLimit(err)).toBe(true);
  });
  it('no entra en loop infinito si `cause` se apunta a sí mismo', () => {
    const err: { message: string; cause?: unknown } = { message: 'boom' };
    err.cause = err;
    expect(esRateLimit(err)).toBe(false);
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

  it('tiene prioridad sobre los demás faltantes, incluso con cantidad ya cargada', () => {
    // CAMBIO DE CONTRATO (informe 32740622175): antes esta señal se ignoraba si no
    // faltaba la cantidad, porque solo se generaba en pedidos sin cantidad alguna.
    // Ahora también llega cuando el cliente corrige con un número pelado sobre un
    // pedido con los DOS tipos cargados ("mejor que sean 30"): ahí tampoco se puede
    // adivinar el tipo, así que preguntar gana sobre pedir el resto de los datos.
    // El gate de "¿es ambiguo de verdad?" vive en el caller, que calcula cantidadSinTipo.
    expect(elegirRespuestaDatosFaltantes(false, false, true, 0, false, false, 50).tipo).toBe('botones_tipo_helado');
    expect(elegirRespuestaDatosFaltantes(false, true, false, 0, false, false, 50).tipo).toBe('botones_tipo_helado');
    // Sin señal de ambigüedad, el resto de los faltantes se comporta igual que antes.
    expect(elegirRespuestaDatosFaltantes(false, false, true, 0, false, false, 0).tipo).toBe('botones_pago');
    expect(elegirRespuestaDatosFaltantes(false, true, false, 0, false, false, 0).tipo).toBe('boton_retira');
  });

  it('la operación viaja: un delta pelado pide sumar/sacar, no reemplazar', () => {
    // "sumale 10" ambiguo de tipo → el texto pregunta por lo que se SUMA, y la
    // operación queda en el objeto para que el caller arme el id resp_tipo_*_sumar_10.
    const suma = elegirRespuestaDatosFaltantes(false, false, false, 0, false, false, 10, 'sumar');
    expect(suma.tipo).toBe('botones_tipo_helado');
    if (suma.tipo === 'botones_tipo_helado') {
      expect(suma.operacion).toBe('sumar');
      expect(suma.mensaje).toContain('10');
      expect(suma.mensaje).toMatch(/sumar/i);
    }
    const resta = elegirRespuestaDatosFaltantes(false, false, false, 0, false, false, 4, 'restar');
    if (resta.tipo === 'botones_tipo_helado') {
      expect(resta.operacion).toBe('restar');
      expect(resta.mensaje).toMatch(/sacar/i);
    }
    // Reemplazo (default): el texto histórico, sin verbo de delta.
    const reemplazo = elegirRespuestaDatosFaltantes(false, false, false, 0, false, false, 50);
    if (reemplazo.tipo === 'botones_tipo_helado') {
      expect(reemplazo.operacion).toBe('reemplazar');
      expect(reemplazo.mensaje).toMatch(/agua o de crema/);
      expect(reemplazo.mensaje).not.toMatch(/sumar|sacar/i);
    }
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

// ---------------------------------------------------------------------------
// Redes deterministas agregadas a partir del informe nightly 32740622175.
// ---------------------------------------------------------------------------

describe('aplicarOperacionCantidad — contrato de "mantener" con valor', () => {
  // Documenta el comportamiento que causó el hallazgo #3: cuando el modelo
  // devuelve la combinación incoherente mantener+valor, el literal se DESCARTA.
  // Recuperarlo es tarea de detectarCantidadPelada, no de esta función pura
  // (que no tiene contexto para decidir a qué tipo pertenece el número).
  it('mantener descarta el literal aunque no sea 0', () => {
    expect(aplicarOperacionCantidad('mantener', 30, 20)).toBe(20);
  });
});

describe('mencionaConfirmacion', () => {
  it('atrapa el caso real del informe', () => {
    expect(mencionaConfirmacion('Sí, confirmá.')).toBe(true);
  });
  it('atrapa la confirmación mezclada con otras palabras', () => {
    expect(mencionaConfirmacion('dale, confirmalo por favor')).toBe(true);
    expect(mencionaConfirmacion('listo, confirmame el pedido')).toBe(true);
    expect(mencionaConfirmacion('ok confirmar')).toBe(true);
  });
  it('NO confunde una negación con una confirmación', () => {
    expect(mencionaConfirmacion('no confirmes todavía')).toBe(false);
    expect(mencionaConfirmacion('no, no lo confirmo')).toBe(false);
    expect(mencionaConfirmacion('todavía no confirmo nada')).toBe(false);
  });
  it('NO confunde una pregunta con una confirmación', () => {
    expect(mencionaConfirmacion('¿cuándo confirmás?')).toBe(false);
    expect(mencionaConfirmacion('cómo confirmo?')).toBe(false);
  });
  it('no dispara si no hay verbo de confirmar', () => {
    expect(mencionaConfirmacion('dale')).toBe(false);
    expect(mencionaConfirmacion('20 de crema')).toBe(false);
    expect(mencionaConfirmacion(null)).toBe(false);
  });
});

describe('detectarCantidadPelada', () => {
  it('atrapa los dos mensajes reales del informe', () => {
    expect(detectarCantidadPelada('son 30 ahora')).toBe(30);
    expect(detectarCantidadPelada('che, se me va la mano, son 40')).toBe(40);
  });
  it('el veto de delta es LOCAL: un "mas" en otra oración no bloquea', () => {
    // Este es EL caso del informe. Un veto global lo mataría.
    expect(detectarCantidadPelada('espera un toque, me pidieron mas. son 30 ahora')).toBe(30);
  });
  it('reconoce otras formas de reemplazo', () => {
    expect(detectarCantidadPelada('que sean 30')).toBe(30);
    expect(detectarCantidadPelada('ponele 25')).toBe(25);
    expect(detectarCantidadPelada('mejor 50')).toBe(50);
    expect(detectarCantidadPelada('30 en total')).toBe(30);
  });
  it('NO dispara ante un delta explícito pegado al número', () => {
    expect(detectarCantidadPelada('sumale 30')).toBeNull();
    expect(detectarCantidadPelada('que sean 5 más')).toBeNull();
    expect(detectarCantidadPelada('quitale 3')).toBeNull();
  });
  it('NO confunde números de una dirección o aclaración', () => {
    expect(detectarCantidadPelada('depto 6')).toBeNull();
    expect(detectarCantidadPelada('es el piso 3')).toBeNull();
  });
  it('NO confunde unidades que no vendemos', () => {
    expect(detectarCantidadPelada('que sean 2 kilos')).toBeNull();
    expect(detectarCantidadPelada('ponele 3 bolas')).toBeNull();
  });
  it('NO confunde un desglose por sabores', () => {
    expect(detectarCantidadPelada('que sean 10 de frutilla y 5 de menta')).toBeNull();
  });
  it('sin pista de cantidad no inventa un número', () => {
    expect(detectarCantidadPelada('gracias 30')).toBeNull();
    expect(detectarCantidadPelada('hola')).toBeNull();
    expect(detectarCantidadPelada(null)).toBeNull();
  });
});

describe('detectarDeltaPelado', () => {
  it('atrapa el caso real: "sumale 10" sin tipo → delta sumar', () => {
    expect(detectarDeltaPelado('sumale 10')).toEqual({ operacion: 'sumar', valor: 10 });
  });
  it('reconoce otras formas de sumar', () => {
    expect(detectarDeltaPelado('agregale 5')).toEqual({ operacion: 'sumar', valor: 5 });
    expect(detectarDeltaPelado('otros 20')).toEqual({ operacion: 'sumar', valor: 20 });
    expect(detectarDeltaPelado('5 mas')).toEqual({ operacion: 'sumar', valor: 5 });
  });
  it('reconoce las formas de restar', () => {
    expect(detectarDeltaPelado('sacale 3')).toEqual({ operacion: 'restar', valor: 3 });
    expect(detectarDeltaPelado('quitale 4')).toEqual({ operacion: 'restar', valor: 4 });
    expect(detectarDeltaPelado('bajale 2')).toEqual({ operacion: 'restar', valor: 2 });
  });
  it('la resta gana si aparecen las dos pistas', () => {
    expect(detectarDeltaPelado('sacale 5, no le sumes')).toEqual({ operacion: 'restar', valor: 5 });
  });
  it('es LOCAL por cláusula, igual que detectarCantidadPelada', () => {
    // El número del delta está en su propia cláusula; el resto no lo contamina.
    expect(detectarDeltaPelado('ok, dale, sumale 15')).toEqual({ operacion: 'sumar', valor: 15 });
  });
  it('NO confunde números de dirección/aclaración ni unidades', () => {
    expect(detectarDeltaPelado('sumale al depto 3')).toBeNull();
    expect(detectarDeltaPelado('sumale 2 kilos')).toBeNull();
  });
  it('NO dispara sin una pista de delta (eso es un reemplazo, otra red)', () => {
    expect(detectarDeltaPelado('son 30 ahora')).toBeNull();
    expect(detectarDeltaPelado('que sean 30')).toBeNull();
    expect(detectarDeltaPelado('10')).toBeNull();
  });
  it('NO confunde un desglose por sabores', () => {
    expect(detectarDeltaPelado('sumale 10 de frutilla y 5 de menta')).toBeNull();
  });
  it('sin texto no inventa nada', () => {
    expect(detectarDeltaPelado('')).toBeNull();
    expect(detectarDeltaPelado(null)).toBeNull();
  });
});

describe('traeDatosDePedido', () => {
  it('detecta el pago aunque sea lo único que trae (caso del informe)', () => {
    expect(traeDatosDePedido(ia({ metodo_pago: 'transferencia' }))).toBe(true);
  });
  it('detecta una operación de cantidad', () => {
    expect(traeDatosDePedido(ia({ cantidad_crema: 20, cantidad_crema_operacion: 'reemplazar' }))).toBe(true);
  });
  it('detecta el retiro cuando el modelo puso el sentinela', () => {
    expect(traeDatosDePedido(ia({ direccion: 'retira' }))).toBe(true);
  });
  it('detecta dirección y sabores', () => {
    expect(traeDatosDePedido(ia({ direccion: 'Mitre 951' }))).toBe(true);
    expect(traeDatosDePedido(ia({ obs_crema: 'chocolate', obs_crema_operacion: 'agregar' }))).toBe(true);
  });
  it('una consulta PURA no trae datos', () => {
    expect(traeDatosDePedido(
      ia({ intencion: 'consulta_negocio', pregunta_negocio: 'hasta que hora entregan?' }),
    )).toBe(false);
  });
  it('una PREGUNTA sobre retirar no cuenta como dato del pedido', () => {
    // No mira el texto crudo a propósito: "¿tengo que retirar o hacen envío?" es una
    // consulta pura. Contarla como dato le seteaba direccion="retira" a un cliente
    // que nunca lo pidió — falso positivo en la dirección peligrosa.
    expect(traeDatosDePedido(
      ia({ intencion: 'consulta_negocio', pregunta_negocio: 'tengo que retirar o hacen envio?' }),
    )).toBe(false);
  });
  it('el placeholder "null" del modelo no cuenta como pago', () => {
    expect(traeDatosDePedido(ia({ metodo_pago: 'null' }))).toBe(false);
  });
});

describe('intencionesValidasPara / clampIntencionPorEstado', () => {
  it('borrador ofrece confirmar pero no las de cancelación en curso', () => {
    const v = intencionesValidasPara('borrador');
    expect(v).toContain('confirmar');
    expect(v).not.toContain('confirmar_cancelacion');
    expect(v).not.toContain('rechazar_cancelacion');
  });
  it('esperando_cancelacion ofrece el sí/no pero no confirmar el pedido', () => {
    const v = intencionesValidasPara('esperando_cancelacion');
    expect(v).toContain('confirmar_cancelacion');
    expect(v).toContain('rechazar_cancelacion');
    expect(v).not.toContain('confirmar');
  });
  it('reactivar solo se ofrece si hay un pedido cancelado reciente', () => {
    expect(intencionesValidasPara(null)).not.toContain('reactivar');
    expect(intencionesValidasPara(null, { hayPedidoCanceladoReciente: true })).toContain('reactivar');
  });

  it('acota la intención HUÉRFANA que causó el loop del hallazgo #1', () => {
    // confirmar_cancelacion en borrador no tiene handler: el único vive dentro
    // del bloque de esperando_cancelacion. Sin el clamp caía al fallback y el
    // bot reenviaba el mismo resumen para siempre.
    expect(clampIntencionPorEstado('confirmar_cancelacion', 'borrador')).toBe('datos_pedido');
    expect(clampIntencionPorEstado('rechazar_cancelacion', 'borrador')).toBe('datos_pedido');
  });
  it('acota confirmar en esperando_cancelacion (no lo convierte en cancelar)', () => {
    expect(clampIntencionPorEstado('confirmar', 'esperando_cancelacion')).toBe('datos_pedido');
  });
  it('acota confirmar cuando el pedido ya está en cocina', () => {
    expect(clampIntencionPorEstado('confirmar', 'pendiente')).toBe('datos_pedido');
  });
  it('deja pasar intacta una intención válida', () => {
    expect(clampIntencionPorEstado('confirmar', 'borrador')).toBe('confirmar');
    expect(clampIntencionPorEstado('confirmar_cancelacion', 'esperando_cancelacion')).toBe('confirmar_cancelacion');
    expect(clampIntencionPorEstado('datos_pedido', null)).toBe('datos_pedido');
  });
});

describe('sets del short-circuit', () => {
  // El match es whole-message EXACTO contra el texto ya normalizado, así que una
  // entrada con tilde, mayúscula o puntuación nunca puede matchear: sería código
  // muerto. Es el modo de falla que dejó pasar "Sí, confirmá." (hallazgo #1).
  it('toda entrada está en forma normalizada', () => {
    for (const set of [CONFIRMACIONES, NEGACIONES, SALUDOS]) {
      for (const entrada of set) {
        expect(normalizarTextoShortCircuit(entrada)).toBe(entrada);
      }
    }
  });
  it('el imperativo voseo ahora entra por short-circuit', () => {
    expect(intentarShortCircuit('Sí, confirmá.', 'borrador')).toBe('confirmar');
    expect(intentarShortCircuit('confirmalo', 'borrador')).toBe('confirmar');
  });
  it('confirmaciones y negaciones no se pisan', () => {
    for (const c of CONFIRMACIONES) expect(NEGACIONES.has(c)).toBe(false);
  });
});

describe('traeSenalDeConfirmacion (veto de confirmación fantasma)', () => {
  it('acepta el verbo confirmar y las afirmaciones sueltas', () => {
    expect(traeSenalDeConfirmacion('sí, confirmá.')).toBe(true);
    expect(traeSenalDeConfirmacion('dale')).toBe(true);
    expect(traeSenalDeConfirmacion('sí, 20 de crema retiro efectivo')).toBe(true);
    expect(traeSenalDeConfirmacion('listo, mandalo')).toBe(true);
  });
  it('repetir el pedido NO es una señal de confirmación', () => {
    // El caso real: con el resumen pendiente, el cliente repite su pedido textual
    // y el modelo lo lee como "confirmar". Repetir no es confirmar.
    expect(traeSenalDeConfirmacion('ola, 20 de crema de chocolate, paso a retirar, efectivo')).toBe(false);
    expect(traeSenalDeConfirmacion('20 de crema a Mitre 951, transferencia')).toBe(false);
  });
  it('NO cuenta palabras ambiguas que aparecen naturalmente en una oración', () => {
    // Un falso positivo acá DESACTIVA el veto, que es la dirección peligrosa.
    expect(traeSenalDeConfirmacion('20 de crema, va con efectivo')).toBe(false);
    expect(traeSenalDeConfirmacion('esta bueno el helado de vainilla? mandame 10')).toBe(false);
  });
  it('no dispara con texto vacío', () => {
    expect(traeSenalDeConfirmacion('')).toBe(false);
    expect(traeSenalDeConfirmacion(null)).toBe(false);
  });
});

describe('elegirRespuestaDatosFaltantes — unidad no soportada con pedido completo', () => {
  it('explica que vendemos por unidad aunque no falte ningún dato', () => {
    // Caso real de pruebas manuales: borrador completo (40 de crema, dirección,
    // pago) y el cliente escribe "que sean 2 kilos". Antes la explicación estaba
    // gateada por faltaCantidad, así que con el pedido completo nunca se alcanzaba
    // y el mensaje caía al fallback ("no te entendí"), sin explicar nada.
    const r = elegirRespuestaDatosFaltantes(false, false, false, 0, true, false, 0);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') {
      expect(r.mensaje).toMatch(/por unidad/i);
      expect(r.mensaje).toMatch(/cuántas unidades/i);
    }
  });
  it('sigue explicándolo cuando además falta la cantidad (comportamiento previo)', () => {
    const r = elegirRespuestaDatosFaltantes(true, false, false, 0, true, false, 0);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') expect(r.mensaje).toMatch(/por unidad/i);
  });
  it('si además falta la dirección, cae a la lista y la pide', () => {
    const r = elegirRespuestaDatosFaltantes(true, true, false, 0, true, false, 0);
    expect(r.tipo).toBe('texto');
    if (r.tipo === 'texto') expect(r.mensaje).toMatch(/Dirección de envío/);
  });
});

describe('cantidadVieneDeUnidadNoSoportada', () => {
  it('vetea el número cuando sale de una expresión en kilos (caso real)', () => {
    // Con 40 de crema cargados, el modelo devolvió `reemplazar 2` para "que sean
    // 2 kilos" y el pedido pasó de 40 unidades a 2. Corrupción silenciosa.
    expect(cantidadVieneDeUnidadNoSoportada('que sean 2 kilos', 2)).toBe(true);
    expect(cantidadVieneDeUnidadNoSoportada('mandame 3 potes', 3)).toBe(true);
    expect(cantidadVieneDeUnidadNoSoportada('una porcion con 2 bolas', 2)).toBe(true);
    expect(cantidadVieneDeUnidadNoSoportada('medio kilo, tipo 500 gramos', 500)).toBe(true);
  });
  it('el veto es POR CLÁUSULA: conserva un dato válido dicho aparte', () => {
    // Los 30 son unidades legítimas; el "2 kilos" está en otra cláusula.
    expect(cantidadVieneDeUnidadNoSoportada('que sean 30 unidades, no 2 kilos', 30)).toBe(false);
    expect(cantidadVieneDeUnidadNoSoportada('que sean 30 unidades, no 2 kilos', 2)).toBe(true);
  });
  it('no vetea cuando no hay unidad rara', () => {
    expect(cantidadVieneDeUnidadNoSoportada('que sean 30', 30)).toBe(false);
    expect(cantidadVieneDeUnidadNoSoportada('40 de crema a Mitre 951', 40)).toBe(false);
  });
  it('no vetea un número distinto del que aparece con la unidad', () => {
    expect(cantidadVieneDeUnidadNoSoportada('que sean 2 kilos', 40)).toBe(false);
  });
  it('tolera entradas vacías o inválidas', () => {
    expect(cantidadVieneDeUnidadNoSoportada(null, 2)).toBe(false);
    expect(cantidadVieneDeUnidadNoSoportada('que sean 2 kilos', 0)).toBe(false);
  });
});

describe('limpiarSaboresNoValidos', () => {
  it('descarta un texto que es SOLO formato (el caso que corrompía el pedido)', () => {
    // Caso real de la corrida 34900965360: "20 palitos de crema" dejó
    // `observaciones: "palitos"` en el pedido, y el cliente lo reclamó 3 veces.
    expect(limpiarSaboresNoValidos('palitos')).toBeNull();
    expect(limpiarSaboresNoValidos('palitos de crema')).toBeNull();
    expect(limpiarSaboresNoValidos('helados')).toBeNull();
    expect(limpiarSaboresNoValidos('paletas de agua')).toBeNull();
    expect(limpiarSaboresNoValidos('bombones')).toBeNull();
  });

  it('conserva el sabor y saca solo el formato', () => {
    expect(limpiarSaboresNoValidos('palitos de frutilla')).toBe('frutilla');
    expect(limpiarSaboresNoValidos('sabor chocolate')).toBe('chocolate');
    expect(limpiarSaboresNoValidos('20 helados de vainilla')).toBe('20 de vainilla');
  });

  it('no toca un texto de sabores normal', () => {
    expect(limpiarSaboresNoValidos('frutilla')).toBe('frutilla');
    expect(limpiarSaboresNoValidos('10 de frutilla y 5 de limón')).toBe('10 de frutilla y 5 de limón');
    expect(limpiarSaboresNoValidos('dulce de leche')).toBe('dulce de leche');
  });

  it('protege los sabores del catálogo que contienen una palabra de tipo', () => {
    // "Crema del Cielo" es un sabor DE AGUA: ese "crema"/"del" no es designación
    // de tipo. Mismo cuidado que `mencionaTipoHelado`.
    expect(limpiarSaboresNoValidos('crema del cielo')).toBe('crema del cielo');
    expect(limpiarSaboresNoValidos('palitos de crema del cielo')).toBe('crema del cielo');
  });

  it('conserva un sabor que NO está en el catálogo (solo se veta una lista cerrada)', () => {
    // La dirección peligrosa es borrar un dato real del cliente, no dejar pasar
    // un sabor raro: eso lo resuelve una persona mirando el pedido.
    expect(limpiarSaboresNoValidos('menta granizada')).toBe('menta granizada');
    expect(limpiarSaboresNoValidos('crema americana')).toBe('crema americana');
  });

  it('no deja restos sin sabor (números o conectores sueltos)', () => {
    expect(limpiarSaboresNoValidos('10 palitos')).toBeNull();
    expect(limpiarSaboresNoValidos('de los helados')).toBeNull();
    expect(limpiarSaboresNoValidos('   ')).toBeNull();
    expect(limpiarSaboresNoValidos(null)).toBeNull();
  });

  it('conserva detalles generales que no son sabores ni formatos', () => {
    expect(limpiarSaboresNoValidos('sin coco')).toBe('sin coco');
    expect(limpiarSaboresNoValidos('todos sin azúcar')).toBe('todos sin azúcar');
  });
});

describe('detectarSaborDescartadoPorFormato', () => {
  const base = {
    obs_agua: null, obs_agua_operacion: 'mantener' as const,
    obs_crema: null, obs_crema_operacion: 'mantener' as const,
  };

  it('detecta el tipo cuyo "sabor" era solo formato', () => {
    expect(detectarSaborDescartadoPorFormato(
      { ...base, obs_crema: 'palitos', obs_crema_operacion: 'reemplazar' }, 0, 20,
    )).toBe('crema');
  });

  it('no dispara si el sabor era real', () => {
    expect(detectarSaborDescartadoPorFormato(
      { ...base, obs_crema: 'vainilla', obs_crema_operacion: 'reemplazar' }, 0, 20,
    )).toBeNull();
  });

  it('no dispara si ese tipo no tiene cantidad (no hay nada que saborizar)', () => {
    expect(detectarSaborDescartadoPorFormato(
      { ...base, obs_crema: 'palitos', obs_crema_operacion: 'reemplazar' }, 20, 0,
    )).toBeNull();
  });

  it('no dispara con la operación "mantener" ni "limpiar" (el cliente no dijo nada)', () => {
    expect(detectarSaborDescartadoPorFormato(
      { ...base, obs_crema: 'palitos', obs_crema_operacion: 'mantener' }, 0, 20,
    )).toBeNull();
    expect(detectarSaborDescartadoPorFormato(
      { ...base, obs_crema: 'palitos', obs_crema_operacion: 'limpiar' }, 0, 20,
    )).toBeNull();
  });

  it('con los DOS tipos ambiguos no pregunta nada (sería ruido)', () => {
    expect(detectarSaborDescartadoPorFormato({
      obs_agua: 'palitos', obs_agua_operacion: 'reemplazar',
      obs_crema: 'helados', obs_crema_operacion: 'reemplazar',
    }, 10, 20)).toBeNull();
  });
});

describe('colaSaborPendiente', () => {
  it('lista los sabores del tipo pendiente', () => {
    const cola = colaSaborPendiente('crema');
    expect(cola).toContain('los de crema');
    for (const sabor of SABORES.crema) expect(cola).toContain(sabor);
    // No mezcla los del otro tipo.
    expect(cola).not.toContain('Uva');
  });

  it('es vacía cuando no hay nada pendiente', () => {
    expect(colaSaborPendiente(null)).toBe('');
  });
});

describe('construirCambiosPendientes', () => {
  it('describe la dirección nueva para que la consulta acotada pueda contestarla', () => {
    // Caso real de la corrida 34900965360: el pedido ya estaba confirmado y el
    // cliente mandó dirección nueva + "Me los mandan ahí no?". El contexto veía
    // la dirección VIEJA (este bloque corre antes del merge), así que la pregunta
    // era incontestable y se delegaba.
    const cambios = construirCambiosPendientes(
      ia({ direccion: 'Av. Corrientes 5678', aclaracion: '2A' }),
      pa({ direccion: 'Av. Rivadavia 1234', cantidad_agua: 24 }),
    );
    expect(cambios.join('\n')).toMatch(/Av\. Corrientes 5678 \(2A\)/);
    expect(cambios.join('\n')).toMatch(/se va a entregar AHÍ/);
  });

  it('marca el paso a retiro', () => {
    const cambios = construirCambiosPendientes(
      ia({ direccion: 'retira' }),
      pa({ direccion: 'Mitre 951' }),
    );
    expect(cambios.join('\n')).toMatch(/pasa a retirar/);
  });

  it('ignora una dirección que no parece dirección (la misma red que usa el flujo)', () => {
    // `pareceDireccion` corre DESPUÉS de este bloque en el flujo, así que si no se
    // validara acá, una aclaración ("depto 6") entraría al contexto como si fuera
    // la nueva dirección de entrega.
    expect(construirCambiosPendientes(ia({ direccion: 'depto 6' }), pa({}))).toEqual([]);
  });

  it('lista cantidades, pago y sabores cuando cambian', () => {
    const cambios = construirCambiosPendientes(
      ia({ cantidad_crema: 30, metodo_pago: 'transferencia', observaciones: 'los de crema vainilla' }),
      pa({ cantidad_crema: 20, metodo_pago: 'efectivo' }),
    );
    const texto = cambios.join('\n');
    expect(texto).toMatch(/crema: ahora son 30/);
    expect(texto).toMatch(/forma de pago: transferencia/);
    expect(texto).toMatch(/vainilla/);
  });

  it('es vacía cuando el mensaje no cambia nada del pedido', () => {
    expect(construirCambiosPendientes(
      ia({ cantidad_crema: 20, metodo_pago: 'efectivo' }),
      pa({ cantidad_crema: 20, metodo_pago: 'efectivo' }),
    )).toEqual([]);
  });
});

describe('esConfirmacionRetoricaDeCambio', () => {
  it('reconoce la muletilla sobre el cambio que se está aplicando', () => {
    expect(esConfirmacionRetoricaDeCambio('Me los mandan ahí no?')).toBe(true);
    expect(esConfirmacionRetoricaDeCambio('¿queda así entonces?')).toBe(true);
    expect(esConfirmacionRetoricaDeCambio('¿entonces son 30?')).toBe(true);
    expect(esConfirmacionRetoricaDeCambio('lo dejamos así, dale?')).toBe(true);
  });

  it('NO se traga una consulta real de cobertura, horario o demora', () => {
    // La dirección peligrosa: un falso positivo acá se come una consulta que sí
    // tiene que ver una persona. Estas tienen que seguir delegándose.
    expect(esConfirmacionRetoricaDeCambio('¿llegan hasta allá?')).toBe(false);
    expect(esConfirmacionRetoricaDeCambio('¿hasta qué hora hacen entregas?')).toBe(false);
    expect(esConfirmacionRetoricaDeCambio('¿cuánto tardan en llegar ahí?')).toBe(false);
    expect(esConfirmacionRetoricaDeCambio('¿tienen promo por esa cantidad?')).toBe(false);
    expect(esConfirmacionRetoricaDeCambio('¿hay stock de ese sabor?')).toBe(false);
    // El ✅ de la corrida: pedido + pregunta de zona en el mismo mensaje.
    expect(esConfirmacionRetoricaDeCambio('hasta qué hora hacen entregas porque vivo en el sur')).toBe(false);
  });

  it('NO dispara con una pregunta larga (no es una muletilla)', () => {
    expect(esConfirmacionRetoricaDeCambio(
      'che una consulta, si les pido eso ahora mismo y después me arrepiento lo puedo cambiar sin problema',
    )).toBe(false);
  });

  it('es falsa sin texto', () => {
    expect(esConfirmacionRetoricaDeCambio(null)).toBe(false);
    expect(esConfirmacionRetoricaDeCambio('   ')).toBe(false);
  });
});

describe('elegirRespuestaDatosFaltantes: rondas consecutivas (off-topic)', () => {
  const encabezado = (ronda: number) => {
    const r = elegirRespuestaDatosFaltantes(true, true, true, ronda);
    return r.tipo === 'texto' ? r.mensaje.split('\n')[0] : '';
  };

  it('nunca repite el encabezado en rondas consecutivas', () => {
    // El seed viejo era la suma de los largos del batch (un hash del contenido):
    // colisionaba, y en la corrida 34900965360 dos de los cuatro mensajes
    // off-topic recibieron el MISMO saludo. Con la ronda —que es una cuenta
    // monótona— eso no puede pasar.
    for (let ronda = 0; ronda < 8; ronda++) {
      expect(encabezado(ronda)).not.toBe(encabezado(ronda + 1));
    }
  });

  it('desde la tercera ronda deja de saludar y reconoce que viene repitiendo', () => {
    // Saludar "¡Hola! 👋" por cuarta vez es absurdo: el cliente viene escribiendo
    // hace rato. Es el criterio ⚠️ de tono de la rúbrica.
    expect(encabezado(0)).toMatch(/^¡Hola!|^¡Buenas!/);
    expect(encabezado(1)).toMatch(/^¡Hola!|^¡Buenas!/);
    for (const ronda of [2, 3, 4, 5]) {
      expect(encabezado(ronda)).not.toMatch(/^¡Hola!|^¡Buenas!/);
      expect(encabezado(ronda)).toMatch(/😅/);
    }
  });

  it('los 3 datos siguen estando en cualquier ronda (el fondo no cambia)', () => {
    for (const ronda of [0, 1, 2, 3, 7, 13]) {
      const r = elegirRespuestaDatosFaltantes(true, true, true, ronda);
      if (r.tipo === 'texto') {
        expect(r.mensaje).toContain('Cantidades de helado');
        expect(r.mensaje).toContain('Dirección de envío');
        expect(r.mensaje).toContain('Forma de pago');
      }
    }
  });

  it('con datos parciales NUNCA usa el texto de insistencia, por alta que sea la ronda', () => {
    // La rama de insistencia asume off-topic, y eso solo es seguro cuando faltan
    // los TRES datos: si el cliente aportó algo, el encabezado es el neutro.
    const r = elegirRespuestaDatosFaltantes(false, true, true, 9);
    if (r.tipo === 'texto') {
      expect(r.mensaje).toContain('Para armar tu pedido me falta:');
      expect(r.mensaje).not.toMatch(/😅/);
    }
  });
});

describe('esModeloInexistente', () => {
  it('detecta el 404 de Groq por modelo dado de baja (el caso de la corrida 34928105031)', () => {
    // Texto literal que devolvió Groq para qwen/qwen3.6-27b.
    expect(esModeloInexistente(new Error(
      'The model `qwen/qwen3.6-27b` does not exist or you do not have access to it.',
    ))).toBe(true);
  });

  it('detecta el formato de Google', () => {
    expect(esModeloInexistente(new Error(
      'models/gemini-2.5-flash is not found for API version v1beta',
    ))).toBe(true);
  });

  it('detecta por statusCode 404 aunque el texto no diga nada', () => {
    expect(esModeloInexistente({ statusCode: 404, message: 'Not Found' })).toBe(true);
  });

  it('atraviesa el AI_RetryError que envuelve el error real', () => {
    // Mismo motivo que en esRateLimit: el SDK envuelve los reintentos y deja el
    // error real en `lastError`; mirar solo el tope daba false.
    const envuelto = Object.assign(new Error('Failed after 3 attempts'), {
      name: 'AI_RetryError',
      lastError: Object.assign(new Error('The model `x` does not exist or you do not have access to it.'), { statusCode: 404 }),
    });
    expect(esModeloInexistente(envuelto)).toBe(true);
  });

  it('NO confunde un rate limit ni un error de validación con un modelo inexistente', () => {
    // Si se solapara con el 429 daría lo mismo (los dos saltan de modelo), pero un
    // error de validación NO debe saltar: ahí el reintento al mismo modelo es lo
    // correcto, porque es no-determinismo del modelo, no un id muerto.
    expect(esModeloInexistente(new Error('Rate limit reached for model x'))).toBe(false);
    expect(esModeloInexistente({ statusCode: 429, message: 'Too Many Requests' })).toBe(false);
    expect(esModeloInexistente(new Error('Type validation failed: value did not match schema'))).toBe(false);
    expect(esModeloInexistente(new Error('required property not found in response'))).toBe(false);
    expect(esModeloInexistente(null)).toBe(false);
  });

  it('no se cuelga con un ciclo de causes', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a;
    expect(esModeloInexistente(a)).toBe(false);
  });
});

describe('clasificarFalloExtraccion', () => {
  it('separa cuota de modelo muerto y de fallo real del bot', () => {
    // El harness usa esto para decidir si reintenta, si aborta, o si lo reporta
    // como regresión. Confundirlos es lo que hizo que el informe de la corrida
    // 34928105031 marcara una regresión inexistente.
    expect(clasificarFalloExtraccion({ statusCode: 429 })).toBe('sin_cuota');
    expect(clasificarFalloExtraccion(new Error('Rate limit reached'))).toBe('sin_cuota');
    expect(clasificarFalloExtraccion(new Error('The model `x` does not exist or you do not have access to it.')))
      .toBe('modelo_inexistente');
    expect(clasificarFalloExtraccion(new Error('Type validation failed'))).toBe('validacion');
  });

  it('ante un error desconocido asume fallo del bot, no infraestructura', () => {
    // Dirección segura: si no sabemos qué pasó, que se vea como problema del bot
    // y alguien lo mire, en vez de silenciarlo como "era la cuota".
    expect(clasificarFalloExtraccion(null)).toBe('validacion');
    expect(clasificarFalloExtraccion(new Error('boom'))).toBe('validacion');
  });
});

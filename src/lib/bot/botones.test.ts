import { describe, it, expect } from 'vitest';
import { parsearBotonId, parsearBotonTipoHelado, RESPUESTAS_RAPIDAS } from './botones';

// Función pura: parseo de button_id "<accion>_<pedidoId>". El resto de
// botones.ts es DB/red y no se testea acá.
describe('parsearBotonId', () => {
  it('parsea las cuatro acciones con su pedidoId', () => {
    expect(parsearBotonId('confirmar_borrador_123')).toEqual({ accion: 'confirmar_borrador', pedidoId: 123 });
    expect(parsearBotonId('modificar_borrador_7')).toEqual({ accion: 'modificar_borrador', pedidoId: 7 });
    expect(parsearBotonId('confirmar_cancelacion_45')).toEqual({ accion: 'confirmar_cancelacion', pedidoId: 45 });
    expect(parsearBotonId('rechazar_cancelacion_9')).toEqual({ accion: 'rechazar_cancelacion', pedidoId: 9 });
  });

  it('rechaza ids sin pedidoId numérico válido', () => {
    expect(parsearBotonId('confirmar_borrador_')).toBeNull();
    expect(parsearBotonId('confirmar_borrador_abc')).toBeNull();
    expect(parsearBotonId('confirmar_borrador_0')).toBeNull();
    expect(parsearBotonId('confirmar_borrador_-3')).toBeNull();
  });

  it('rechaza acciones desconocidas', () => {
    expect(parsearBotonId('borrar_todo_5')).toBeNull();
    expect(parsearBotonId('')).toBeNull();
  });

  it('las respuestas rápidas NUNCA se parsean como acciones de pedido', () => {
    // Si un id de RESPUESTAS_RAPIDAS matcheara acá, el webhook ejecutaría una
    // acción sobre un pedido en vez de rutear el click como texto.
    for (const id of Object.keys(RESPUESTAS_RAPIDAS)) {
      expect(parsearBotonId(id)).toBeNull();
    }
  });
});

describe('RESPUESTAS_RAPIDAS', () => {
  it('cada id mapea a un texto canónico no vacío', () => {
    for (const [id, texto] of Object.entries(RESPUESTAS_RAPIDAS)) {
      expect(id.startsWith('resp_')).toBe(true);
      expect(texto.trim().length).toBeGreaterThan(0);
    }
  });
});

// Botones de tipo de helado: el id lleva la cantidad, así que el parseo es lo que
// convierte el click en el texto canónico del pedido.
describe('parsearBotonTipoHelado', () => {
  it('parsea los ids de reemplazo (sin operación en el id), con su texto canónico', () => {
    expect(parsearBotonTipoHelado('resp_tipo_agua_50')).toEqual({ tipo: 'agua', cantidad: 50, operacion: 'reemplazar', texto: '50 de agua' });
    expect(parsearBotonTipoHelado('resp_tipo_crema_7')).toEqual({ tipo: 'crema', cantidad: 7, operacion: 'reemplazar', texto: '7 de crema' });
  });

  it('parsea los ids con operación (delta pelado): el texto canónico dice sumar/sacar', () => {
    // "sumale 10" ambiguo de tipo → botón resp_tipo_agua_sumar_10 → el texto que
    // vuelve por el pipeline es "sumale 10 de agua", que el modelo interpreta como
    // sumar (no reemplazar), así 40 → 50 en vez de 40 → 10.
    expect(parsearBotonTipoHelado('resp_tipo_agua_sumar_10')).toEqual({ tipo: 'agua', cantidad: 10, operacion: 'sumar', texto: 'sumale 10 de agua' });
    expect(parsearBotonTipoHelado('resp_tipo_crema_restar_5')).toEqual({ tipo: 'crema', cantidad: 5, operacion: 'restar', texto: 'sacale 5 de crema' });
  });

  it('rechaza ids sin cantidad válida (no inventa un pedido de 0)', () => {
    expect(parsearBotonTipoHelado('resp_tipo_agua_')).toBeNull();
    expect(parsearBotonTipoHelado('resp_tipo_agua_0')).toBeNull();
    expect(parsearBotonTipoHelado('resp_tipo_agua_-5')).toBeNull();
    expect(parsearBotonTipoHelado('resp_tipo_agua_dos')).toBeNull();
    expect(parsearBotonTipoHelado('resp_tipo_agua_2.5')).toBeNull();
    expect(parsearBotonTipoHelado('resp_tipo_agua_sumar_')).toBeNull();
    expect(parsearBotonTipoHelado('resp_tipo_agua_sumar_0')).toBeNull();
    expect(parsearBotonTipoHelado('resp_tipo_crema_restar_dos')).toBeNull();
  });

  it('rechaza ids de otras familias (respuestas rápidas y acciones de pedido)', () => {
    for (const id of Object.keys(RESPUESTAS_RAPIDAS)) {
      expect(parsearBotonTipoHelado(id)).toBeNull();
    }
    expect(parsearBotonTipoHelado('confirmar_borrador_123')).toBeNull();
    expect(parsearBotonTipoHelado('')).toBeNull();
  });

  it('los botones de tipo NUNCA se parsean como acciones de pedido', () => {
    // Misma invariante que las respuestas rápidas: una colisión ejecutaría una
    // mutación del pedido en vez de rutear el click como texto.
    expect(parsearBotonId('resp_tipo_agua_50')).toBeNull();
    expect(parsearBotonId('resp_tipo_crema_50')).toBeNull();
    expect(parsearBotonId('resp_tipo_agua_sumar_10')).toBeNull();
    expect(parsearBotonId('resp_tipo_crema_restar_5')).toBeNull();
  });
});

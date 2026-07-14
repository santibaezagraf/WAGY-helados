import { describe, it, expect } from 'vitest';
import { parsearBotonId, RESPUESTAS_RAPIDAS } from './botones';

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

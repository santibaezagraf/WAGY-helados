import { describe, it, expect } from 'vitest';
import { construirContextoNegocio, elegirTextoDelegacion } from './consultas-negocio';
import type { PedidoActivoContext } from './procesar';
import type { ListaPreciosPublica } from '@/lib/precios-publico';

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

const listaDemo: ListaPreciosPublica = {
  nombre: 'Demo',
  agua: [{ min_cantidad: 1, precio_unitario: 500 }],
  crema: [{ min_cantidad: 1, precio_unitario: 400 }],
};

describe('construirContextoNegocio', () => {
  it('incluye SIEMPRE el conocimiento base (tipos, sabores, demora, envíos, pago)', () => {
    const ctx = construirContextoNegocio(null, null);
    expect(ctx).toMatch(/de AGUA y de CREMA/);
    expect(ctx).toMatch(/POR UNIDAD/);
    expect(ctx).toMatch(/Sabores de los de agua:/);
    expect(ctx).toMatch(/Sabores de los de crema:/);
    expect(ctx).toMatch(/Demora estimada de entrega:/);
    expect(ctx).toMatch(/efectivo o transferencia/);
  });

  it('incluye el bloque "LO QUE NO SABÉS" (escape hatch de delegación)', () => {
    const ctx = construirContextoNegocio(null, null);
    expect(ctx).toMatch(/LO QUE NO SABÉS/);
    expect(ctx).toMatch(/Horarios/);
    expect(ctx).toMatch(/Zonas de entrega/);
  });

  it('incluye los tiers de precio cuando se pasa la lista', () => {
    const ctx = construirContextoNegocio(null, listaDemo);
    expect(ctx).toMatch(/Precios de agua/);
    expect(ctx).toMatch(/Precios de crema/);
  });

  it('con pedido activo, incluye el total desde precio_total (para "¿cuánto es mi total?")', () => {
    const ctx = construirContextoNegocio(pa({ cantidad_crema: 4, precio_total: 1600 }), null);
    expect(ctx).toMatch(/PEDIDO EN CURSO DEL CLIENTE/);
    expect(ctx).toMatch(/Helados de crema: 4/);
    // formatearPesos usa es-AR: "$ 1.600" (con espacio y separador de miles).
    expect(ctx).toMatch(/Total del pedido:.*1\.600/);
  });

  it('con pedido activo sin precio_total, dice "a confirmar" en vez de inventar', () => {
    const ctx = construirContextoNegocio(pa({ cantidad_crema: 4, precio_total: null }), null);
    expect(ctx).toMatch(/Total del pedido: a confirmar/);
  });

  it('marca retiro cuando la dirección es el sentinela "retira"', () => {
    const ctx = construirContextoNegocio(pa({ direccion: 'retira' }), null);
    expect(ctx).toMatch(/pasa a retirar/);
    expect(ctx).not.toMatch(/Dirección de envío/);
  });

  it('sin pedido activo, deja explícito que no hay pedido en curso (para no delegar "cuánto sale mi pedido?" a un humano)', () => {
    const ctx = construirContextoNegocio(null, null);
    expect(ctx).toMatch(/no tiene ningún pedido activo/);
  });
});

describe('elegirTextoDelegacion', () => {
  it('rota entre variantes según el seed (no repite palabra por palabra)', () => {
    const a = elegirTextoDelegacion(0, false);
    const b = elegirTextoDelegacion(1, false);
    expect(a).not.toBe(b);
  });

  it('con yaAvisado usa la variante "ya avisé" (no vuelve a sonar como recién enterado)', () => {
    const texto = elegirTextoDelegacion(0, true);
    expect(texto).toMatch(/ya le pas/i);
  });

  it('es determinista para el mismo seed', () => {
    expect(elegirTextoDelegacion(5, false)).toBe(elegirTextoDelegacion(5, false));
  });
});

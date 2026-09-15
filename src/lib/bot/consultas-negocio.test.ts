import { describe, it, expect } from 'vitest';
import { construirContextoNegocio, construirContextoTipoHelado, elegirTextoDelegacion, saboresVigentes } from './consultas-negocio';
import type { PedidoActivoContext } from './procesar';
import { SABORES, type ListaPreciosPublica } from '@/lib/precios-publico';

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
  saboresAgua: ['Frutilla', 'Uva'],
  saboresCrema: ['Chocolate'],
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
    // Ancla anti-delegación: los sabores son un dato que el bot SÍ conoce.
    expect(ctx).toMatch(/el CATÁLOGO y lo sabés SIEMPRE/);
    expect(ctx).toMatch(/Demora estimada de entrega:/);
    expect(ctx).toMatch(/efectivo o transferencia/);
  });

  it('incluye el bloque "qué sos" para poder contestar preguntas meta sin delegar', () => {
    // Sin este bloque, "¿qué sabés hacer?" caía en la delegación a un humano
    // (hallazgo menor del informe 32740622175): no es una consulta de negocio
    // real, pero el contexto no tenía con qué responderla.
    const ctx = construirContextoNegocio(null, null);
    expect(ctx).toMatch(/QUÉ SOS Y QUÉ PODÉS HACER/);
    expect(ctx).toMatch(/NO lo delegues/);
    expect(ctx).toMatch(/tomás pedidos de helado/);
  });

  it('incluye el bloque "LO QUE NO SABÉS" (escape hatch de delegación)', () => {
    const ctx = construirContextoNegocio(null, null);
    expect(ctx).toMatch(/LO QUE NO SABÉS/);
    expect(ctx).toMatch(/Horarios/);
    expect(ctx).toMatch(/Zonas de entrega/);
  });

  it('distingue CATÁLOGO de STOCK en el escape hatch', () => {
    // Causa raíz del hallazgo de la corrida 34900965360: el escape hatch decía
    // "stock del día o si hay un sabor puntual disponible", y "¿qué tenés de
    // helados de palito?" se lee como disponibilidad — así que le ganaba a la
    // regla de los sabores y el bot delegaba una lista que tenía delante. El
    // escape hatch ahora habla solo de "agotado hoy" y remite a la lista.
    const ctx = construirContextoNegocio(null, null);
    const noSabes = ctx.slice(ctx.indexOf('LO QUE NO SABÉS'));
    expect(noSabes).toMatch(/AGOTADO hoy/);
    expect(noSabes).toMatch(/la LISTA de sabores sí la sabés/);
    // El texto viejo, que era el que provocaba la delegación, no debe volver.
    expect(noSabes).not.toMatch(/sabor puntual disponible ahora mismo/);
  });

  it('nombra "palito" como formato del producto, no como sabor', () => {
    // El cliente-agente dijo "palito" en 4 de 5 escenarios de la corrida: es como
    // se le dice acá al producto. Sin esta línea, el contexto ni lo nombraba.
    const ctx = construirContextoNegocio(null, null);
    expect(ctx).toMatch(/"palito"/);
    expect(ctx).toMatch(/NO son un producto aparte ni un sabor/);
    expect(construirContextoTipoHelado(50, 'quiero 50 palitos')).toMatch(/"palito"/);
  });

  it('usa los sabores de la lista ACTIVA, no la constante del código', () => {
    // Los sabores son configurables por lista de precios desde el dashboard, pero
    // el contexto del bot usaba siempre la constante: si el staff los cambiaba,
    // /precios se actualizaba y el bot seguía nombrando los viejos.
    const ctx = construirContextoNegocio(null, listaDemo);
    expect(ctx).toMatch(/Sabores de los de agua: Frutilla, Uva\./);
    expect(ctx).toMatch(/Sabores de los de crema: Chocolate\./);
    // Un sabor de la constante que NO está en la lista activa no debe aparecer.
    expect(ctx).not.toMatch(/Dulce de leche/);
    expect(construirContextoTipoHelado(50, 'quiero 50', listaDemo))
      .toMatch(/Sabores de los de crema: Chocolate\./);
  });

  it('cae a la constante SABORES cuando no hay lista activa o vino sin sabores', () => {
    expect(saboresVigentes(null).crema).toEqual([...SABORES.crema]);
    expect(saboresVigentes({ ...listaDemo, saboresAgua: [], saboresCrema: [] }).agua)
      .toEqual([...SABORES.agua]);
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

  it('con yaAvisado usa una variante "ya avisé" (no vuelve a sonar como recién enterado)', () => {
    const texto = elegirTextoDelegacion(0, true);
    expect(texto).toMatch(/equipo/i);
  });

  it('con yaAvisado también rota (no repite palabra por palabra al insistir)', () => {
    const a = elegirTextoDelegacion(0, true);
    const b = elegirTextoDelegacion(1, true);
    expect(a).not.toBe(b);
  });

  it('es determinista para el mismo seed', () => {
    expect(elegirTextoDelegacion(5, false)).toBe(elegirTextoDelegacion(5, false));
  });
});

describe('construirContextoTipoHelado', () => {
  it('acota el contexto a la cantidad, lo que escribió el cliente y los sabores reales', () => {
    const ctx = construirContextoTipoHelado(50, 'quiero 50 helados de frutilla');
    expect(ctx).toMatch(/Cantidad que pidió: 50/);
    expect(ctx).toMatch(/quiero 50 helados de frutilla/);
    expect(ctx).toMatch(/Sabores de los de agua:.*Frutilla/);
    expect(ctx).toMatch(/Sabores de los de crema:.*Chocolate/);
    // Ancla del caso que motivó todo: un sabor puede estar en los dos tipos, así
    // que el modelo no debe "resolverlo" por su cuenta.
    expect(ctx).toMatch(/puede existir en los dos tipos/);
  });

  it('no filtra precios ni otros datos del negocio (la pregunta es solo por el tipo)', () => {
    const ctx = construirContextoTipoHelado(20, 'mandame 20 helados');
    expect(ctx).not.toMatch(/Precios/);
    expect(ctx).not.toMatch(/alias/i);
    expect(ctx).not.toMatch(/Demora/);
  });
});

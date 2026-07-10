import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/supabase';

/**
 * Fuente única de la lista de precios pública: la muestran tanto la página
 * `/precios` (link en el perfil de WhatsApp) como el bot cuando el cliente
 * escribe "precios" en el chat.
 *
 * Los precios (tiers agua/crema) salen de la DB (`listas_precios` activa +
 * `reglas_precios`), así que se actualizan solos cuando cambiás la lista desde
 * el dashboard. Los sabores y la política de envíos NO viven en la DB: son
 * constantes editables acá abajo (cambian poquísimo).
 */

// ─── Contenido estático (editá esto cuando cambien sabores o envíos) ─────────

export const SABORES = {
  agua: ['Frutilla', 'Uva', 'Limón', 'Pico Dulce', 'Crema del Cielo', 'Caramelo Fizz'],
  crema: ['Chocolate', 'Vainilla', 'Frutilla', 'Dulce de leche'],
} as const;

export const ENVIOS = {
  // Monto a partir del cual el envío es gratis.
  minimoGratis: 10000,
} as const;

export const CONTACTO = {
  // Número del bot en formato internacional wa.me (con el 9 de móvil AR).
  whatsapp: '5493442689781',
  // Mensaje precargado al abrir el chat desde la landing.
  mensajeInicial: '¡Hola! Vi la página de precios y quiero hacer un pedido 🍦',
} as const;

/** Link wa.me al chat con el bot, con mensaje precargado. */
export function linkWhatsApp(): string {
  return `https://wa.me/${CONTACTO.whatsapp}?text=${encodeURIComponent(CONTACTO.mensajeInicial)}`;
}

// ─── Lectura de la DB ────────────────────────────────────────────────────────

export interface TierPrecio {
  min_cantidad: number;
  precio_unitario: number;
}

export interface ListaPreciosPublica {
  nombre: string | null;
  agua: TierPrecio[];
  crema: TierPrecio[];
}

// Cliente service-role, creado en forma perezosa (nunca en tiempo de import,
// para no romper los tests que inyectan env dummy) y SOLO server-side. Lee
// `listas_precios`, cuya RLS solo permite `authenticated`; service-role la
// saltea, así que la página puede ser pública sin login.
function clienteAdmin() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * Devuelve la lista de precios activa con sus tiers ordenados ascendente por
 * cantidad. `null` si no hay lista activa o falla la lectura (el llamador
 * decide el fallback).
 */
export async function obtenerListaPreciosPublica(): Promise<ListaPreciosPublica | null> {
  const supabase = clienteAdmin();

  const { data: lista, error: errorLista } = await supabase
    .from('listas_precios')
    .select('id, nombre')
    .eq('activa', true)
    .limit(1)
    .single();

  if (errorLista || !lista) {
    console.error('No se pudo obtener la lista de precios activa:', errorLista?.message);
    return null;
  }

  const { data: reglas, error: errorReglas } = await supabase
    .from('reglas_precios')
    .select('tipo_producto, min_cantidad, precio_unitario')
    .eq('lista_id', lista.id);

  if (errorReglas || !reglas) {
    console.error('No se pudieron obtener las reglas de precios:', errorReglas?.message);
    return null;
  }

  const porTipo = (tipo: string) =>
    reglas
      .filter((r) => r.tipo_producto === tipo)
      .map((r) => ({ min_cantidad: r.min_cantidad, precio_unitario: r.precio_unitario }))
      .sort((a, b) => a.min_cantidad - b.min_cantidad);

  return {
    nombre: lista.nombre,
    agua: porTipo('agua'),
    crema: porTipo('crema'),
  };
}

// ─── Formateo ─────────────────────────────────────────────────────────────────

const pesos = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

export function formatearPesos(monto: number): string {
  return pesos.format(monto);
}

/**
 * Arma el texto de la lista de precios para mandar por WhatsApp. Usa el markup
 * de WhatsApp (*negrita*). Es lo que responde el bot ante "precios".
 */
export function formatearPreciosWhatsApp(lista: ListaPreciosPublica): string {
  const partes: string[] = [];
  partes.push('*PRECIOS — WAGY helados* 🍦');

  const bloque = (titulo: string, tiers: TierPrecio[], sabores: readonly string[]) => {
    if (tiers.length === 0) return;
    partes.push('');
    partes.push(`*${titulo}*`);
    for (const t of tiers) {
      partes.push(`• Desde ${t.min_cantidad}: ${formatearPesos(t.precio_unitario)} c/u`);
    }
    partes.push(`Sabores: ${sabores.join(', ')}`);
  };

  bloque('Helados de agua', lista.agua, SABORES.agua);
  bloque('Helados de crema', lista.crema, SABORES.crema);

  partes.push('');
  partes.push(
    `🚚 *Envíos:* ¡GRATIS en compras de ${formatearPesos(ENVIOS.minimoGratis)} o más! ` +
      `Por menos de eso, consultanos el costo o pasás a retirar.`,
  );
  partes.push('');
  partes.push('👉 Para pedir, decime cuántos querés y de qué sabor. 😊');

  return partes.join('\n');
}

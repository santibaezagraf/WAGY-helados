import type { Metadata } from 'next';
import Image from 'next/image';
import {
  obtenerListaPreciosPublica,
  formatearPesos,
  linkWhatsApp,
  CONTACTO,
  SABORES,
  ENVIOS,
  type TierPrecio,
} from '@/lib/precios-publico';
import { Carrusel } from './carrusel';

// Landing pública (sin login): presentación de la marca + carrusel de fotos +
// lista de precios activa. El link va en el campo "sitio web" del perfil de
// WhatsApp Business para que el cliente la abra desde ahí. Se revalida cada
// hora: refleja cambios de la lista sin quedar pegada a un build.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'WAGY helados 🍦 — Precios',
  description:
    'Somos una empresa familiar que hace helados. Helados de agua y crema, precios por cantidad y envíos.',
};

// Paleta del manual de marca: azul Pantone 648 C, celeste 311 C, rojo 185 C.
const AZUL = '#122C54';
const CELESTE = '#33C5E6';
const ROJO = '#F01D24';

const FOTOS = [
  { src: '/images/helados.jpg', alt: 'Plato con helados de agua de todos los sabores' },
  { src: '/images/helados-rojos.jpg', alt: 'Helados de frutilla' },
  { src: '/images/helados-2.jpg', alt: 'Helados artesanales WAGY' },
  { src: '/images/helados-verde.jpg', alt: 'Helados de limón' },
  { src: '/images/helados-3.jpg', alt: 'Helados artesanales WAGY' },
  { src: '/images/helados-violeta.jpg', alt: 'Helados de uva' },
  { src: '/images/helados-4.jpg', alt: 'Helados artesanales WAGY' },
  { src: '/images/helados-celeste.jpg', alt: 'Helados de crema del cielo' },
];

function TablaTiers({ tiers, color }: { tiers: TierPrecio[]; color: string }) {
  return (
    <ul className="mt-4 space-y-2.5">
      {tiers.map((t) => (
        <li
          key={t.min_cantidad}
          className="flex items-baseline justify-between gap-4 border-b border-dashed border-slate-200 pb-2.5 last:border-0 last:pb-0"
        >
          <span className="text-slate-600">
            Desde <span className="font-semibold text-slate-800">{t.min_cantidad}</span> unidades
          </span>
          <span className="text-lg font-bold" style={{ color }}>
            {formatearPesos(t.precio_unitario)}{' '}
            <span className="text-sm font-normal text-slate-400">c/u</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Sabores({ sabores }: { sabores: readonly string[] }) {
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {sabores.map((s) => (
        <span
          key={s}
          className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600"
        >
          {s}
        </span>
      ))}
    </div>
  );
}

export default async function PreciosPage() {
  const lista = await obtenerListaPreciosPublica();
  const hayPrecios = lista && (lista.agua.length > 0 || lista.crema.length > 0);

  return (
    <main className="min-h-screen bg-white text-slate-900">
      {/* Scoped a esta página: anclas con scroll suave (CTA "Ver precios"). */}
      <style>{`html { scroll-behavior: smooth; }`}</style>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section
        className="relative overflow-hidden px-4 pb-20 pt-14 text-center"
        style={{ backgroundColor: AZUL }}
      >
        {/* Manchas decorativas en celeste/rojo de la paleta */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full opacity-20 blur-3xl"
          style={{ backgroundColor: CELESTE }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -right-20 h-80 w-80 rounded-full opacity-15 blur-3xl"
          style={{ backgroundColor: ROJO }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute right-[12%] top-10 h-24 w-24 rounded-full opacity-25 blur-2xl"
          style={{ backgroundColor: CELESTE }}
        />

        <div className="relative mx-auto max-w-2xl">
          <Image
            src="/images/wagy-fondo-transparente.png"
            alt=""
            width={130}
            height={130}
            priority
            className="mx-auto drop-shadow-[0_8px_24px_rgba(51,197,230,0.45)]"
          />
          <h1 className="mt-6 text-5xl font-black uppercase tracking-tight text-white sm:text-6xl">
            WAGY <span style={{ color: CELESTE }}>helados</span>
          </h1>
          <p
            className="mt-3 text-xl font-bold italic sm:text-2xl"
            style={{ color: CELESTE }}
          >
            ¡Viví el sabor!
          </p>

          <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-sky-100/90">
            Somos una <span className="font-semibold text-white">empresa familiar</span> que hace
            helados. Antes <span className="italic">Helados de Agua</span>, ahora{' '}
            <span className="font-bold text-white">WAGY Helados</span>. Helados de agua y de
            crema, hechos con amor y con los sabores de siempre.
          </p>

          <a
            href="#precios"
            className="mt-10 inline-block rounded-full px-8 py-3.5 text-lg font-bold text-white shadow-lg transition hover:scale-105 hover:shadow-xl"
            style={{ backgroundColor: ROJO }}
          >
            Ver precios ↓
          </a>
        </div>

        {/* Onda de transición hacia el carrusel */}
        <svg
          aria-hidden
          viewBox="0 0 1440 60"
          preserveAspectRatio="none"
          className="absolute bottom-0 left-0 h-8 w-full sm:h-12"
        >
          <path d="M0,60 C360,0 1080,0 1440,60 L1440,60 L0,60 Z" fill="#f0f9ff" />
        </svg>
      </section>

      {/* ── Carrusel ──────────────────────────────────────────────────────── */}
      <section className="bg-sky-50 px-4 py-14">
        <div className="mx-auto max-w-4xl">
          <h2
            className="text-center text-3xl font-black uppercase tracking-tight sm:text-4xl"
            style={{ color: AZUL }}
          >
            ¡Sentí el verano!
          </h2>
          <p className="mt-2 text-center text-slate-500">
            Un poquito de lo que hacemos, para que se te haga agua la boca.
          </p>
          <div className="mt-8">
            <Carrusel fotos={FOTOS} />
          </div>
        </div>
      </section>

      {/* ── Precios ───────────────────────────────────────────────────────── */}
      <section id="precios" className="scroll-mt-6 px-4 py-16">
        <div className="mx-auto max-w-4xl">
          <h2
            className="text-center text-3xl font-black uppercase tracking-tight sm:text-4xl"
            style={{ color: AZUL }}
          >
            Precios
          </h2>
          <p className="mt-2 text-center text-slate-500">
            Cuantos más llevás, más barato te sale cada uno. 😉
          </p>

          {!hayPrecios ? (
            <p className="mx-auto mt-10 max-w-md rounded-2xl bg-sky-50 p-6 text-center text-slate-600 ring-1 ring-sky-100">
              No hay precios disponibles en este momento. Escribinos por WhatsApp y te pasamos la
              info. 🙏
            </p>
          ) : (
            <div className="mt-10 grid gap-6 sm:grid-cols-2">
              {lista.agua.length > 0 && (
                <section className="rounded-3xl bg-white p-7 shadow-lg ring-1 ring-slate-100">
                  <div
                    className="inline-block rounded-full px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white"
                    style={{ backgroundColor: CELESTE }}
                  >
                    Helados de agua
                  </div>
                  <TablaTiers tiers={lista.agua} color={AZUL} />
                  <Sabores sabores={SABORES.agua} />
                </section>
              )}

              {lista.crema.length > 0 && (
                <section className="rounded-3xl bg-white p-7 shadow-lg ring-1 ring-slate-100">
                  <div
                    className="inline-block rounded-full px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white"
                    style={{ backgroundColor: ROJO }}
                  >
                    Helados de crema
                  </div>
                  <TablaTiers tiers={lista.crema} color={AZUL} />
                  <Sabores sabores={SABORES.crema} />
                </section>
              )}
            </div>
          )}

          {/* Envíos */}
          <div
            className="mt-8 flex flex-col items-center gap-2 rounded-3xl px-7 py-8 text-center text-white sm:flex-row sm:gap-6 sm:text-left"
            style={{ backgroundColor: AZUL }}
          >
            <span className="text-4xl" aria-hidden>
              🚚
            </span>
            <div>
              <h3 className="text-xl font-bold">
                Envíos <span style={{ color: CELESTE }}>GRATIS</span> en compras de{' '}
                {formatearPesos(ENVIOS.minimoGratis)} o más
              </h3>
              <p className="mt-1 text-sky-100/80">
                Por menos de eso, consultanos el costo o pasás a retirar.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer / CTA ──────────────────────────────────────────────────── */}
      <footer className="bg-sky-50 px-4 py-12 text-center">
        <Image
          src="/images/wagy-fondo-transparente.png"
          alt=""
          width={64}
          height={64}
          className="mx-auto"
        />
        <p className="mt-4 text-lg font-semibold" style={{ color: AZUL }}>
          ¿Se te antojó? Hacé tu pedido por WhatsApp. 😊
        </p>
        <a
          href={linkWhatsApp()}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex items-center gap-2.5 rounded-full bg-[#25D366] px-7 py-3.5 text-lg font-bold text-white shadow-lg transition hover:scale-105 hover:shadow-xl"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
          </svg>
          Pedir por WhatsApp
        </a>

        {/* Redes */}
        <div className="mt-7 flex items-center justify-center gap-4">
          <a
            href={CONTACTO.instagram}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Instagram de WAGY helados"
            className="rounded-full p-3 text-white shadow-md transition hover:scale-110"
            style={{ backgroundColor: AZUL }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zm0 10.162a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
            </svg>
          </a>
          <a
            href={CONTACTO.facebook}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Facebook de WAGY helados"
            className="rounded-full p-3 text-white shadow-md transition hover:scale-110"
            style={{ backgroundColor: AZUL }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
          </a>
        </div>

        <p className="mt-6 text-sm text-slate-400">WAGY helados — ¡Viví el sabor!</p>
      </footer>
    </main>
  );
}

'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Foto {
  src: string;
  alt: string;
}

const AUTOPLAY_MS = 4500;

/**
 * Carrusel de fotos de producto para la landing pública. Autoplay que se pausa
 * mientras el usuario interactúa (hover o dedo apoyado), flechas, dots y swipe.
 * Sin dependencias: es un track flex con translateX animado por CSS.
 */
export function Carrusel({ fotos }: { fotos: Foto[] }) {
  const [actual, setActual] = useState(0);
  const [pausado, setPausado] = useState(false);
  const touchX = useRef<number | null>(null);

  const ir = useCallback(
    (i: number) => setActual(((i % fotos.length) + fotos.length) % fotos.length),
    [fotos.length],
  );

  useEffect(() => {
    if (pausado || fotos.length < 2) return;
    const timer = setInterval(() => setActual((a) => (a + 1) % fotos.length), AUTOPLAY_MS);
    return () => clearInterval(timer);
  }, [pausado, fotos.length]);

  if (fotos.length === 0) return null;

  return (
    <div
      className="group relative overflow-hidden rounded-3xl shadow-xl ring-1 ring-black/5"
      onMouseEnter={() => setPausado(true)}
      onMouseLeave={() => setPausado(false)}
      onTouchStart={(e) => {
        setPausado(true);
        touchX.current = e.touches[0].clientX;
      }}
      onTouchEnd={(e) => {
        setPausado(false);
        if (touchX.current === null) return;
        const delta = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(delta) > 40) ir(actual + (delta < 0 ? 1 : -1));
      }}
      role="region"
      aria-roledescription="carrusel"
      aria-label="Fotos de nuestros helados"
    >
      <div
        className="flex transition-transform duration-700 ease-out"
        style={{ transform: `translateX(-${actual * 100}%)` }}
      >
        {fotos.map((foto, i) => (
          <div
            key={foto.src}
            className="relative aspect-square w-full shrink-0 sm:aspect-[16/9]"
            aria-hidden={i !== actual}
          >
            <Image
              src={foto.src}
              alt={foto.alt}
              fill
              sizes="(min-width: 1024px) 896px, 100vw"
              className="object-cover"
              priority={i === 0}
            />
          </div>
        ))}
      </div>

      {/* Flechas */}
      <button
        type="button"
        onClick={() => ir(actual - 1)}
        aria-label="Foto anterior"
        className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/80 p-2 text-[#122C54] shadow-md backdrop-blur transition hover:bg-white sm:opacity-0 sm:group-hover:opacity-100"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => ir(actual + 1)}
        aria-label="Foto siguiente"
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/80 p-2 text-[#122C54] shadow-md backdrop-blur transition hover:bg-white sm:opacity-0 sm:group-hover:opacity-100"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>

      {/* Dots */}
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
        {fotos.map((foto, i) => (
          <button
            key={foto.src}
            type="button"
            onClick={() => ir(i)}
            aria-label={`Ir a la foto ${i + 1}`}
            aria-current={i === actual}
            className={`h-2.5 rounded-full transition-all ${
              i === actual ? 'w-6 bg-white' : 'w-2.5 bg-white/50 hover:bg-white/80'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Test del gate de autenticación del middleware (proxy.ts). Mockeamos el cliente
 * de Supabase para controlar si hay sesión, e invocamos `proxy()` con requests
 * a distintas rutas verificando cuándo redirige a /login y cuándo deja pasar.
 *
 * No hay red ni dev server: se prueba la lógica de ruteo/redirect, que es lo que
 * cambió (antes el middleware solo refrescaba la cookie, no protegía rutas).
 */

const getUserMock = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: getUserMock } }),
}));

import { proxy } from './proxy';

function req(path: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`));
}

/** Location del redirect, o null si el middleware dejó pasar (NextResponse.next). */
function destinoRedirect(res: Response): string | null {
  const loc = res.headers.get('location');
  return loc ? new URL(loc).pathname : null;
}

beforeEach(() => {
  getUserMock.mockReset();
});

describe('proxy — gate de autenticación', () => {
  describe('sin sesión', () => {
    beforeEach(() => {
      getUserMock.mockResolvedValue({ data: { user: null } });
    });

    it('redirige el dashboard (/) a /login', async () => {
      expect(destinoRedirect(await proxy(req('/')))).toBe('/login');
    });

    it('redirige /balances a /login', async () => {
      expect(destinoRedirect(await proxy(req('/balances')))).toBe('/login');
    });

    it('deja pasar /precios (landing pública)', async () => {
      expect(destinoRedirect(await proxy(req('/precios')))).toBeNull();
    });

    it('deja pasar /login (para no hacer loop de redirect)', async () => {
      expect(destinoRedirect(await proxy(req('/login')))).toBeNull();
    });

    it('deja pasar /api/webhook (se autentica con la firma de Meta)', async () => {
      expect(destinoRedirect(await proxy(req('/api/webhook')))).toBeNull();
    });

    it('deja pasar /api/procesar-pendientes (firma de QStash)', async () => {
      expect(destinoRedirect(await proxy(req('/api/procesar-pendientes')))).toBeNull();
    });

    it('no confunde una ruta que empieza con el nombre de una pública (/preciosX)', async () => {
      expect(destinoRedirect(await proxy(req('/preciosX')))).toBe('/login');
    });
  });

  describe('con sesión', () => {
    beforeEach(() => {
      getUserMock.mockResolvedValue({ data: { user: { id: 'u1' } } });
    });

    it('deja pasar el dashboard (/)', async () => {
      expect(destinoRedirect(await proxy(req('/')))).toBeNull();
    });

    it('deja pasar /balances', async () => {
      expect(destinoRedirect(await proxy(req('/balances')))).toBeNull();
    });
  });
});

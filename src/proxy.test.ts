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

    // El logout tiene que pasar aunque la sesión ya haya vencido: si el gate lo
    // interceptara, el redirect 307 preservaría el método y terminaría haciendo
    // POST contra /login (el error "unexpected response" del server action).
    it('deja pasar /auth/cerrar-sesion aunque no haya sesión', async () => {
      expect(destinoRedirect(await proxy(req('/auth/cerrar-sesion')))).toBeNull();
    });
  });

  describe('con sesión de admin', () => {
    beforeEach(() => {
      getUserMock.mockResolvedValue({
        data: { user: { id: 'u1', app_metadata: { rol: 'admin' } } },
      });
    });

    it('deja pasar el dashboard (/)', async () => {
      expect(destinoRedirect(await proxy(req('/')))).toBeNull();
    });

    it.each(['/balances', '/modelos', '/conversaciones', '/perfil'])(
      'deja pasar %s',
      async (ruta) => {
        expect(destinoRedirect(await proxy(req(ruta)))).toBeNull();
      },
    );
  });

  describe('con sesión de mensajero', () => {
    beforeEach(() => {
      getUserMock.mockResolvedValue({
        data: { user: { id: 'u2', app_metadata: { rol: 'mensajero' } } },
      });
    });

    it.each(['/balances', '/modelos', '/conversaciones'])(
      'manda %s al dashboard',
      async (ruta) => {
        expect(destinoRedirect(await proxy(req(ruta)))).toBe('/');
      },
    );

    it('también protege las subrutas', async () => {
      expect(destinoRedirect(await proxy(req('/conversaciones/5491122334455')))).toBe('/');
    });

    it('deja pasar el dashboard (/), que sí puede ver', async () => {
      expect(destinoRedirect(await proxy(req('/')))).toBeNull();
    });

    it('deja pasar /perfil: los dos roles cambian su nombre y contraseña', async () => {
      expect(destinoRedirect(await proxy(req('/perfil')))).toBeNull();
    });

    it('no confunde un prefijo (/balances-falsos no es ruta de admin)', async () => {
      expect(destinoRedirect(await proxy(req('/balances-falsos')))).toBeNull();
    });
  });

  // Regresión del fail-closed: un usuario creado a mano al que se le olvidó
  // poner el rol NO debe entrar como admin.
  describe('con sesión sin rol declarado', () => {
    beforeEach(() => {
      getUserMock.mockResolvedValue({ data: { user: { id: 'u3' } } });
    });

    it('se lo trata como mensajero: /balances va al dashboard', async () => {
      expect(destinoRedirect(await proxy(req('/balances')))).toBe('/');
    });

    it('igual puede ver el dashboard', async () => {
      expect(destinoRedirect(await proxy(req('/')))).toBeNull();
    });
  });
});

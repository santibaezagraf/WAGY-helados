import { describe, it, expect, vi, afterEach } from 'vitest';
import { cronAutorizado } from './auth-cron';

const SECRET = 'cron-secret-de-prueba';

function reqConHeader(valor?: string): Request {
  const headers: Record<string, string> = {};
  if (valor !== undefined) headers['authorization'] = valor;
  return new Request('http://localhost/api/reenviar-resumenes', { method: 'POST', headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('cronAutorizado', () => {
  it('acepta el Bearer con el CRON_SECRET correcto', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect(cronAutorizado(reqConHeader(`Bearer ${SECRET}`))).toBe(true);
  });

  it('rechaza un secreto incorrecto', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect(cronAutorizado(reqConHeader('Bearer otro-secreto'))).toBe(false);
  });

  it('rechaza si falta el header Authorization', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect(cronAutorizado(reqConHeader())).toBe(false);
  });

  it('rechaza un header sin el prefijo Bearer', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect(cronAutorizado(reqConHeader(SECRET))).toBe(false);
  });

  it('rechaza un Bearer vacío', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect(cronAutorizado(reqConHeader('Bearer '))).toBe(false);
  });

  it('rechaza un secreto de largo distinto sin tirar (timingSafeEqual exige mismo largo)', () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    expect(cronAutorizado(reqConHeader('Bearer abc'))).toBe(false);
  });

  it('fail-closed: sin CRON_SECRET configurado rechaza todo y loguea error', () => {
    vi.stubEnv('CRON_SECRET', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(cronAutorizado(reqConHeader(`Bearer ${SECRET}`))).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('CRON_SECRET'));
  });
});

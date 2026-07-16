import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { POST } from './route';

/**
 * Integración del gate de firma del webhook: invocamos el handler POST real con
 * Requests forjados/legítimos y verificamos el status. Todos los casos usan
 * bodies que cortan ANTES de tocar Supabase/QStash (object desconocido o sin
 * mensajes), así que no hay red: lo que se prueba es el glue (lectura del body
 * crudo, header, env gate y códigos de respuesta), no el pipeline del bot.
 */

const SECRET = 'secreto-de-prueba';

function firmar(body: string, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function postWebhook(body: string, firma?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (firma !== undefined) headers['x-hub-signature-256'] = firma;
  return POST(new Request('http://localhost/api/webhook', { method: 'POST', headers, body }));
}

// Body inocuo: object válido pero sin mensajes → el handler responde temprano.
const BODY_SIN_MENSAJES = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
// Body que el handler ignora por object desconocido.
const BODY_IGNORADO = JSON.stringify({ object: 'otra_cosa' });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/webhook — verificación de firma de Meta', () => {
  it('rechaza con 403 un request SIN firma cuando el secret está configurado', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
    const res = await postWebhook(BODY_SIN_MENSAJES);
    expect(res.status).toBe(403);
  });

  it('rechaza con 403 una firma inválida', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
    const res = await postWebhook(BODY_SIN_MENSAJES, 'sha256=' + '0'.repeat(64));
    expect(res.status).toBe(403);
  });

  it('rechaza con 403 una firma hecha con otro secret', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
    const res = await postWebhook(BODY_SIN_MENSAJES, firmar(BODY_SIN_MENSAJES, 'otro-secret'));
    expect(res.status).toBe(403);
  });

  it('rechaza con 403 si el body fue alterado después de firmar', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
    const firma = firmar(BODY_SIN_MENSAJES);
    const bodyAlterado = BODY_SIN_MENSAJES.replace('entry', 'Entry');
    const res = await postWebhook(bodyAlterado, firma);
    expect(res.status).toBe(403);
  });

  it('acepta un request con firma válida (200)', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
    const res = await postWebhook(BODY_SIN_MENSAJES, firmar(BODY_SIN_MENSAJES));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'no_message' });
  });

  it('acepta y firma válida sobre bodies con multibyte (la firma es sobre utf8)', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', SECRET);
    const body = JSON.stringify({ object: 'otra_cosa 🍦 Güemes' });
    const res = await postWebhook(body, firmar(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ignored' });
  });

  it('sin WHATSAPP_APP_SECRET configurado rechaza todo con 503 (fail-closed)', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Aun con una firma "válida" para algún secret, sin secret propio no hay
    // forma de verificar: se rechaza.
    const res = await postWebhook(BODY_IGNORADO, firmar(BODY_IGNORADO));
    expect(res.status).toBe(503);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('WHATSAPP_APP_SECRET'));
    error.mockRestore();
  });
});

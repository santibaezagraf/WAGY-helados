import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verificarFirmaMeta } from './firma-meta';

const SECRET = 'app-secret-de-prueba';

/** Firma un body igual que Meta: "sha256=" + HMAC-SHA256(secret, body) en hex. */
function firmar(body: string, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

const BODY = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [{ from: '5493412345678', type: 'text', text: { body: 'hola' } }] } }] }],
});

describe('verificarFirmaMeta', () => {
  it('acepta una firma válida', () => {
    expect(verificarFirmaMeta(BODY, firmar(BODY), SECRET)).toBe(true);
  });

  it('acepta bodies con caracteres multibyte (acentos/emoji, firma sobre utf8)', () => {
    const body = JSON.stringify({ texto: 'quiero 1kg de dulce de leche 🍦 para Güemes 1234' });
    expect(verificarFirmaMeta(body, firmar(body), SECRET)).toBe(true);
  });

  it('rechaza si el body fue alterado después de firmar', () => {
    const firma = firmar(BODY);
    const bodyAlterado = BODY.replace('hola', 'cancelar');
    expect(verificarFirmaMeta(bodyAlterado, firma, SECRET)).toBe(false);
  });

  it('rechaza una firma generada con otro secret', () => {
    expect(verificarFirmaMeta(BODY, firmar(BODY, 'otro-secret'), SECRET)).toBe(false);
  });

  it('rechaza si falta el header', () => {
    expect(verificarFirmaMeta(BODY, null, SECRET)).toBe(false);
  });

  it('rechaza un header vacío', () => {
    expect(verificarFirmaMeta(BODY, '', SECRET)).toBe(false);
  });

  it('rechaza un header sin el prefijo sha256=', () => {
    const hex = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
    expect(verificarFirmaMeta(BODY, hex, SECRET)).toBe(false);
  });

  it('rechaza el prefijo de otro algoritmo (sha1=, el header legacy de Meta)', () => {
    const hex = createHmac('sha1', SECRET).update(BODY, 'utf8').digest('hex');
    expect(verificarFirmaMeta(BODY, 'sha1=' + hex, SECRET)).toBe(false);
  });

  it('rechaza una firma de largo incorrecto sin tirar (timingSafeEqual exige mismo largo)', () => {
    expect(verificarFirmaMeta(BODY, 'sha256=abc123', SECRET)).toBe(false);
    expect(verificarFirmaMeta(BODY, 'sha256=', SECRET)).toBe(false);
  });

  it('rechaza la firma correcta de OTRO body (replay cruzado)', () => {
    const otroBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    expect(verificarFirmaMeta(BODY, firmar(otroBody), SECRET)).toBe(false);
  });
});

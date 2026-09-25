import { describe, it, expect, vi } from 'vitest';

// fetch-service imports the AI settings service (Prisma) — stub it so the
// policy tests never touch a database.
vi.mock('@/modules/ai/ai-admin-config-service', () => ({
  getAiSettings: vi.fn(async () => ({
    webFetchMaxBytes: 2_000_000,
    webDomainAllowlist: [],
    webDomainDenylist: [],
  })),
}));

import { isUrlDenied } from './fetch-service';

describe('isUrlDenied — política de web pública', () => {
  it('rechaza URLs que no son https', () => {
    expect(isUrlDenied('http://ejemplo.com', [], [])).toMatch(/https/);
    expect(isUrlDenied('file:///etc/passwd', [], [])).toBeTruthy();
    expect(isUrlDenied('javascript:alert(1)', [], [])).toBeTruthy();
  });

  it('rechaza URLs inválidas', () => {
    expect(isUrlDenied('no-es-url', [], [])).toBeTruthy();
  });

  it('bloquea hosts internos siempre', () => {
    expect(isUrlDenied('https://localhost/admin', [], [])).toBeTruthy();
    expect(isUrlDenied('https://metadata.google.internal/', [], [])).toBeTruthy();
    expect(isUrlDenied('https://app.printer.local/', [], [])).toBeTruthy();
  });

  it('aplica denylist del admin', () => {
    expect(isUrlDenied('https://malicioso.com/x', [], ['malicioso.com'])).toBeTruthy();
    expect(isUrlDenied('https://sub.malicioso.com/x', [], ['*.malicioso.com'])).toBeTruthy();
  });

  it('con allowlist no vacía, solo permite esos dominios', () => {
    const allow = ['docs.ejemplo.com'];
    expect(isUrlDenied('https://docs.ejemplo.com/api', allow, [])).toBeNull();
    expect(isUrlDenied('https://otro.com/', allow, [])).toBeTruthy();
  });

  it('denylist gana sobre allowlist', () => {
    expect(isUrlDenied('https://docs.ejemplo.com/', ['*.ejemplo.com'], ['docs.ejemplo.com'])).toBeTruthy();
  });

  it('permite https público normal sin listas', () => {
    expect(isUrlDenied('https://openrouter.ai/docs', [], [])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { extractArtifactIdsFromLinks, formatForCustomerChannel, markdownToWhatsApp, stripArtifactLinks } from './customer-message-format';
import { markdownLinksToPlain, verifyShareToken, buildShareToken } from './artifact-share';

describe('markdownToWhatsApp', () => {
  it('converts markdown into WhatsApp-friendly text', () => {
    const out = markdownToWhatsApp('## Hola\n\n**Total**: $10\n- uno\n- dos\n[Descargar](https://x.app/f/1).');
    expect(out).toContain('*Hola*');
    expect(out).toContain('*Total*: $10');
    expect(out).toContain('• uno');
    expect(out).toContain('Descargar: https://x.app/f/1 .');
    expect(out).not.toContain('**');
  });
});

describe('formatForCustomerChannel', () => {
  it('replaces placeholders with the real sender and removes stock fragments', () => {
    const res = formatForCustomerChannel('Hola Israel,\n\n1. **Piel de Elefante Cafe 10x10** - $349 por m² (stock: -2.02)\n2. **Oxidada** - $199 por m² (stock: 72.3)\n\nSaludos,\n[Tu Nombre]', { senderName: 'Israel Saavedra' });
    expect(res.text).not.toMatch(/stock/i);
    expect(res.text).not.toContain('[Tu Nombre]');
    expect(res.text).toContain('Israel Saavedra');
    expect(res.text).toContain('*Piel de Elefante Cafe 10x10* - $349 por m²');
    expect(res.changes).toEqual(expect.arrayContaining(['markdown', 'placeholder_name', 'internal_data']));
  });

  it('keeps stock when explicitly allowed and fills empty signatures', () => {
    const res = formatForCustomerChannel('Tenemos 40 m² (stock: 40.1).\n\nSaludos,\n', { senderName: 'Papa', keepInternalData: true });
    expect(res.text).toContain('(stock: 40.1)');
    expect(res.text.endsWith('Saludos,\nPapa')).toBe(true);
  });
});

describe('artifact links in bodies', () => {
  const body = 'Te envío el PDF. Puedes descargarlo aquí: Descargar PDF - Ventas: https://unik.app/api/files/shared/cmu0ligwz0030td0d2y7bvti9.1797127219.yVw5DJrtXxhqY6v6xmQdq9WgcgAIc4TS.\n\nSaludos';
  it('extracts artifact ids from share and download links', () => {
    expect(extractArtifactIdsFromLinks(body)).toEqual(['cmu0ligwz0030td0d2y7bvti9']);
    expect(extractArtifactIdsFromLinks('ver https://unik.app/app/assistant/api/artifacts/abc123/download?inline=1')).toEqual(['abc123']);
  });
  it('strips the links when the file travels as an attachment', () => {
    const out = stripArtifactLinks(body);
    expect(out).not.toContain('https://');
    expect(out).toContain('Te envío el PDF.');
    expect(out).toContain('Saludos');
  });
});

describe('share links survive punctuation', () => {
  it('plain links keep a space before trailing punctuation and tokens tolerate it', () => {
    process.env.UNIK_SHARE_LINK_SECRET = 'test-secret';
    expect(markdownLinksToPlain('aquí: [PDF](https://x.app/f/1).')).toBe('aquí: PDF: https://x.app/f/1 .');
    const token = buildShareToken('cmartifact123', 1);
    expect(verifyShareToken(`${token}.`)?.artifactId).toBe('cmartifact123');
    expect(verifyShareToken(`${token})`)?.artifactId).toBe('cmartifact123');
  });
});

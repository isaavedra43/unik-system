import { describe, it, expect } from 'vitest';
import { buildTsQuery, chunkText, normalizeText } from './knowledge-chunker';
import {
  buildPreferencesPrompt,
  DEFAULT_PREFERENCES,
  PAUSED_MODE_HIDDEN_EFFECTS,
} from './preferences-service';
import { buildMemoryPrompt } from './memory-service';

describe('knowledge chunker', () => {
  it('splits by sections and paragraphs with overlap and stable ordinals', () => {
    const text = [
      'POLÍTICA DE GARANTÍA',
      'Todos los productos tienen 12 meses de garantía. ' + 'x'.repeat(1500),
      'El cliente debe presentar factura. ' + 'y'.repeat(1500),
      '# Instalación',
      'La instalación se agenda en 48 horas.',
    ].join('\n\n');
    const chunks = chunkText(text, { targetChars: 1600, maxChars: 2400, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0].section).toBe('POLÍTICA DE GARANTÍA');
    expect(chunks.at(-1)!.section).toBe('Instalación');
    expect(chunks.at(-1)!.content).toContain('48 horas');
    // Overlap: the second chunk starts with the tail of the first.
    expect(chunks[1].content.startsWith(chunks[0].content.slice(-100))).toBe(true);
    expect(chunks.every((c) => c.tokens > 0)).toBe(true);
  });

  it('handles empty input and very long paragraphs', () => {
    expect(chunkText('   \n\n ')).toEqual([]);
    const long = 'Frase uno. '.repeat(600);
    const chunks = chunkText(long, { targetChars: 1000, maxChars: 1200, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.content.length <= 1200)).toBe(true);
  });

  it('normalizes whitespace', () => {
    expect(normalizeText('a\r\n\r\n\r\nb\t\tc  d')).toBe('a\n\nb c d');
  });

  it('builds a safe prefix tsquery from user text', () => {
    expect(buildTsQuery('Garantía de instalación en León')).toBe(
      'garantia:* & de:* & instalacion:* & en:* & leon:*'
    );
    expect(buildTsQuery("'; DROP TABLE x; --")).toBe('drop:* & table:*');
    expect(buildTsQuery('a')).toBe('');
  });
});

describe('preferences prompt', () => {
  it('describes mode, tone, language, depth, format and custom instructions', () => {
    const prompt = buildPreferencesPrompt({
      ...DEFAULT_PREFERENCES,
      mode: 'paused',
      tone: 'directo',
      language: 'en',
      depth: 'breve',
      format: 'tablas',
      customInstructions: 'Siempre  en\nmayúsculas',
    });
    expect(prompt).toContain('MODO PAUSADO');
    expect(prompt).toContain('directo');
    expect(prompt).toContain('inglés');
    expect(prompt).toContain('breves');
    expect(prompt).toContain('tablas');
    expect(prompt).toContain('Siempre en mayúsculas');
    expect(PAUSED_MODE_HIDDEN_EFFECTS.has('external_send')).toBe(true);
    expect(PAUSED_MODE_HIDDEN_EFFECTS.has('read')).toBe(false);
  });

  it('memory prompt lists active memories and flags pending ones', () => {
    expect(buildMemoryPrompt([], 0)).toBe('');
    const prompt = buildMemoryPrompt(['Prefiere Excel'], 2);
    expect(prompt).toContain('Prefiere Excel');
    expect(prompt).toContain('2 recuerdo(s) propuestos');
  });
});

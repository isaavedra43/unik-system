import { describe, expect, it } from 'vitest';
import { createThinkFilter, stripThink } from './think-filter';

function run(chunks: string[]): string {
  const f = createThinkFilter();
  return chunks.map((c) => f.push(c)).join('') + f.flush();
}

describe('think filter', () => {
  it('passes normal text through unchanged', () => {
    expect(run(['Hola, ', 'tienes 65 órdenes.'])).toBe('Hola, tienes 65 órdenes.');
    expect(stripThink('a < b y c > d')).toBe('a < b y c > d');
  });

  it('removes a reasoning block and the blank lines after it', () => {
    expect(stripThink('<think>el usuario pide ventas…</think>\n\nSon 65 órdenes.')).toBe('Son 65 órdenes.');
  });

  it('handles tags split across streamed chunks', () => {
    expect(run(['<thi', 'nk>razono', ' mucho</th', 'ink>', '\nRespuesta ', 'final'])).toBe('Respuesta final');
  });

  it('keeps text before and after the block', () => {
    expect(run(['Antes <think>x</think>', ' después'])).toBe('Antes  después');
  });

  it('holds a trailing "<" until it knows it is not a tag', () => {
    const f = createThinkFilter();
    expect(f.push('precio <')).toBe('precio ');
    expect(f.push(' 100')).toBe('< 100');
    expect(f.flush()).toBe('');
  });
});

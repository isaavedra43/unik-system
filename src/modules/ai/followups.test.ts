import { describe, expect, it } from 'vitest';
import { parseFollowUps } from './followups';

describe('parseFollowUps', () => {
  it('extracts bracketed suggestions from the last line and strips it', () => {
    const r = parseFollowUps('Aquí va el análisis.\n\n**Sugerencias:** [Genera el PDF con todo] · [Avisa al equipo de las 9 por cerrar] · [Muéstrame las de Laura]');
    expect(r.followUps).toEqual(['Genera el PDF con todo', 'Avisa al equipo de las 9 por cerrar', 'Muéstrame las de Laura']);
    expect(r.content).toBe('Aquí va el análisis.');
  });
  it('accepts separators without brackets and caps the list', () => {
    const r = parseFollowUps('x\nSiguientes pasos: uno largo aquí | dos aquí | tres aquí | cuatro aquí | cinco aquí');
    expect(r.followUps).toEqual(['uno largo aquí', 'dos aquí', 'tres aquí', 'cuatro aquí']);
  });
  it('leaves other content untouched', () => {
    expect(parseFollowUps('Hola, ¿en qué te ayudo?')).toEqual({ content: 'Hola, ¿en qué te ayudo?', followUps: [] });
    expect(parseFollowUps(null).followUps).toEqual([]);
  });
});

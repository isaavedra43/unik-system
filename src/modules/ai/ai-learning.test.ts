import { describe, expect, it } from 'vitest';
import { detectCorrection, parseLearnings } from './ai-learning';

describe('detectCorrection', () => {
  it('recognizes corrections and business definitions', () => {
    expect(detectCorrection('No, Producción significa que el material está con el proveedor', 'Producción / material: 14')).toBe(true);
    expect(detectCorrection('Para nosotros Recolección es cuando falta recoger con proveedor', null)).toBe(true);
    expect(detectCorrection('Te equivocaste en la 23354', 'algo')).toBe(true);
  });
  it('ignores ordinary requests and auto triggers', () => {
    expect(detectCorrection('dame las ventas de ayer', 'x')).toBe(false);
    expect(detectCorrection('⟦auto:open⟧ analiza', 'x')).toBe(false);
    expect(detectCorrection('no', 'x')).toBe(false);
  });
});

describe('parseLearnings', () => {
  it('parses the JSON and keeps only durable, well-formed items', () => {
    const out = parseLearnings('{"learnings":[{"content":"En UNIK, Recolección significa que falta recoger material con el proveedor","kind":"definition"},{"content":"corto","kind":"rule"},{"content":"Prefiere reportes en Excel","kind":"otro"}]}');
    expect(out).toEqual([
      { content: 'En UNIK, Recolección significa que falta recoger material con el proveedor', kind: 'definition' },
      { content: 'Prefiere reportes en Excel', kind: 'correction' },
    ]);
    expect(parseLearnings('sin json')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { buildRevisionDirective, isRevisionRequest, mergeRevisionArgs } from './revisions';

describe('isRevisionRequest', () => {
  it('recognizes change requests on a delivered file', () => {
    expect(isRevisionRequest('quita los totales')).toBe(true);
    expect(isRevisionRequest('ponlo en vertical y agrega la columna vendedor')).toBe(true);
    expect(isRevisionRequest('cámbiale el título a Pendientes de septiembre')).toBe(true);
    expect(isRevisionRequest('el mismo reporte pero ordenado por cliente')).toBe(true);
  });
  it('ignores new requests and chatter', () => {
    expect(isRevisionRequest('dame un reporte de ventas de agosto')).toBe(false);
    expect(isRevisionRequest('hazme otro reporte desde cero con las compras')).toBe(false);
    expect(isRevisionRequest('gracias')).toBe(false);
    expect(isRevisionRequest('⟦auto:open⟧ analiza')).toBe(false);
  });
});

describe('mergeRevisionArgs', () => {
  it('keeps what the user did not mention and drops data/content keys', () => {
    const previous = { title: 'Órdenes abiertas', subtitle: 'Todo el historial', rows: [{ a: 1 }], sections: [], blocks: [{ type: 'heading' }], customization: { orientation: 'portrait', showTotals: false }, brandColor: '#0f766e', conversationId: 'c1' };
    const merged = mergeRevisionArgs(previous, { customization: { hideColumns: ['salesperson'] }, columns: [] });
    expect(merged.title).toBe('Órdenes abiertas');
    expect(merged.subtitle).toBe('Todo el historial');
    expect(merged.brandColor).toBe('#0f766e');
    expect(merged.rows).toBeUndefined();
    expect(merged.blocks).toBeUndefined();
    expect(merged.conversationId).toBeUndefined();
    // the model's customization replaces the object; the orchestrator re-merges it with the base
    expect(merged.customization).toEqual({ hideColumns: ['salesperson'] });
  });
});

describe('buildRevisionDirective', () => {
  it('tells the model what it delivered and which version comes next', () => {
    const d = buildRevisionDirective({ artifactId: 'a1', type: 'pdf', title: 'Órdenes abiertas', version: 1, generatedBy: 'generatePdfReport', generatorArgs: { title: 'Órdenes abiertas', rows: [{ x: 1 }] } });
    expect(d).toContain('versión 1');
    expect(d).toContain('versión 2');
    expect(d).toContain('generatePdfReport');
    expect(d).not.toContain('"rows"');
  });
});

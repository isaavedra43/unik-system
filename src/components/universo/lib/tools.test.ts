import { describe, expect, it } from 'vitest';
import { stepLabel, toolCategory } from './tools';
import { workspaceTabForTool } from './agents';

describe('universo tool presentation', () => {
  it('labels browser steps with the site, not raw arguments', () => {
    expect(
      stepLabel('browser', { action: 'open', url: 'https://www.marmoles.mx/precios' }, true)
    ).toBe('Abriendo: marmoles.mx');
    expect(stepLabel('browser', { action: 'click', target: 'Cotizar' }, false)).toBe(
      'Clic: «Cotizar»'
    );
    expect(stepLabel('venueExec', { command: 'npm test' }, true)).toBe('Ejecutando: npm test');
    expect(stepLabel('delegateTask', { goal: 'Revisar facturas vencidas' }, false)).toBe(
      'Delegó: Revisar facturas vencidas'
    );
  });

  it('routes each tool to its category and workspace surface', () => {
    expect(toolCategory('web_search')).toBe('web');
    expect(toolCategory('venueExec')).toBe('terminal');
    expect(toolCategory('computer')).toBe('computer');
    expect(toolCategory('publishSite')).toBe('sites');
    expect(toolCategory('composioExecute')).toBe('apps');
    expect(workspaceTabForTool('browser')).toBe('browser');
    expect(workspaceTabForTool('venueExec')).toBe('computer');
    expect(workspaceTabForTool('generatePdfReport')).toBe('files');
    expect(workspaceTabForTool('delegateTask')).toBe('team');
    expect(workspaceTabForTool('querySalesOrders')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { OPERATIONS_TOOL_NAMES, detectDomains, findToolsByTopic, selectToolsForTurn, type SelectableTool } from './tool-selector';

function tool(name: string, description = '', category = 'operations'): SelectableTool {
  return { name, description, category, effect: 'read' };
}

function catalog(): SelectableTool[] {
  const operations = OPERATIONS_TOOL_NAMES.map((n) => tool(n, `Herramienta de operaciones ${n}`));
  const others = ['querySalesOrders', 'queryInvoices', 'getTopProducts', 'generatePdfReport', 'callContact', 'listCampaigns'].map((n) => tool(n, `Herramienta ${n}`, 'sales'));
  const filler = Array.from({ length: 150 }, (_, i) => tool(`fillerTool${i}`, 'Consulta genérica de relleno', 'system'));
  return [...others, ...filler, ...operations];
}

describe('operations domain', () => {
  it('detects the operations vocabulary (accents and inflections included)', () => {
    const samples = [
      'abre el expediente EXP-12',
      'la sala de la venta 23131',
      'manda una solicitud a compras',
      'escálalo con administración',
      'hay una incidencia con la entrega',
      'asigna transportista o fletera',
      'la paquetería no ha pasado',
      'conté 10 m2 y 2 dañadas',
      'qué pedidos están atorados',
      'la orden está trabada',
      'pide cotización de proveedor',
      'orden de producción con merma en el corte',
      'registra el gasto de caja chica',
      'qué obligación vence hoy',
      'nueva oportunidad en el radar',
    ];
    for (const text of samples) expect(detectDomains(text), text).toContain('operations');
    expect(detectDomains('hola, buenos días')).not.toContain('operations');
  });

  it('prefers operations tools for a stuck-case question among a big catalog', () => {
    const res = selectToolsForTurn({ tools: catalog(), message: '¿quién está bloqueando el expediente? está atorado desde ayer', maxTools: 24 });
    const names = res.offered.map((t) => t.name);
    expect(res.domains).toContain('operations');
    for (const expected of ['whoIsBlocking', 'findStuckCases', 'getCaseSnapshot', 'escalateCase']) expect(names).toContain(expected);
  });

  it('finds tools by operations topic for loadMoreTools', () => {
    const found = findToolsByTopic(catalog(), 'transportista para la entrega', 10).map((t) => t.name);
    expect(found).toContain('assignCarrier');
    const counts = findToolsByTopic(catalog(), 'registrar un conteo', 10).map((t) => t.name);
    expect(counts).toContain('recordCount');
  });
});

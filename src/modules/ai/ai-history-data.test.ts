import { describe, it, expect } from 'vitest';
import { findLastDataToolResult, isArtifactResult, collectRowArrays } from './ai-history-data';

const orders = [
  { number: 'OV-1', customer: 'A', total: '100.00' },
  { number: 'OV-2', customer: 'B', total: '250.50' },
];

function assistantCall(id: string, name: string, args: Record<string, unknown>) {
  return { role: 'assistant', content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}
function toolResult(id: string, result: unknown) {
  return { role: 'tool', content: JSON.stringify(result), toolCallId: id };
}

describe('findLastDataToolResult', () => {
  it('skips a generateTable artifact result and finds the querySalesOrders rows underneath (the "PDF falla en 0 ms" bug)', () => {
    const history = [
      { role: 'user', content: 'ventas abiertas' },
      assistantCall('c1', 'querySalesOrders', { dateRange: 'this_year', deliveryType: 'instalacion' }),
      toolResult('c1', { mode: 'list', total: 2, showing: 2, orders }),
      assistantCall('c2', 'generateTable', { title: 'Órdenes abiertas' }),
      toolResult('c2', { artifactId: 'tbl-1', type: 'table', title: 'Órdenes abiertas', inlineRender: true }),
      { role: 'assistant', content: 'Aquí tienes la tabla.' },
      { role: 'user', content: 'dame un pdf de todas estas' },
    ];
    const found = findLastDataToolResult(history);
    expect(found).not.toBeNull();
    expect(found!.toolName).toBe('querySalesOrders');
    expect(found!.toolArgs).toEqual({ dateRange: 'this_year', deliveryType: 'instalacion' });
    expect(found!.rows).toHaveLength(2);
    expect(found!.result.total).toBe(2);
  });

  it('resolves the originating call by toolCallId, not by "last call of the previous message"', () => {
    const history = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'a', name: 'querySalesOrders', arguments: JSON.stringify({ dateRange: 'today' }) },
          { id: 'b', name: 'generateTable', arguments: JSON.stringify({ title: 'T' }) },
        ],
      },
      toolResult('a', { mode: 'list', total: 2, orders }),
      toolResult('b', { artifactId: 'tbl', type: 'table', inlineRender: true }),
    ];
    const found = findLastDataToolResult(history);
    expect(found!.toolName).toBe('querySalesOrders');
    expect(found!.toolArgs).toEqual({ dateRange: 'today' });
  });

  it('skips error results and multi-image artifact results', () => {
    const history = [
      assistantCall('c1', 'queryPurchaseOrders', { vendor: 'X' }),
      toolResult('c1', { mode: 'list', total: 1, purchaseOrders: [{ number: 'PO-1' }] }),
      assistantCall('c2', 'generateReportImage', { title: 'Img' }),
      toolResult('c2', { artifacts: [{ artifactId: 'i1', type: 'image' }], imageCount: 1 }),
      assistantCall('c3', 'generatePdfReport', { title: 'P' }),
      toolResult('c3', { error: 'No recibí filas' }),
    ];
    const found = findLastDataToolResult(history);
    expect(found!.toolName).toBe('queryPurchaseOrders');
    expect(found!.rows[0].number).toBe('PO-1');
  });

  it('returns null when no data result exists', () => {
    expect(findLastDataToolResult([{ role: 'user', content: 'hola' }])).toBeNull();
    expect(findLastDataToolResult([toolResult('x', { found: false })])).toBeNull();
  });

  it('exposes every array field for multi-section PDFs', () => {
    const history = [
      assistantCall('c1', 'getSalesOrdersSummary', {}),
      toolResult('c1', { byStatus: [{ key: 'Cerrada', count: 3 }], bySalesperson: [{ key: 'Ana', count: 2 }], total: 5 }),
    ];
    const found = findLastDataToolResult(history)!;
    expect(Object.keys(found.arrays)).toEqual(['byStatus', 'bySalesperson']);
  });
});

describe('isArtifactResult / collectRowArrays', () => {
  it('recognizes artifact results by artifactId, artifacts[] or typed download', () => {
    expect(isArtifactResult({ artifactId: 'x', type: 'pdf' })).toBe(true);
    expect(isArtifactResult({ artifacts: [] })).toBe(true);
    expect(isArtifactResult({ type: 'pdf', downloadUrl: '/x' })).toBe(true);
    expect(isArtifactResult({ mode: 'list', orders })).toBe(false);
  });

  it('collects only arrays of objects', () => {
    expect(Object.keys(collectRowArrays({ orders, numbers: [1, 2], empty: [], total: 2 }))).toEqual(['orders']);
  });
});

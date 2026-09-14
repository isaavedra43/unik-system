import { describe, it, expect } from 'vitest';
import {
  findLastDataToolResult,
  isArtifactResult,
  collectRowArrays,
  pickPrimaryRowArray,
  declaredRowTotal,
  resolveReportRows,
} from './ai-history-data';

/** querySalesOrders list mode, key order as the tool returns it: the breakdown comes BEFORE orders. */
function salesListResult(total: number, showing: number) {
  const pageOrders = Array.from({ length: showing }, (_, i) => ({ number: `OV-${23000 + i}`, customer: `C${i}`, total: '100.00' }));
  return {
    mode: 'list',
    total,
    showing,
    page: 1,
    pageSize: 50,
    totalPages: Math.ceil(total / 50),
    totalSum: '3080682.99',
    balanceSum: '689124.14',
    statusReconciliation: { totalWithoutStatusFilters: 88, matched: total },
    ticketStatusBreakdown: [{ ticketStatus: 'Pendiente de envío', count: total, total: '3080682.99', orderNumbers: ['OV-1'] }],
    closedVsOpen: { cerradas: 0, anuladas: 0, noCerradas: total },
    orders: pageOrders,
  };
}
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ number: `OV-${i}` }));

describe('report rows: "me dijo 65 y el PDF traía 9" (2026-09-14)', () => {
  it('picks orders, not the ticketStatusBreakdown that comes first', () => {
    const picked = pickPrimaryRowArray(salesListResult(65, 50));
    expect(picked!.key).toBe('orders');
    expect(picked!.rows).toHaveLength(50);
  });

  it('seeds the export from orders when the PDF is requested in a later message', () => {
    const history = [
      assistantCall('q', 'querySalesOrders', { dateRange: 'this_month', deliveryMethod: 'pie de obra', ticketStatus: 'sin cerrar' }),
      toolResult('q', salesListResult(65, 50)),
      { role: 'assistant', content: 'Son 65 órdenes…' },
      { role: 'user', content: 'generame el pdf con el reporte' },
    ];
    const found = findLastDataToolResult(history)!;
    expect(found.rowKey).toBe('orders');
    expect(found.rows).toHaveLength(50);
    expect(declaredRowTotal(found.result)).toBe(65);
  });

  it('uses the 65 system rows over 9 rows the model typed', () => {
    const d = resolveReportRows({ modelRows: rows(9), systemRows: rows(65), expectedRows: 65, subsetOnly: false, exportCap: 5000 });
    expect(d.source).toBe('system');
    expect(d.rows).toHaveLength(65);
    expect(d.complete).toBe(true);
    expect(d.blockReason).toBeUndefined();
  });

  it('blocks the report when the export could not get every row (never a silent partial file)', () => {
    const d = resolveReportRows({ modelRows: rows(9), systemRows: rows(50), expectedRows: 65, subsetOnly: false, exportCap: 5000 });
    expect(d.complete).toBe(false);
    expect(d.blockReason).toContain('50 de 65');
  });

  it('delivers a labeled partial only when the export cap is hit', () => {
    const d = resolveReportRows({ modelRows: null, systemRows: rows(5000), expectedRows: 6200, subsetOnly: false, exportCap: 5000 });
    expect(d.complete).toBe(false);
    expect(d.blockReason).toBeUndefined();
    expect(d.includedRows).toBe(5000);
  });

  it('marks an explicit subset as incomplete so it is labeled, not presented as the full report', () => {
    const d = resolveReportRows({ modelRows: rows(3), systemRows: rows(65), expectedRows: 65, subsetOnly: true, exportCap: 5000 });
    expect(d.source).toBe('model');
    expect(d.complete).toBe(false);
    expect(d.blockReason).toBeUndefined();
  });

  it('keeps model rows only when they exceed a complete result (several results merged)', () => {
    const d = resolveReportRows({ modelRows: rows(80), systemRows: rows(65), expectedRows: 65, subsetOnly: false, exportCap: 5000 });
    expect(d.source).toBe('model');
    expect(d.rows).toHaveLength(80);
  });

  it('does not treat grouped counts or money totals as a row count', () => {
    expect(declaredRowTotal({ mode: 'grouped', totalOrders: 65, groups: [] })).toBeNull();
    expect(declaredRowTotal({ showing: 3, total: '1500.00' })).toBeNull();
    expect(declaredRowTotal({ byStatus: [], total: 5 })).toBeNull();
  });

  it('summary-only results still use their first array', () => {
    expect(pickPrimaryRowArray({ byStatus: [{ key: 'A' }], bySalesperson: [{ key: 'B' }] })!.key).toBe('byStatus');
  });
});

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

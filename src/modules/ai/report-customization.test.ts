import { describe, it, expect } from 'vitest';
import {
  applyColumnCustomization,
  applyRowCustomization,
  applySummaryCardCustomization,
  detectReportCustomization,
  formatItemsList,
  looksLikeItemList,
  mergeReportCustomization,
  normalizeCustomization,
  resolveColumnKey,
  resolveReportCustomization,
  wantsTotalsRow,
} from './report-customization';
import { parseNumeric } from './ai-report-helpers';

const SALES_COLUMNS = [
  { header: 'Orden', key: 'number' },
  { header: 'Fecha', key: 'date', format: 'date' },
  { header: 'Cliente', key: 'customer' },
  { header: 'Vendedor', key: 'salesperson' },
  { header: 'Total', key: 'total', format: 'currency' },
  { header: 'Saldo', key: 'balance', format: 'currency' },
];

describe('detectReportCustomization — amounts', () => {
  it('a plain report request asks for no amounts', () => {
    expect(
      detectReportCustomization('dame el reporte de las ventas a pie de obra de este mes')
        .showTotals
    ).toBeUndefined();
  });

  it('asking for totals/saldo turns the money on', () => {
    expect(detectReportCustomization('dame el reporte con el total y el saldo').showTotals).toBe(
      true
    );
    expect(detectReportCustomization('¿cuánto suman esas órdenes?').showTotals).toBe(true);
  });

  it('an explicit "sin totales" wins over the money words in the same phrase', () => {
    expect(detectReportCustomization('el mismo reporte pero sin totales').showTotals).toBe(false);
    expect(detectReportCustomization('quita el total y el saldo').showTotals).toBe(false);
  });
});

describe('detectReportCustomization — layout instructions', () => {
  it('reads hidden columns', () => {
    const cust = detectReportCustomization('genera el PDF pero quita la columna vendedor y método');
    expect(cust.hideColumns).toEqual(['vendedor', 'metodo']);
  });

  it('reads added columns', () => {
    expect(detectReportCustomization('agrega la columna teléfono').addColumns).toEqual([
      'telefono',
    ]);
  });

  it('reads an explicit column set', () => {
    const cust = detectReportCustomization('solo las columnas orden, cliente y productos');
    expect(cust.columns).toEqual(['orden', 'cliente', 'productos']);
  });

  it('reads sorting', () => {
    expect(detectReportCustomization('ordénalo por cliente')).toMatchObject({
      sortBy: 'cliente',
      sortDirection: 'asc',
    });
    expect(detectReportCustomization('ordénalo por total de mayor a menor')).toMatchObject({
      sortDirection: 'desc',
    });
  });

  it('reads colors, orientation and font size', () => {
    expect(detectReportCustomization('pon el encabezado en rojo').brandColor).toBe('#dc2626');
    expect(detectReportCustomization('ponlo en verde').brandColor).toBe('#16a34a');
    expect(detectReportCustomization('usa el color #123456').brandColor).toBe('#123456');
    // A color that is part of the DATA, not a styling instruction.
    expect(
      detectReportCustomization('dame las ventas de marmol verde de este mes').brandColor
    ).toBeUndefined();
    expect(detectReportCustomization('ponlo en vertical').orientation).toBe('portrait');
    expect(detectReportCustomization('con la letra más grande').fontSize).toBe(9.5);
  });

  it('reads product-list preferences', () => {
    expect(detectReportCustomization('el mismo pero sin los productos').itemsStyle).toBe('none');
    expect(detectReportCustomization('lista los productos sin precios').itemPrices).toBe(false);
    expect(detectReportCustomization('dame el PDF').itemPrices).toBeUndefined();
  });

  it('leaves a neutral request untouched', () => {
    expect(detectReportCustomization('gracias, mándame el PDF')).toEqual({});
  });
});

describe('resolveColumnKey', () => {
  it('maps Spanish labels to row keys', () => {
    expect(resolveColumnKey('saldo')).toBe('balance');
    expect(resolveColumnKey('Dirección')).toBe('shippingAddress');
    expect(resolveColumnKey('la columna de vendedor')).toBe('salesperson');
  });

  it('keeps a key that already exists in the rows', () => {
    expect(resolveColumnKey('customer', ['customer', 'total'])).toBe('customer');
  });
});

describe('applyColumnCustomization', () => {
  it('drops Total and Saldo when no amounts were asked for', () => {
    const cols = applyColumnCustomization(SALES_COLUMNS, { showTotals: false });
    expect(cols.map((c) => c.key)).toEqual(['number', 'date', 'customer', 'salesperson']);
  });

  it('keeps them when the user asked for amounts', () => {
    const cols = applyColumnCustomization(SALES_COLUMNS, { showTotals: true });
    expect(cols.map((c) => c.key)).toContain('total');
    expect(cols.map((c) => c.key)).toContain('balance');
  });

  it('keeps a money column the user named explicitly even with showTotals=false', () => {
    const cust = normalizeCustomization({ showTotals: false, addColumns: ['saldo'] });
    const cols = applyColumnCustomization(SALES_COLUMNS, cust);
    expect(cols.map((c) => c.key)).toContain('balance');
    expect(cols.map((c) => c.key)).not.toContain('total');
  });

  it('hides, reorders and renames', () => {
    const cust = normalizeCustomization({
      hideColumns: ['vendedor'],
      columnLabels: { saldo: 'Por cobrar' },
    });
    const cols = applyColumnCustomization(SALES_COLUMNS, cust);
    expect(cols.map((c) => c.key)).not.toContain('salesperson');
    expect(cols.find((c) => c.key === 'balance')?.header).toBe('Por cobrar');
  });

  it('an explicit column list sets the order', () => {
    const cust = normalizeCustomization({ columns: ['cliente', 'orden'] });
    expect(applyColumnCustomization(SALES_COLUMNS, cust).map((c) => c.key)).toEqual([
      'customer',
      'number',
    ]);
  });

  it('never returns an empty table', () => {
    const cust = normalizeCustomization({ hideColumns: SALES_COLUMNS.map((c) => c.key) });
    expect(applyColumnCustomization(SALES_COLUMNS, cust).length).toBeGreaterThan(0);
  });
});

describe('applyRowCustomization', () => {
  const rows = [
    { customer: 'Sonia', total: '6027.84' },
    { customer: 'Ana', total: '46200' },
  ];

  it('sorts text alphabetically', () => {
    const sorted = applyRowCustomization(rows, { sortBy: 'customer' }, parseNumeric);
    expect(sorted.map((r) => r.customer)).toEqual(['Ana', 'Sonia']);
  });

  it('sorts numbers numerically, descending', () => {
    const sorted = applyRowCustomization(
      rows,
      { sortBy: 'total', sortDirection: 'desc' },
      parseNumeric
    );
    expect(sorted.map((r) => r.total)).toEqual(['46200', '6027.84']);
  });

  it('leaves the rows alone with no sort (and never mutates them)', () => {
    expect(applyRowCustomization(rows, {}, parseNumeric)).toBe(rows);
  });
});

describe('applySummaryCardCustomization', () => {
  const cards = [
    { label: 'Órdenes', value: '65' },
    { label: 'Total', value: '$3,080,682.99' },
    { label: 'Saldo pendiente', value: '$689,124.14' },
  ];

  it('strips the money KPIs when no amounts were asked for', () => {
    expect(applySummaryCardCustomization(cards, { showTotals: false })).toEqual([
      { label: 'Órdenes', value: '65' },
    ]);
  });

  it('keeps everything when amounts were asked for', () => {
    expect(applySummaryCardCustomization(cards, { showTotals: true })).toEqual(cards);
  });

  it('hides every card on request', () => {
    expect(applySummaryCardCustomization(cards, { showSummaryCards: false })).toBeUndefined();
  });

  it('strips a money card the model typed without a "$"', () => {
    const typed = [
      { label: 'Órdenes', value: '65' },
      { label: 'Total', value: '3,080,682.99' },
      { label: 'Saldo pendiente', value: '689124.14 MXN' },
      { label: 'Ingresos', value: '1.2M' },
    ];
    expect(applySummaryCardCustomization(typed, { showTotals: false })).toEqual([
      { label: 'Órdenes', value: '65' },
    ]);
  });

  it('keeps count cards whose label is not about money', () => {
    const counts = [
      { label: 'Órdenes', value: '65' },
      { label: 'Clientes', value: '12' },
      { label: 'Grupos', value: '4' },
    ];
    expect(applySummaryCardCustomization(counts, { showTotals: false })).toEqual(counts);
  });
});

describe('wantsTotalsRow', () => {
  it('follows showTotals unless overridden', () => {
    expect(wantsTotalsRow({})).toBe(true);
    expect(wantsTotalsRow({ showTotals: false })).toBe(false);
    expect(wantsTotalsRow({ showTotals: false, showTotalsRow: true })).toBe(true);
  });
});

describe('mergeReportCustomization', () => {
  it('later objects win field by field, ignoring undefined', () => {
    expect(
      mergeReportCustomization({ showTotals: false, sortBy: 'a' }, { showTotals: true }, undefined)
    ).toEqual({
      showTotals: true,
      sortBy: 'a',
    });
  });
});

describe('formatItemsList', () => {
  const items = [
    {
      name: 'Marmol Jalapa Natural 30xLLx1',
      sku: 'UPC-1110',
      quantity: '120',
      unit: 'm2',
      rate: '385',
      lineTotal: '46200',
    },
    {
      name: 'Flete',
      sku: 'UPC-1858',
      quantity: '1',
      rate: '0',
      lineTotal: '0',
      description: 'MATERIAL LIBRE DE MANIOBRAS DE DESCARGA',
    },
  ];

  it('recognizes a product list', () => {
    expect(looksLikeItemList(items)).toBe(true);
    expect(looksLikeItemList(['a', 'b'])).toBe(false);
    expect(looksLikeItemList([])).toBe(false);
  });

  it('writes numbered lines instead of the raw key: value dump', () => {
    const text = formatItemsList(items);
    expect(text).toContain('1. Marmol Jalapa Natural 30xLLx1 · SKU UPC-1110');
    expect(text).toContain('120 m2 × $385.00 = $46,200.00');
    expect(text).not.toContain('lineTotal');
    // A zero-priced line (flete) shows no "× $0.00 = $0.00" and no lonely "1".
    expect(text).toContain('2. Flete · SKU UPC-1858');
    expect(text).not.toContain('$0.00');
    expect(text.split('\n')).not.toContain('    1');
    expect(text).toContain('MATERIAL LIBRE DE MANIOBRAS DE DESCARGA');
  });

  it('compact style keeps one product per line', () => {
    const lines = formatItemsList(items, { style: 'compact' }).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      '1. Marmol Jalapa Natural 30xLLx1 · SKU UPC-1110 — 120 m2 × $385.00 = $46,200.00'
    );
  });

  it('omits prices when amounts are hidden, and everything with style none', () => {
    expect(formatItemsList(items, { showMoney: false })).not.toContain('$');
    expect(formatItemsList(items, { style: 'none' })).toBe('');
  });

  it('honors an explicit field list', () => {
    expect(formatItemsList(items, { style: 'compact', fields: ['name', 'quantity', 'unit'] })).toBe(
      '1. Marmol Jalapa Natural 30xLLx1 — 120 m2\n2. Flete'
    );
    expect(formatItemsList([{ name: 'Manufactura', quantity: '23' }], { style: 'compact' })).toBe(
      '1. Manufactura — Cantidad: 23'
    );
  });
});

describe('detectReportCustomization — compound instructions', () => {
  it('keeps each instruction in its own field (no run-on capture)', () => {
    const cust = detectReportCustomization(
      'genera el PDF pero quita la columna vendedor y método, ordénalo por cliente y pon el encabezado en rojo'
    );
    expect(cust).toEqual({
      showTotals: undefined,
      hideColumns: ['vendedor', 'metodo'],
      sortBy: 'cliente',
      sortDirection: 'asc',
      brandColor: '#dc2626',
    });
  });

  it('does not turn a sort target into a hidden column', () => {
    const cust = detectReportCustomization('quita el vendedor y ordénalo por fecha');
    expect(cust.hideColumns).toEqual(['vendedor']);
    expect(cust.sortBy).toBe('fecha');
  });

  it('a multi-word column name still resolves as one', () => {
    expect(detectReportCustomization('quita la columna método de pago').hideColumns).toEqual([
      'metodo de pago',
    ]);
  });
});

describe('resolveReportCustomization — who decides the amounts', () => {
  it('no money words in the message: amounts stay off even if the model asks for them', () => {
    const cust = resolveReportCustomization('dame el PDF de esas órdenes', { showTotals: true });
    expect(cust.showTotals).toBe(false);
  });

  it('the user asking for amounts turns them on', () => {
    expect(resolveReportCustomization('dame el PDF con el total y el saldo').showTotals).toBe(true);
  });

  it('"sin totales" keeps them off', () => {
    expect(
      resolveReportCustomization('el PDF pero sin totales', { showTotals: true }).showTotals
    ).toBe(false);
  });

  it("every other field still takes the model's value", () => {
    const cust = resolveReportCustomization('genera el PDF', {
      brandColor: '#111111',
      hideColumns: ['salesperson'],
      itemsStyle: 'compact',
    });
    expect(cust).toMatchObject({
      showTotals: false,
      brandColor: '#111111',
      hideColumns: ['salesperson'],
      itemsStyle: 'compact',
    });
  });

  it('what the user says still wins over the model for the rest', () => {
    const cust = resolveReportCustomization('ponlo en rojo', { brandColor: '#111111' });
    expect(cust.brandColor).toBe('#111111');
    expect(resolveReportCustomization('ponlo en rojo').brandColor).toBe('#dc2626');
  });
});

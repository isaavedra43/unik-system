import { describe, expect, it } from 'vitest';
import {
  expenseCompletenessIssues,
  expenseLedgerAllocations,
  expenseProposalSchema,
  mergeProposalIntoExpense,
  nextRecurrenceKey,
  parseRecurrence,
  resolveExpenseProposal,
  splitIssues,
  suggestExpenseClassification,
  type CategoryRef,
  type CostCenterRef,
  type ResolvedExpenseProposal,
} from './expense-rules';
import { D } from './money';

const category = (key: string, kind = 'expense', status = 'active', defaultCostCenterId: string | null = null): CategoryRef => ({
  id: `cat_${key}`,
  key,
  name: key,
  kind,
  status,
  defaultCostCenterId,
});
const center = (key: string, areaKey: string | null = null, status = 'active'): CostCenterRef => ({
  id: `cc_${key}`,
  key: `cc_${key}`,
  name: key,
  areaKey,
  status,
});

const categories = [
  category('combustible', 'expense', 'active', 'cc_logistica'),
  category('papeleria'),
  category('gastos_generales'),
  category('ventas', 'income'),
  category('viejo', 'expense', 'archived'),
];
const centers = [center('logistica', 'logistica'), center('ventas', 'ventas'), center('cerrado', 'compras', 'archived')];

describe('suggestExpenseClassification', () => {
  it('uses the most frequent category and center of the supplier history', () => {
    const suggestion = suggestExpenseClassification({
      supplierKey: 'n:pemex',
      history: [
        { supplierKey: 'n:pemex', categoryId: 'cat_combustible', costCenterId: 'cc_logistica', dateKey: '2026-09-01' },
        { supplierKey: 'n:pemex', categoryId: 'cat_combustible', costCenterId: 'cc_ventas', dateKey: '2026-08-01' },
        { supplierKey: 'n:pemex', categoryId: 'cat_papeleria', costCenterId: 'cc_logistica', dateKey: '2026-07-01' },
        { supplierKey: 'n:otro', categoryId: 'cat_papeleria', costCenterId: 'cc_ventas', dateKey: '2026-09-02' },
      ],
      categories,
      costCenters: centers,
    });
    expect(suggestion).toMatchObject({ categoryId: 'cat_combustible', costCenterId: 'cc_logistica', confidence: 0.9 });
    expect(suggestion.reasons[0]).toContain('2 de 3');
  });

  it('breaks ties with the most recent use and ignores archived catalog entries', () => {
    const suggestion = suggestExpenseClassification({
      supplierKey: 's:1',
      history: [
        { supplierKey: 's:1', categoryId: 'cat_papeleria', costCenterId: null, dateKey: '2026-01-01' },
        { supplierKey: 's:1', categoryId: 'cat_combustible', costCenterId: 'cc_cerrado', dateKey: '2026-05-01' },
        { supplierKey: 's:1', categoryId: 'cat_viejo', costCenterId: null, dateKey: '2026-09-01' },
        { supplierKey: 's:1', categoryId: 'cat_viejo', costCenterId: null, dateKey: '2026-09-02' },
      ],
      categories,
      costCenters: centers,
    });
    expect(suggestion.categoryId).toBe('cat_combustible');
    expect(suggestion.confidence).toBe(0.7);
    // center falls back to the category default (the history one is archived)
    expect(suggestion.costCenterId).toBe('cc_logistica');
  });

  it('falls back to keywords, then gastos generales; centers by area', () => {
    expect(
      suggestExpenseClassification({ supplierKey: '', description: 'Compré toner y hojas', areaKey: 'ventas', history: [], categories, costCenters: centers })
    ).toMatchObject({ categoryId: 'cat_papeleria', costCenterId: 'cc_ventas', confidence: 0.6 });
    expect(
      suggestExpenseClassification({ supplierKey: '', description: 'algo raro', history: [], categories, costCenters: centers })
    ).toMatchObject({ categoryId: 'cat_gastos_generales', costCenterId: null, confidence: 0.3 });
    expect(
      suggestExpenseClassification({ supplierKey: '', description: 'carga de gasolina', history: [], categories, costCenters: centers })
    ).toMatchObject({ categoryId: 'cat_combustible', costCenterId: 'cc_logistica' });
  });
});

describe('splits and completeness', () => {
  it('validates splits', () => {
    expect(splitIssues('100', [])).toEqual([]);
    expect(splitIssues('100', [{ amount: '60', costCenterId: 'a' }, { amount: '40', caseId: 'c' }])).toEqual([]);
    expect(splitIssues('100', [{ amount: '60', costCenterId: 'a' }, { amount: '39.99', projectRef: 'p' }])).toEqual([
      'El reparto suma 99.99 y el gasto es de 100.00',
    ]);
    expect(splitIssues('10', [{ amount: '10' }])[0]).toContain('indica el centro');
    expect(splitIssues('10', [{ amount: '10', pct: 120, costCenterId: 'a' }])[0]).toContain('porcentaje');
    expect(splitIssues('10', [{ amount: '0', costCenterId: 'a' }, { amount: '10', costCenterId: 'b' }])[0]).toContain('mayor que cero');
  });

  const refs = {
    categories: new Map(categories.map((c) => [c.id, c])),
    costCenters: new Map(centers.map((c) => [c.id, c])),
    cashAccounts: new Map([
      ['caja', { id: 'caja', key: 'caja', name: 'Caja', status: 'active', currency: 'MXN' }],
      ['usd', { id: 'usd', key: 'usd', name: 'Cuenta USD', status: 'active', currency: 'USD' }],
      ['cerrada', { id: 'cerrada', key: 'cerrada', name: 'Cerrada', status: 'closed', currency: 'MXN' }],
    ]),
    todayKey: '2026-09-15',
    requireCashAccount: true,
  };
  const complete = {
    amount: '100',
    currency: 'MXN',
    dateKey: '2026-09-15',
    categoryId: 'cat_papeleria',
    costCenterId: 'cc_ventas',
    isPaid: true,
    cashAccountId: 'caja',
    splits: [],
  };

  it('accepts a complete expense (a date of tomorrow is tolerated for time zones)', () => {
    expect(expenseCompletenessIssues(complete, refs)).toEqual([]);
    expect(expenseCompletenessIssues({ ...complete, dateKey: '2026-09-16' }, refs)).toEqual([]);
  });

  it.each([
    [{ amount: '0' }, 'Falta el importe del gasto'],
    [{ dateKey: '2026-09-17' }, 'La fecha del gasto no puede ser futura'],
    [{ categoryId: null }, 'Falta la categoría'],
    [{ categoryId: 'cat_ventas' }, 'La categoría ventas no admite gastos'],
    [{ categoryId: 'cat_viejo' }, 'La categoría viejo no admite gastos'],
    [{ costCenterId: 'cc_cerrado' }, 'El centro de costo no existe o está archivado'],
    [{ cashAccountId: null }, 'Indica de qué cuenta salió el dinero'],
    [{ cashAccountId: 'cerrada' }, 'La cuenta de pago no existe o está cerrada'],
    [{ cashAccountId: 'usd' }, 'La cuenta Cuenta USD es en USD y el gasto en MXN'],
  ])('%o → %s', (patch, issue) => {
    expect(expenseCompletenessIssues({ ...complete, ...patch }, refs)).toContain(issue);
  });

  it('does not require the cash account before posting', () => {
    expect(expenseCompletenessIssues({ ...complete, cashAccountId: null }, { ...refs, requireCashAccount: false })).toEqual([]);
  });

  it('builds the category side of the posting from the splits or the expense', () => {
    expect(expenseLedgerAllocations({ amount: '100', costCenterId: 'cc', caseId: 'c1', splits: [] })).toEqual([
      { amount: D('100'), costCenterId: 'cc', caseId: 'c1', projectRef: null },
    ]);
    expect(
      expenseLedgerAllocations({ amount: '100', costCenterId: 'cc', caseId: 'c1', splits: [{ amount: '70', costCenterId: 'a' }, { amount: '30', projectRef: 'p' }] })
    ).toEqual([
      { amount: D('70'), costCenterId: 'a', caseId: 'c1', projectRef: null },
      { amount: D('30'), costCenterId: null, caseId: 'c1', projectRef: 'p' },
    ]);
  });
});

describe('AI proposal', () => {
  const fallback = { categoryId: 'cat_gastos_generales', costCenterId: null, confidence: 0.3, reasons: ['fallback'] };
  const baseRefs = {
    categories,
    costCenters: centers,
    suppliers: [{ id: 'sup1', name: 'Gasolinera Pemex del Valle', taxRegNo: 'GPV010101AB1' }],
    todayKey: '2026-09-15',
    fallback,
    expenseCurrency: 'MXN',
  };

  it('parses messy model values', () => {
    const raw = expenseProposalSchema.parse({ amount: '$1,234.50', date: ' 2026-09-14 ', isPaid: 'yes', paymentMethod: ' CASH ', warnings: ['x'] });
    expect(raw).toMatchObject({ amount: 1234.5, date: '2026-09-14', isPaid: null, paymentMethod: 'cash', splits: [], supplierName: null });
  });

  it('maps catalog keys to ids and matches the supplier by RFC', () => {
    const raw = expenseProposalSchema.parse({
      amount: 812.345,
      date: '2026-09-14',
      supplierName: 'Otra razón',
      supplierRfc: 'gpv010101ab1',
      categoryKey: 'combustible',
      costCenterKey: 'cc_logistica',
      paymentMethod: 'card',
      isPaid: true,
      confidence: 0.82,
      splits: [
        { costCenterKey: 'cc_logistica', amount: 500 },
        { costCenterKey: 'cc_ventas', pct: 38.4 },
      ],
    });
    const resolved = resolveExpenseProposal(raw, baseRefs);
    expect(resolved).toMatchObject({
      amount: '812.35',
      dateKey: '2026-09-14',
      supplierId: 'sup1',
      supplierNameFree: null,
      categoryId: 'cat_combustible',
      costCenterId: 'cc_logistica',
      paymentMethod: 'card',
      isPaid: true,
      confidence: 0.82,
    });
    // 38.4 % of 812.35 = 311.94 → 500 + 311.94 ≠ 812.35: the split is ignored with a warning
    expect(resolved.splits).toEqual([]);
    expect(resolved.warnings.join(' ')).toContain('reparto');
  });

  it('keeps valid splits and warns about unknown keys, future and foreign-currency data', () => {
    const raw = expenseProposalSchema.parse({
      amount: 1000,
      currency: 'usd',
      date: '2026-09-20',
      supplierName: 'Ferretería Nueva',
      categoryKey: 'no_existe',
      costCenterKey: 'cc_cerrado',
      splits: [
        { costCenterKey: 'cc_logistica', pct: 60 },
        { costCenterKey: 'cc_ventas', amount: 400 },
      ],
    });
    const resolved = resolveExpenseProposal(raw, baseRefs);
    expect(resolved).toMatchObject({ dateKey: null, supplierId: null, supplierNameFree: 'Ferretería Nueva', categoryId: 'cat_gastos_generales', costCenterId: null, confidence: 0.3 });
    expect(resolved.splits).toEqual([
      { amount: '600.00', pct: '60', costCenterId: 'cc_logistica' },
      { amount: '400.00', pct: null, costCenterId: 'cc_ventas' },
    ]);
    expect(resolved.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('USD'),
        'La fecha propuesta es futura; se ignoró',
        'La categoría «no_existe» no existe en el catálogo',
        'El centro de costo «cc_cerrado» no existe',
      ])
    );
  });

  it('without a model answer returns the deterministic suggestion', () => {
    expect(resolveExpenseProposal(null, baseRefs)).toMatchObject({ amount: null, categoryId: 'cat_gastos_generales', confidence: 0.3, reasons: ['fallback'] });
  });

  const proposal: ResolvedExpenseProposal = {
    amount: '900.00',
    dateKey: '2026-09-14',
    supplierId: 'sup1',
    supplierNameFree: null,
    categoryId: 'cat_combustible',
    costCenterId: 'cc_logistica',
    description: 'Gasolina',
    paymentMethod: 'cash',
    isPaid: false,
    splits: [{ amount: '900.00', pct: null, costCenterId: 'cc_logistica' }],
    confidence: 0.8,
    warnings: [],
    reasons: [],
  };

  it('fills only empty fields the person did not provide', () => {
    const patch = mergeProposalIntoExpense(
      {
        amount: '0',
        dateKey: '2026-09-15',
        supplierId: null,
        supplierNameFree: null,
        categoryId: null,
        costCenterId: 'cc_ventas',
        description: null,
        paymentMethod: null,
        isPaid: true,
        splitCount: 0,
      },
      proposal,
      new Set(['date'])
    );
    expect(patch).toEqual({
      amount: D('900.00'),
      supplierId: 'sup1',
      categoryId: 'cat_combustible',
      description: 'Gasolina',
      paymentMethod: 'cash',
      isPaid: false,
      splits: proposal.splits,
    });
  });

  it('never overwrites what the person typed', () => {
    const patch = mergeProposalIntoExpense(
      {
        amount: '1200',
        dateKey: '2026-09-10',
        supplierId: null,
        supplierNameFree: 'Mi proveedor',
        categoryId: null,
        costCenterId: null,
        description: 'lo mío',
        paymentMethod: null,
        isPaid: true,
        splitCount: 0,
      },
      proposal,
      new Set(['amount', 'supplier', 'isPaid', 'categoryId', 'splits'])
    );
    // the amount is typed (1200 ≠ 900) so the 900 split is not applied either
    expect(patch).toEqual({ date: new Date('2026-09-14T00:00:00.000Z'), costCenterId: 'cc_logistica', paymentMethod: 'cash' });
  });
});

describe('recurrence', () => {
  it.each([
    [{ freq: 'daily', interval: 2 }, '2026-09-15', '2026-09-17'],
    [{ freq: 'weekly', interval: 1 }, '2026-09-15', '2026-09-22'],
    [{ freq: 'weekly', interval: 1, weekday: 1 }, '2026-09-15', '2026-09-21'],
    [{ freq: 'weekly', interval: 2, weekday: 2 }, '2026-09-15', '2026-09-29'],
    [{ freq: 'monthly', interval: 1 }, '2026-01-31', '2026-02-28'],
    [{ freq: 'monthly', interval: 1, dayOfMonth: 31 }, '2026-01-31', '2026-02-28'],
    [{ freq: 'monthly', interval: 1, dayOfMonth: 20 }, '2026-09-15', '2026-09-20'],
    [{ freq: 'monthly', interval: 3, dayOfMonth: 5 }, '2026-11-05', '2027-02-05'],
    [{ freq: 'yearly', interval: 1 }, '2028-02-29', '2029-02-28'],
  ])('%o after %s → %s', (recurrence, from, next) => {
    const parsed = parseRecurrence(recurrence);
    expect(parsed).not.toBeNull();
    expect(nextRecurrenceKey(parsed!, from)).toBe(next);
  });

  it('rejects invalid recurrences', () => {
    expect(parseRecurrence({ freq: 'hourly', interval: 1 })).toBeNull();
    expect(parseRecurrence({ freq: 'monthly', interval: 0 })).toBeNull();
    expect(parseRecurrence(null)).toBeNull();
    expect(() => nextRecurrenceKey({ freq: 'daily', interval: 1 }, 'mañana')).toThrow();
  });
});

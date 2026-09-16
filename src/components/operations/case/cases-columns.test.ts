import { describe, expect, it } from 'vitest';
import {
  CASES_TABLE_KEY,
  CASE_COLUMNS,
  CASE_COLUMN_MAP,
  CASE_DEFAULT_COLUMN_ORDER,
  CASE_EXPORT_COLUMNS,
  CASE_FILTERABLE_FIELDS,
  CASE_SORTABLE_FIELDS,
  caseExportValue,
  type CaseRow,
} from './cases-columns';

function row(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: 'c1',
    caseNumber: 'EXP-120',
    customerName: 'Constructora Norte',
    salesOrderNumber: 'SO-00123',
    zohoSalesOrderId: 'z-1',
    salesOrderId: 'so-1',
    phase: 'sourcing',
    phaseLabel: 'Abastecimiento',
    status: 'blocked',
    statusLabel: 'Bloqueado',
    priority: 'high',
    priorityLabel: 'Alta',
    ownerUserId: 'u1',
    ownerName: 'Ana',
    locationName: 'Bodega Centro',
    promisedAt: '2026-09-20T18:00:00.000Z',
    openedAt: '2026-09-10T15:00:00.000Z',
    lastActivityAt: '2026-09-15T17:30:00.000Z',
    openWorkItems: 3,
    overdueWorkItems: 1,
    openRequests: 2,
    openIncidents: 0,
    blockingAreas: ['compras', 'inventario'],
    blockingAreaLabels: ['Compras', 'Inventario'],
    risk: 'risk',
    riskLabel: 'En riesgo',
    open: true,
    version: 4,
    ...overrides,
  };
}

describe('registro de columnas de expedientes', () => {
  it('cada columna tiene un identificador único y entra en el orden por omisión', () => {
    const ids = CASE_COLUMNS.map((column) => column.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...CASE_DEFAULT_COLUMN_ORDER].sort()).toStrictEqual([...ids].sort());
    expect(Object.keys(CASE_COLUMN_MAP).sort()).toStrictEqual([...ids].sort());
  });

  it('la exportación recorre todas las columnas en el orden de lectura', () => {
    expect(CASE_EXPORT_COLUMNS.map((column) => column.id)).toStrictEqual(CASE_DEFAULT_COLUMN_ORDER);
  });

  it('sólo son filtrables u ordenables las columnas que lo declaran', () => {
    for (const column of CASE_COLUMNS) {
      expect(Boolean(CASE_FILTERABLE_FIELDS[column.field]), column.id).toBe(column.filterable);
      if (column.sortable) expect(CASE_SORTABLE_FIELDS[column.field]).toBe(column.field);
    }
    // Columnas calculadas: nunca llegan a la consulta.
    expect(CASE_FILTERABLE_FIELDS.risk).toBeUndefined();
    expect(CASE_FILTERABLE_FIELDS.blockingAreas).toBeUndefined();
    expect(CASE_SORTABLE_FIELDS.ownerUserId).toBeUndefined();
  });

  it('la llave de preferencias del usuario es estable', () => {
    expect(CASES_TABLE_KEY).toBe('operations:cases');
  });
});

describe('valores de la exportación', () => {
  it('escribe etiquetas en español, no estados internos', () => {
    const value = row();
    expect(caseExportValue(value, 'phase')).toBe('Abastecimiento');
    expect(caseExportValue(value, 'status')).toBe('Bloqueado');
    expect(caseExportValue(value, 'priority')).toBe('Alta');
    expect(caseExportValue(value, 'risk')).toBe('En riesgo');
    expect(caseExportValue(value, 'ownerName')).toBe('Ana');
    expect(caseExportValue(value, 'blockingAreas')).toBe('Compras, Inventario');
  });

  it('un expediente cerrado no exporta riesgo y los vacíos salen como texto vacío', () => {
    const closed = row({ open: false, customerName: null, promisedAt: null, locationName: null });
    expect(caseExportValue(closed, 'risk')).toBe('');
    expect(caseExportValue(closed, 'customerName')).toBe('');
    expect(caseExportValue(closed, 'promisedAt')).toBe('');
    expect(caseExportValue(closed, 'locationName')).toBe('');
  });

  it('los conteos salen como número y una columna desconocida como vacío', () => {
    const value = row();
    expect(caseExportValue(value, 'openWorkItems')).toBe('3');
    expect(caseExportValue(value, 'overdueWorkItems')).toBe('1');
    expect(caseExportValue(value, 'openIncidents')).toBe('0');
    expect(caseExportValue(value, 'inventado')).toBe('');
  });

  it('toda columna exportable tiene valor (ninguna queda sin escribir)', () => {
    const value = row();
    for (const column of CASE_EXPORT_COLUMNS) {
      expect(caseExportValue(value, column.id), column.id).not.toBe('');
    }
  });
});

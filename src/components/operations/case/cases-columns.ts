import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import type { CaseRiskLevel } from './case-model';

/**
 * Column registry of the case list (`/app/operations`), in the shape the shared
 * `EntityWorkspace` expects. PURE: no Prisma, no React.
 *
 * `sortable` and `filterable` here are the WHITE LIST the server honours: a
 * field that is not a column of this registry never reaches the query
 * (`cases-filters.ts` rejects it with 422), so nothing a person types can name
 * a database column.
 */

export const CASES_TABLE_KEY = 'operations:cases';
/** `EntityWatch.entityType` of a case (following one is personal, like any other table). */
export const CASE_ENTITY_TYPE = 'operational_case';
export const CASES_BASE_PATH = '/app/operations';

/** One row of the case list. Every value is already serialized for the client. */
export interface CaseRow {
  id: string;
  caseNumber: string;
  customerName: string | null;
  salesOrderNumber: string | null;
  zohoSalesOrderId: string | null;
  /** Local `SalesOrder.id`, so the row can link to the Zoho order detail. */
  salesOrderId: string | null;
  phase: string;
  phaseLabel: string;
  status: string;
  statusLabel: string;
  priority: string;
  priorityLabel: string;
  ownerUserId: string;
  ownerName: string | null;
  locationName: string | null;
  promisedAt: string | null;
  openedAt: string;
  lastActivityAt: string;
  openWorkItems: number;
  overdueWorkItems: number;
  openRequests: number;
  openIncidents: number;
  /** Areas with open work or an open request: who is holding the case up. */
  blockingAreas: string[];
  blockingAreaLabels: string[];
  risk: CaseRiskLevel;
  riskLabel: string;
  open: boolean;
  version: number;
}

function column(
  input: Pick<EntityColumnDefinition, 'id' | 'label' | 'field' | 'type'> &
    Partial<EntityColumnDefinition>
): EntityColumnDefinition {
  return {
    sortable: false,
    filterable: false,
    defaultVisible: true,
    defaultWidth: 160,
    minWidth: 90,
    maxWidth: 420,
    align: 'left',
    priority: 50,
    ...input,
  };
}

export const CASE_COLUMNS: EntityColumnDefinition[] = [
  column({
    id: 'caseNumber',
    label: 'Expediente',
    field: 'caseNumber',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultWidth: 140,
    minWidth: 110,
    priority: 1,
  }),
  column({
    id: 'customerName',
    label: 'Cliente',
    field: 'customerName',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultWidth: 220,
    priority: 2,
  }),
  column({
    id: 'salesOrderNumber',
    label: 'Orden de venta',
    field: 'salesOrderNumber',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultWidth: 150,
    priority: 3,
  }),
  column({
    id: 'phase',
    label: 'Fase',
    field: 'phase',
    type: 'status',
    sortable: true,
    filterable: true,
    defaultWidth: 150,
    priority: 4,
  }),
  column({
    id: 'status',
    label: 'Estado',
    field: 'status',
    type: 'status',
    sortable: true,
    filterable: true,
    defaultWidth: 140,
    priority: 5,
  }),
  column({
    id: 'risk',
    label: 'Riesgo',
    field: 'risk',
    type: 'status',
    defaultWidth: 130,
    priority: 6,
  }),
  column({
    id: 'priority',
    label: 'Prioridad',
    field: 'priority',
    type: 'status',
    sortable: true,
    filterable: true,
    defaultWidth: 120,
    defaultVisible: false,
    priority: 7,
  }),
  column({
    id: 'ownerName',
    label: 'Responsable',
    field: 'ownerUserId',
    type: 'text',
    defaultWidth: 170,
    priority: 8,
  }),
  column({
    id: 'promisedAt',
    label: 'Promesa',
    field: 'promisedAt',
    type: 'date',
    sortable: true,
    filterable: true,
    defaultWidth: 160,
    priority: 9,
  }),
  column({
    id: 'blockingAreas',
    label: 'Área bloqueante',
    field: 'blockingAreas',
    type: 'text',
    defaultWidth: 190,
    priority: 10,
  }),
  column({
    id: 'openWorkItems',
    label: 'Trabajos abiertos',
    field: 'openWorkItems',
    type: 'number',
    align: 'right',
    defaultWidth: 130,
    priority: 11,
  }),
  column({
    id: 'overdueWorkItems',
    label: 'Vencidos',
    field: 'overdueWorkItems',
    type: 'number',
    align: 'right',
    defaultWidth: 110,
    priority: 12,
  }),
  column({
    id: 'openIncidents',
    label: 'Incidencias',
    field: 'openIncidents',
    type: 'number',
    align: 'right',
    defaultWidth: 110,
    defaultVisible: false,
    priority: 13,
  }),
  column({
    id: 'locationName',
    label: 'Bodega',
    field: 'locationName',
    type: 'text',
    filterable: true,
    defaultWidth: 160,
    defaultVisible: false,
    priority: 14,
  }),
  column({
    id: 'lastActivityAt',
    label: 'Última actividad',
    field: 'lastActivityAt',
    type: 'date',
    sortable: true,
    filterable: true,
    defaultWidth: 170,
    priority: 15,
  }),
  column({
    id: 'openedAt',
    label: 'Abierto',
    field: 'openedAt',
    type: 'date',
    sortable: true,
    filterable: true,
    defaultWidth: 160,
    defaultVisible: false,
    priority: 16,
  }),
];

export const CASE_COLUMN_MAP: Record<string, EntityColumnDefinition> = Object.fromEntries(
  CASE_COLUMNS.map((columnDefinition) => [columnDefinition.id, columnDefinition])
);

export const CASE_DEFAULT_COLUMN_ORDER: string[] = [...CASE_COLUMNS]
  .sort((a, b) => a.priority - b.priority)
  .map((columnDefinition) => columnDefinition.id);

/** Filterable fields and their type (white list used by `cases-filters.ts`). */
export const CASE_FILTERABLE_FIELDS: Readonly<Record<string, EntityColumnDefinition['type']>> =
  Object.fromEntries(
    CASE_COLUMNS.filter((columnDefinition) => columnDefinition.filterable).map(
      (columnDefinition) => [columnDefinition.field, columnDefinition.type]
    )
  );

/** Sortable fields → the `OperationalCase` column they order by. */
export const CASE_SORTABLE_FIELDS: Readonly<Record<string, string>> = Object.fromEntries(
  CASE_COLUMNS.filter((columnDefinition) => columnDefinition.sortable).map((columnDefinition) => [
    columnDefinition.field,
    columnDefinition.field,
  ])
);

/** Columns of the CSV / Excel export, in reading order. */
export const CASE_EXPORT_COLUMNS: EntityColumnDefinition[] = CASE_DEFAULT_COLUMN_ORDER.map(
  (id) => CASE_COLUMN_MAP[id]
).filter((columnDefinition): columnDefinition is EntityColumnDefinition =>
  Boolean(columnDefinition)
);

/**
 * Value of a cell in the export, as plain text. PURE: the same row the table
 * shows, written the way a person reads it (labels, not raw states), so the
 * spreadsheet never leaks internal keys. An unknown column returns ''.
 */
export function caseExportValue(row: CaseRow, columnId: string): string {
  switch (columnId) {
    case 'caseNumber':
      return row.caseNumber;
    case 'customerName':
      return row.customerName ?? '';
    case 'salesOrderNumber':
      return row.salesOrderNumber ?? '';
    case 'phase':
      return row.phaseLabel;
    case 'status':
      return row.statusLabel;
    case 'risk':
      return row.open ? row.riskLabel : '';
    case 'priority':
      return row.priorityLabel;
    case 'ownerName':
      return row.ownerName ?? '';
    case 'promisedAt':
      return row.promisedAt ?? '';
    case 'blockingAreas':
      return row.blockingAreaLabels.join(', ');
    case 'openWorkItems':
      return String(row.openWorkItems);
    case 'overdueWorkItems':
      return String(row.overdueWorkItems);
    case 'openIncidents':
      return String(row.openIncidents);
    case 'locationName':
      return row.locationName ?? '';
    case 'lastActivityAt':
      return row.lastActivityAt;
    case 'openedAt':
      return row.openedAt;
    default:
      return '';
  }
}

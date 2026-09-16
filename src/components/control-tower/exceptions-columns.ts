import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import type { CtExceptionRow } from '@/modules/control-tower/exceptions-service';

/**
 * Columns of the Control Tower exceptions table (plan 7.7 `excepciones`). Pure
 * module: the page, the API route, the export and the tests read the same list.
 *
 * `field` is the name the SERVICE understands. Only the fields listed here as
 * sortable or filterable may reach `exceptions-service`, which is itself a
 * white list (`SORT_COLUMNS` and the Zod schema): a column added here without a
 * counterpart there is rejected with 422, never silently ignored.
 */

export const CT_EXCEPTIONS_TABLE_KEY = 'control_tower:exceptions';
export const CT_EXCEPTION_ENTITY_TYPE = 'ct_exception_row';
export const CT_EXCEPTIONS_BASE_PATH = '/app/admin/control-tower/excepciones';

/** Rendered by the workspace; never sorted, filtered or exported. */
export const CT_EXCEPTION_ACTIONS_COLUMN_ID = 'rowActions';

type ColumnInput = Pick<EntityColumnDefinition, 'id' | 'label' | 'field' | 'type' | 'priority'> &
  Partial<EntityColumnDefinition>;

function column(input: ColumnInput): EntityColumnDefinition {
  return {
    sortable: false,
    filterable: false,
    defaultVisible: true,
    defaultWidth: 160,
    minWidth: 90,
    maxWidth: 420,
    align: 'left',
    ...input,
  };
}

export const CT_EXCEPTION_COLUMNS: EntityColumnDefinition[] = [
  column({
    id: 'kindLabel',
    label: 'Tipo',
    field: 'kind',
    type: 'status',
    priority: 1,
    filterable: true,
    defaultWidth: 170,
    minWidth: 130,
    maxWidth: 240,
  }),
  column({
    id: 'title',
    label: 'Excepción',
    field: 'title',
    type: 'text',
    priority: 2,
    defaultWidth: 320,
    minWidth: 200,
    maxWidth: 640,
  }),
  column({
    id: 'severityLabel',
    label: 'Severidad',
    field: 'severity',
    type: 'status',
    priority: 3,
    sortable: true,
    filterable: true,
    defaultWidth: 130,
    minWidth: 110,
    maxWidth: 180,
  }),
  column({
    id: 'areaLabel',
    label: 'Área',
    field: 'areaKey',
    type: 'status',
    priority: 4,
    sortable: true,
    filterable: true,
    defaultWidth: 150,
    minWidth: 110,
    maxWidth: 220,
  }),
  column({
    id: 'ownerName',
    label: 'Responsable',
    field: 'ownerName',
    type: 'text',
    priority: 5,
    defaultWidth: 180,
    minWidth: 120,
    maxWidth: 280,
  }),
  column({
    id: 'dueAt',
    label: 'Vence',
    field: 'dueAt',
    type: 'date',
    priority: 6,
    sortable: true,
    defaultWidth: 170,
    minWidth: 120,
    maxWidth: 240,
    formatter: 'date',
  }),
  column({
    id: 'since',
    label: 'Desde',
    field: 'since',
    type: 'date',
    priority: 7,
    sortable: true,
    defaultWidth: 170,
    minWidth: 120,
    maxWidth: 240,
    formatter: 'date',
  }),
  column({
    id: 'caseNumber',
    label: 'Expediente',
    field: 'caseNumber',
    type: 'text',
    priority: 8,
    sortable: true,
    defaultWidth: 150,
    minWidth: 110,
    maxWidth: 220,
  }),
  column({
    id: 'customerName',
    label: 'Cliente',
    field: 'customerName',
    type: 'text',
    priority: 9,
    defaultWidth: 200,
    minWidth: 130,
    maxWidth: 320,
  }),
  column({
    id: 'detail',
    label: 'Detalle',
    field: 'detail',
    type: 'text',
    priority: 10,
    defaultVisible: false,
    defaultWidth: 260,
    minWidth: 150,
    maxWidth: 520,
  }),
  column({
    id: 'status',
    label: 'Estado',
    field: 'status',
    type: 'text',
    priority: 11,
    defaultVisible: false,
    defaultWidth: 150,
    minWidth: 110,
    maxWidth: 220,
  }),
  column({
    id: CT_EXCEPTION_ACTIONS_COLUMN_ID,
    label: 'Acciones',
    field: CT_EXCEPTION_ACTIONS_COLUMN_ID,
    type: 'text',
    priority: 12,
    align: 'right',
    defaultWidth: 110,
    minWidth: 90,
    maxWidth: 140,
  }),
];

export const CT_EXCEPTION_COLUMN_MAP: Record<string, EntityColumnDefinition> = Object.fromEntries(
  CT_EXCEPTION_COLUMNS.map((entry) => [entry.id, entry])
);

export const CT_EXCEPTION_DEFAULT_COLUMN_ORDER: string[] = CT_EXCEPTION_COLUMNS.map(
  (entry) => entry.id
);

/** Sort fields the service accepts (`SORT_COLUMNS` of exceptions-service). */
export const CT_EXCEPTION_SORTABLE_FIELDS: readonly string[] = CT_EXCEPTION_COLUMNS.filter(
  (entry) => entry.sortable
).map((entry) => entry.field);

/** Filter fields mapped to the service arrays (`kind`, `severity`, `areaKey`). */
export const CT_EXCEPTION_FILTERABLE_FIELDS: readonly string[] = CT_EXCEPTION_COLUMNS.filter(
  (entry) => entry.filterable
).map((entry) => entry.field);

export const CT_EXCEPTION_EXPORT_COLUMNS: EntityColumnDefinition[] = CT_EXCEPTION_COLUMNS.filter(
  (entry) => entry.id !== CT_EXCEPTION_ACTIONS_COLUMN_ID
);

/** Value of a row for the export, already a string. */
export function exceptionExportValue(row: CtExceptionRow, columnId: string): string {
  switch (columnId) {
    case 'kindLabel':
      return row.kindLabel;
    case 'title':
      return row.title;
    case 'severityLabel':
      return row.severityLabel;
    case 'areaLabel':
      return row.areaLabel;
    case 'ownerName':
      return row.ownerName ?? '';
    case 'dueAt':
      return row.dueAt ?? '';
    case 'since':
      return row.since;
    case 'caseNumber':
      return row.caseNumber ?? '';
    case 'customerName':
      return row.customerName ?? '';
    case 'detail':
      return row.detail ?? '';
    case 'status':
      return row.status;
    default:
      return '';
  }
}

export const CT_EXCEPTION_DEFAULT_PAGE_SIZE = 50;

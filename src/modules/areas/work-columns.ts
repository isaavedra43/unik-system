import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import type { AreaExtraColumn, AreaMeta } from './area-registry';

/**
 * Columns of the area work centres (plan 7.4): the common set every area shows
 * plus the extra columns each area declares in the registry. The `field` of a
 * column is the SQL alias of the row (`dueAt`, `caseNumber`…) or `extra.<key>`
 * for an area extra, which is what `work-rows-sql.ts` allows in filters and
 * sorting — nothing outside this list ever reaches SQL.
 */

/** Actions column: rendered by the workspace, never sorted, filtered or exported. */
export const AREA_ACTIONS_COLUMN_ID = 'rowActions';

/** Prefix of a column that reads from `AreaWorkRow.extra`. */
export const EXTRA_FIELD_PREFIX = 'extra.';

type ColumnInput = Pick<EntityColumnDefinition, 'id' | 'label' | 'field' | 'type' | 'priority'> &
  Partial<EntityColumnDefinition>;

function column(input: ColumnInput): EntityColumnDefinition {
  return {
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 160,
    minWidth: 90,
    maxWidth: 420,
    align: 'left',
    ...input,
  };
}

/** Columns shared by the six areas, in display order. */
export const COMMON_WORK_COLUMNS: EntityColumnDefinition[] = [
  column({
    id: 'rowKind',
    label: 'Tipo',
    field: 'rowKind',
    type: 'status',
    priority: 1,
    defaultWidth: 150,
    minWidth: 120,
    maxWidth: 220,
  }),
  column({
    id: 'title',
    label: 'Pendiente',
    field: 'title',
    type: 'text',
    priority: 2,
    defaultWidth: 320,
    minWidth: 180,
    maxWidth: 640,
  }),
  column({
    id: 'status',
    label: 'Estado',
    field: 'status',
    type: 'status',
    priority: 3,
    defaultWidth: 150,
    minWidth: 110,
    maxWidth: 220,
    formatter: 'statusDot',
  }),
  column({
    id: 'dueAt',
    label: 'Vence',
    field: 'dueAt',
    type: 'date',
    priority: 4,
    defaultWidth: 170,
    minWidth: 120,
    maxWidth: 240,
    formatter: 'date',
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
    // Names are resolved after the query (one batch read), never joined in SQL.
    sortable: false,
    filterable: false,
  }),
  column({
    id: 'caseNumber',
    label: 'Expediente',
    field: 'caseNumber',
    type: 'text',
    priority: 6,
    defaultWidth: 140,
    minWidth: 110,
    maxWidth: 200,
  }),
  column({
    id: 'customerName',
    label: 'Cliente',
    field: 'customerName',
    type: 'text',
    priority: 7,
    defaultWidth: 200,
    minWidth: 130,
    maxWidth: 320,
  }),
  column({
    id: 'priority',
    label: 'Prioridad',
    field: 'priority',
    type: 'status',
    priority: 8,
    defaultWidth: 130,
    minWidth: 100,
    maxWidth: 180,
    defaultVisible: false,
  }),
  column({
    id: 'lastActivityAt',
    label: 'Última actividad',
    field: 'lastActivityAt',
    type: 'date',
    priority: 9,
    defaultWidth: 170,
    minWidth: 120,
    maxWidth: 240,
    formatter: 'date',
    defaultVisible: false,
  }),
  column({
    id: 'counterpartyName',
    label: 'Contraparte',
    field: 'counterpartyName',
    type: 'text',
    priority: 10,
    defaultWidth: 190,
    minWidth: 130,
    maxWidth: 300,
    defaultVisible: false,
  }),
  column({
    id: 'locationCode',
    label: 'Ubicación',
    field: 'locationCode',
    type: 'text',
    priority: 11,
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 220,
    defaultVisible: false,
  }),
  column({
    id: 'amount',
    label: 'Importe',
    field: 'amount',
    type: 'currency',
    priority: 12,
    defaultWidth: 150,
    minWidth: 110,
    maxWidth: 220,
    align: 'right',
    formatter: 'currency',
    defaultVisible: false,
  }),
  column({
    id: 'quantity',
    label: 'Cantidad',
    field: 'quantity',
    type: 'number',
    priority: 13,
    defaultWidth: 130,
    minWidth: 100,
    maxWidth: 200,
    align: 'right',
    defaultVisible: false,
  }),
  column({
    id: 'escalationLevel',
    label: 'Escalación',
    field: 'escalationLevel',
    type: 'number',
    priority: 14,
    defaultWidth: 130,
    minWidth: 100,
    maxWidth: 180,
    align: 'right',
    defaultVisible: false,
  }),
];

const ACTIONS_COLUMN: EntityColumnDefinition = column({
  id: AREA_ACTIONS_COLUMN_ID,
  label: 'Acciones',
  field: AREA_ACTIONS_COLUMN_ID,
  type: 'text',
  priority: 99,
  defaultWidth: 120,
  minWidth: 110,
  maxWidth: 160,
  align: 'right',
  sortable: false,
  filterable: false,
});

/** Column id of an area extra (`sku` → `extra_sku`). */
export function extraColumnId(field: string): string {
  return `extra_${field}`;
}

/** Field of an area extra (`sku` → `extra.sku`), the only shape SQL accepts for JSON values. */
export function extraColumnField(field: string): string {
  return `${EXTRA_FIELD_PREFIX}${field}`;
}

/** `extra.sku` → `sku`; null for a common column. */
export function extraFieldKey(field: string): string | null {
  return field.startsWith(EXTRA_FIELD_PREFIX) ? field.slice(EXTRA_FIELD_PREFIX.length) : null;
}

function toColumn(extra: AreaExtraColumn, index: number): EntityColumnDefinition {
  return column({
    id: extraColumnId(extra.field),
    label: extra.label,
    field: extraColumnField(extra.field),
    type: extra.type,
    priority: 20 + index,
    defaultVisible: extra.defaultVisible ?? false,
    defaultWidth: extra.width ?? 160,
    align: extra.align ?? (extra.type === 'currency' || extra.type === 'number' ? 'right' : 'left'),
    sortable: extra.sortable ?? true,
    filterable: extra.filterable ?? true,
    ...(extra.type === 'date' ? { formatter: 'date' as const } : {}),
    ...(extra.type === 'currency' ? { formatter: 'currency' as const } : {}),
  });
}

/** Columns of an area: common set + its extras + the actions column (always last). */
export function areaWorkColumns(area: AreaMeta): EntityColumnDefinition[] {
  const extras = (area.workCenter.extraColumns ?? []).map(toColumn);
  return [...COMMON_WORK_COLUMNS, ...extras, ACTIONS_COLUMN];
}

export function areaWorkColumnMap(area: AreaMeta): Record<string, EntityColumnDefinition> {
  return Object.fromEntries(areaWorkColumns(area).map((col) => [col.id, col]));
}

export function areaWorkDefaultColumnOrder(area: AreaMeta): string[] {
  return [...areaWorkColumns(area)].sort((a, b) => a.priority - b.priority).map((col) => col.id);
}

/** Fields SQL may sort by. */
export function areaWorkSortableFields(area: AreaMeta): Set<string> {
  return new Set(
    areaWorkColumns(area)
      .filter((col) => col.sortable)
      .map((col) => col.field)
  );
}

/** Fields SQL may filter by (white list; anything else is rejected). */
export function areaWorkFilterableFields(area: AreaMeta): Set<string> {
  return new Set(
    areaWorkColumns(area)
      .filter((col) => col.filterable)
      .map((col) => col.field)
  );
}

/** Column type per field, so the filter builder knows how to cast the value. */
export function areaWorkFieldTypes(area: AreaMeta): Record<string, EntityColumnDefinition['type']> {
  return Object.fromEntries(areaWorkColumns(area).map((col) => [col.field, col.type]));
}

/** Columns exported to CSV / Excel (everything except the actions column). */
export function areaWorkExportColumns(area: AreaMeta): EntityColumnDefinition[] {
  return areaWorkColumns(area).filter((col) => col.id !== AREA_ACTIONS_COLUMN_ID);
}

import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';

export const BILLS_TABLE_KEY = 'bills';

export const BILL_COLUMNS: EntityColumnDefinition[] = [
  {
    id: 'billNumber',
    label: 'Folio',
    field: 'billNumber',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 200,
    align: 'left',
    priority: 1,
  },
  {
    id: 'status',
    label: 'Estado',
    field: 'status',
    type: 'status',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 120,
    minWidth: 90,
    maxWidth: 160,
    align: 'left',
    priority: 2,
    formatter: 'statusDot',
  },
  {
    id: 'date',
    label: 'Fecha',
    field: 'date',
    type: 'date',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 130,
    minWidth: 100,
    maxWidth: 180,
    align: 'left',
    priority: 3,
    formatter: 'date',
  },
  {
    id: 'vendorName',
    label: 'Proveedor',
    field: 'vendorName',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 180,
    minWidth: 120,
    maxWidth: 260,
    align: 'left',
    priority: 4,
  },
  {
    id: 'total',
    label: 'Total',
    field: 'total',
    type: 'currency',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 130,
    minWidth: 100,
    maxWidth: 180,
    align: 'right',
    priority: 5,
    formatter: 'currency',
  },
  {
    id: 'balance',
    label: 'Saldo',
    field: 'balance',
    type: 'currency',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 130,
    minWidth: 100,
    maxWidth: 180,
    align: 'right',
    priority: 6,
    formatter: 'currency',
  },
  {
    id: 'currencyCode',
    label: 'Moneda',
    field: 'currencyCode',
    type: 'text',
    sortable: false,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 90,
    minWidth: 70,
    maxWidth: 120,
    align: 'center',
    priority: 7,
  },
  {
    id: 'dueDate',
    label: 'Vencimiento',
    field: 'dueDate',
    type: 'date',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 130,
    minWidth: 100,
    maxWidth: 180,
    align: 'left',
    priority: 8,
    formatter: 'date',
  },
  {
    id: 'sourceRemoteModifiedAt',
    label: 'Última modificación',
    field: 'sourceRemoteModifiedAt',
    type: 'date',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 170,
    minWidth: 130,
    maxWidth: 220,
    align: 'left',
    priority: 9,
    formatter: 'date',
  },
];

export const BILL_COLUMN_MAP: Record<string, EntityColumnDefinition> = Object.fromEntries(
  BILL_COLUMNS.map((c) => [c.id, c])
);

export const BILL_DEFAULT_COLUMN_ORDER: string[] = [...BILL_COLUMNS]
  .sort((a, b) => a.priority - b.priority)
  .map((c) => c.id);

export const BILL_DEFAULT_VISIBLE_COLUMNS: string[] = BILL_COLUMNS.filter(
  (c) => c.defaultVisible
).map((c) => c.id);

export const BILL_SORTABLE_FIELDS = new Set(
  BILL_COLUMNS.filter((c) => c.sortable).map((c) => c.field)
);

export const BILL_FILTERABLE_FIELDS = new Set(
  BILL_COLUMNS.filter((c) => c.filterable).map((c) => c.field)
);

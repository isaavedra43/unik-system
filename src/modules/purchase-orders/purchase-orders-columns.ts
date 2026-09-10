import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';

export const PURCHASE_ORDERS_TABLE_KEY = 'purchase_orders';

export const PURCHASE_ORDER_COLUMNS: EntityColumnDefinition[] = [
  {
    id: 'purchaseOrderNumber',
    label: 'Folio',
    field: 'purchaseOrderNumber',
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
    maxWidth: 280,
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

export const PURCHASE_ORDER_COLUMN_MAP: Record<string, EntityColumnDefinition> =
  Object.fromEntries(PURCHASE_ORDER_COLUMNS.map((c) => [c.id, c]));

export const PURCHASE_ORDER_DEFAULT_COLUMN_ORDER: string[] = [...PURCHASE_ORDER_COLUMNS]
  .sort((a, b) => a.priority - b.priority)
  .map((c) => c.id);

export const PURCHASE_ORDER_SORTABLE_FIELDS = new Set(
  PURCHASE_ORDER_COLUMNS.filter((c) => c.sortable).map((c) => c.field)
);

export const PURCHASE_ORDER_FILTERABLE_FIELDS = new Set(
  PURCHASE_ORDER_COLUMNS.filter((c) => c.filterable).map((c) => c.field)
);

import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';

export const PAYMENTS_TABLE_KEY = 'payments';

type PaymentColumnDefinition = EntityColumnDefinition;

export const PAYMENT_COLUMNS: PaymentColumnDefinition[] = [
  {
    id: 'paymentNumber',
    label: 'Folio',
    field: 'paymentNumber',
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
    id: 'customerName',
    label: 'Cliente',
    field: 'customerName',
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
    id: 'paymentMode',
    label: 'Modo de pago',
    field: 'paymentMode',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 200,
    align: 'left',
    priority: 5,
  },
  {
    id: 'amount',
    label: 'Monto',
    field: 'amount',
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
    priority: 7,
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
    priority: 8,
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

export const PAYMENT_COLUMN_MAP: Record<string, PaymentColumnDefinition> = Object.fromEntries(
  PAYMENT_COLUMNS.map((c) => [c.id, c])
);

export const PAYMENT_DEFAULT_COLUMN_ORDER: string[] = [...PAYMENT_COLUMNS]
  .sort((a, b) => a.priority - b.priority)
  .map((c) => c.id);

export const PAYMENT_SORTABLE_FIELDS = new Set(
  PAYMENT_COLUMNS.filter((c) => c.sortable).map((c) => c.field)
);

export const PAYMENT_FILTERABLE_FIELDS = new Set(
  PAYMENT_COLUMNS.filter((c) => c.filterable).map((c) => c.field)
);

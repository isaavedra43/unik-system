/**
 * Central column registry for the Vendor Credits (Créditos de proveedor) workspace.
 *
 * Every column that can appear in the table is defined here. The UI reads
 * this registry to build column definitions, the filter builder, the column
 * manager, and exports. Never define columns ad-hoc in components.
 */

import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';

export const VENDOR_CREDITS_TABLE_KEY = 'vendor_credits';

export const VENDOR_CREDIT_COLUMNS: EntityColumnDefinition[] = [
  {
    id: 'vendorCreditNumber',
    label: 'Folio',
    field: 'vendorCreditNumber',
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
    priority: 8,
    formatter: 'date',
  },
];

export const VENDOR_CREDIT_COLUMN_MAP: Record<string, EntityColumnDefinition> =
  Object.fromEntries(VENDOR_CREDIT_COLUMNS.map((c) => [c.id, c]));

export const VENDOR_CREDIT_DEFAULT_COLUMN_ORDER: string[] = [...VENDOR_CREDIT_COLUMNS]
  .sort((a, b) => a.priority - b.priority)
  .map((c) => c.id);

export const VENDOR_CREDIT_DEFAULT_VISIBLE_COLUMNS: string[] = VENDOR_CREDIT_COLUMNS.filter(
  (c) => c.defaultVisible
).map((c) => c.id);

export const VENDOR_CREDIT_SORTABLE_FIELDS = new Set(
  VENDOR_CREDIT_COLUMNS.filter((c) => c.sortable).map((c) => c.field)
);

export const VENDOR_CREDIT_FILTERABLE_FIELDS = new Set(
  VENDOR_CREDIT_COLUMNS.filter((c) => c.filterable).map((c) => c.field)
);

export const PACKAGES_TABLE_KEY = 'packages';

interface PackageColumnDefinition {
  id: string;
  label: string;
  field: string;
  type: 'text' | 'date' | 'number' | 'currency' | 'status';
  sortable: boolean;
  filterable: boolean;
  defaultVisible: boolean;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  align: 'left' | 'right' | 'center';
  priority: number;
  formatter?: 'date' | 'currency' | 'statusDot';
}

export const PACKAGE_COLUMNS: PackageColumnDefinition[] = [
  {
    id: 'packageNumber',
    label: 'Paquete',
    field: 'packageNumber',
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
    minWidth: 100,
    maxWidth: 280,
    align: 'left',
    priority: 4,
  },
  {
    id: 'carrier',
    label: 'Paquetería',
    field: 'carrier',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 140,
    minWidth: 90,
    maxWidth: 200,
    align: 'left',
    priority: 5,
  },
  {
    id: 'trackingNumber',
    label: 'Guía',
    field: 'trackingNumber',
    type: 'text',
    sortable: false,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 160,
    minWidth: 100,
    maxWidth: 240,
    align: 'left',
    priority: 6,
  },
  {
    id: 'zohoSalesOrderId',
    label: 'Orden de venta',
    field: 'zohoSalesOrderId',
    type: 'text',
    sortable: false,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 200,
    align: 'left',
    priority: 7,
  },
  {
    id: 'sourceRemoteModifiedAt',
    label: 'Última modificación remota',
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

export const PACKAGE_COLUMN_MAP: Record<string, PackageColumnDefinition> = Object.fromEntries(
  PACKAGE_COLUMNS.map((c) => [c.id, c])
);

export const PACKAGE_SORTABLE_FIELDS = new Set(
  PACKAGE_COLUMNS.filter((c) => c.sortable).map((c) => c.field)
);

export const PACKAGE_FILTERABLE_FIELDS = new Set(
  PACKAGE_COLUMNS.filter((c) => c.filterable).map((c) => c.field)
);

export const PRODUCTS_TABLE_KEY = 'products';

export interface ProductColumnDefinition {
  id: string;
  label: string;
  field: string;
  type: 'text' | 'date' | 'number' | 'currency' | 'status' | 'boolean';
  sortable: boolean;
  filterable: boolean;
  defaultVisible: boolean;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  align: 'left' | 'right' | 'center';
  priority: number;
  formatter?: 'date' | 'currency' | 'statusDot' | 'boolean';
}

export const PRODUCT_COLUMNS: ProductColumnDefinition[] = [
  {
    id: 'name',
    label: 'Producto',
    field: 'name',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 240,
    minWidth: 120,
    maxWidth: 400,
    align: 'left',
    priority: 1,
  },
  {
    id: 'sku',
    label: 'SKU',
    field: 'sku',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 200,
    align: 'left',
    priority: 2,
  },
  {
    id: 'status',
    label: 'Estado',
    field: 'status',
    type: 'status',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 110,
    minWidth: 90,
    maxWidth: 160,
    align: 'left',
    priority: 3,
    formatter: 'statusDot',
  },
  {
    id: 'categoryName',
    label: 'Categoría',
    field: 'categoryName',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 160,
    minWidth: 100,
    maxWidth: 240,
    align: 'left',
    priority: 4,
  },
  {
    id: 'rate',
    label: 'Precio',
    field: 'rate',
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
    id: 'availableStock',
    label: 'Stock disponible',
    field: 'availableStock',
    type: 'number',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 180,
    align: 'right',
    priority: 6,
  },
  {
    id: 'unit',
    label: 'Unidad',
    field: 'unit',
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
    id: 'productType',
    label: 'Tipo',
    field: 'productType',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 100,
    minWidth: 80,
    maxWidth: 140,
    align: 'left',
    priority: 8,
  },
  {
    id: 'brand',
    label: 'Marca',
    field: 'brand',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 130,
    minWidth: 90,
    maxWidth: 200,
    align: 'left',
    priority: 9,
  },
  {
    id: 'vendorName',
    label: 'Proveedor',
    field: 'vendorName',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 160,
    minWidth: 100,
    maxWidth: 240,
    align: 'left',
    priority: 10,
  },
  {
    id: 'stockOnHand',
    label: 'Stock total',
    field: 'stockOnHand',
    type: 'number',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 130,
    minWidth: 100,
    maxWidth: 180,
    align: 'right',
    priority: 11,
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
    priority: 12,
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
    priority: 13,
    formatter: 'date',
  },
];

export const PRODUCT_COLUMN_MAP: Record<string, ProductColumnDefinition> = Object.fromEntries(
  PRODUCT_COLUMNS.map((c) => [c.id, c])
);

export const PRODUCT_DEFAULT_COLUMN_ORDER: string[] = PRODUCT_COLUMNS.sort(
  (a, b) => a.priority - b.priority
).map((c) => c.id);

export const PRODUCT_DEFAULT_VISIBLE_COLUMNS: string[] = PRODUCT_COLUMNS.filter(
  (c) => c.defaultVisible
).map((c) => c.id);

export const PRODUCT_SORTABLE_FIELDS = new Set(
  PRODUCT_COLUMNS.filter((c) => c.sortable).map((c) => c.field)
);

export const PRODUCT_FILTERABLE_FIELDS = new Set(
  PRODUCT_COLUMNS.filter((c) => c.filterable).map((c) => c.field)
);

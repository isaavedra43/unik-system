export const QUOTES_TABLE_KEY = 'quotes';

interface QuoteColumnDefinition {
  id: string; label: string; field: string;
  type: 'text' | 'date' | 'number' | 'currency' | 'status' | 'boolean';
  sortable: boolean; filterable: boolean; defaultVisible: boolean;
  defaultWidth: number; minWidth: number; maxWidth: number;
  align: 'left' | 'right' | 'center'; priority: number;
  formatter?: 'date' | 'currency' | 'statusDot' | 'expiry' | 'origin';
}

export const QUOTE_COLUMNS: QuoteColumnDefinition[] = [
  { id: 'estimateNumber', label: 'Cotización', field: 'estimateNumber', type: 'text', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 140, minWidth: 100, maxWidth: 200, align: 'left', priority: 1 },
  { id: 'status', label: 'Estado', field: 'status', type: 'status', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 130, minWidth: 90, maxWidth: 170, align: 'left', priority: 2, formatter: 'statusDot' },
  { id: 'date', label: 'Fecha', field: 'date', type: 'date', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 130, minWidth: 100, maxWidth: 180, align: 'left', priority: 3, formatter: 'date' },
  { id: 'expiryDate', label: 'Vence', field: 'expiryDate', type: 'date', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 150, minWidth: 110, maxWidth: 200, align: 'left', priority: 4, formatter: 'expiry' },
  { id: 'customerName', label: 'Cliente', field: 'customerName', type: 'text', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 200, minWidth: 100, maxWidth: 300, align: 'left', priority: 5 },
  { id: 'total', label: 'Total', field: 'total', type: 'currency', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 130, minWidth: 100, maxWidth: 180, align: 'right', priority: 6, formatter: 'currency' },
  { id: 'salespersonName', label: 'Vendedor', field: 'salespersonName', type: 'text', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 150, minWidth: 100, maxWidth: 220, align: 'left', priority: 7 },
  { id: 'referenceNumber', label: 'Referencia', field: 'referenceNumber', type: 'text', sortable: true, filterable: true, defaultVisible: false, defaultWidth: 140, minWidth: 90, maxWidth: 220, align: 'left', priority: 8 },
  { id: 'createdInUnik', label: 'Origen', field: 'createdInUnik', type: 'boolean', sortable: true, filterable: false, defaultVisible: true, defaultWidth: 100, minWidth: 80, maxWidth: 130, align: 'center', priority: 9, formatter: 'origin' },
  { id: 'currencyCode', label: 'Moneda', field: 'currencyCode', type: 'text', sortable: false, filterable: true, defaultVisible: false, defaultWidth: 90, minWidth: 70, maxWidth: 120, align: 'center', priority: 10 },
  { id: 'sourceRemoteModifiedAt', label: 'Última modificación remota', field: 'sourceRemoteModifiedAt', type: 'date', sortable: true, filterable: true, defaultVisible: false, defaultWidth: 170, minWidth: 130, maxWidth: 220, align: 'left', priority: 11, formatter: 'date' },
];

export const QUOTE_COLUMN_MAP: Record<string, QuoteColumnDefinition> = Object.fromEntries(
  QUOTE_COLUMNS.map((c) => [c.id, c])
);

export const QUOTE_DEFAULT_COLUMN_ORDER: string[] = [...QUOTE_COLUMNS].sort((a, b) => a.priority - b.priority).map((c) => c.id);
export const QUOTE_SORTABLE_FIELDS = new Set(QUOTE_COLUMNS.filter((c) => c.sortable).map((c) => c.field));
export const QUOTE_FILTERABLE_FIELDS = new Set(QUOTE_COLUMNS.filter((c) => c.filterable).map((c) => c.field));

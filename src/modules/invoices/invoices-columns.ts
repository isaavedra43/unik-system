export const INVOICES_TABLE_KEY = 'invoices';

export interface InvoiceColumnDefinition {
  id: string; label: string; field: string;
  type: 'text' | 'date' | 'number' | 'currency' | 'status';
  sortable: boolean; filterable: boolean; defaultVisible: boolean;
  defaultWidth: number; minWidth: number; maxWidth: number;
  align: 'left' | 'right' | 'center'; priority: number;
  formatter?: 'date' | 'currency' | 'statusDot';
}

export const INVOICE_COLUMNS: InvoiceColumnDefinition[] = [
  { id: 'invoiceNumber', label: 'Factura', field: 'invoiceNumber', type: 'text', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 140, minWidth: 100, maxWidth: 200, align: 'left', priority: 1 },
  { id: 'status', label: 'Estado', field: 'status', type: 'status', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 120, minWidth: 90, maxWidth: 160, align: 'left', priority: 2, formatter: 'statusDot' },
  { id: 'date', label: 'Fecha', field: 'date', type: 'date', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 130, minWidth: 100, maxWidth: 180, align: 'left', priority: 3, formatter: 'date' },
  { id: 'dueDate', label: 'Vencimiento', field: 'dueDate', type: 'date', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 130, minWidth: 100, maxWidth: 180, align: 'left', priority: 4, formatter: 'date' },
  { id: 'customerName', label: 'Cliente', field: 'customerName', type: 'text', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 180, minWidth: 100, maxWidth: 280, align: 'left', priority: 5 },
  { id: 'total', label: 'Total', field: 'total', type: 'currency', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 130, minWidth: 100, maxWidth: 180, align: 'right', priority: 6, formatter: 'currency' },
  { id: 'balance', label: 'Saldo', field: 'balance', type: 'currency', sortable: true, filterable: true, defaultVisible: true, defaultWidth: 130, minWidth: 100, maxWidth: 180, align: 'right', priority: 7, formatter: 'currency' },
  { id: 'currencyCode', label: 'Moneda', field: 'currencyCode', type: 'text', sortable: false, filterable: true, defaultVisible: false, defaultWidth: 90, minWidth: 70, maxWidth: 120, align: 'center', priority: 8 },
  { id: 'sourceRemoteModifiedAt', label: 'Última modificación remota', field: 'sourceRemoteModifiedAt', type: 'date', sortable: true, filterable: true, defaultVisible: false, defaultWidth: 170, minWidth: 130, maxWidth: 220, align: 'left', priority: 9, formatter: 'date' },
];

export const INVOICE_COLUMN_MAP: Record<string, InvoiceColumnDefinition> = Object.fromEntries(
  INVOICE_COLUMNS.map((c) => [c.id, c])
);

export const INVOICE_DEFAULT_COLUMN_ORDER: string[] = INVOICE_COLUMNS.sort((a, b) => a.priority - b.priority).map((c) => c.id);
export const INVOICE_DEFAULT_VISIBLE_COLUMNS: string[] = INVOICE_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);
export const INVOICE_SORTABLE_FIELDS = new Set(INVOICE_COLUMNS.filter((c) => c.sortable).map((c) => c.field));
export const INVOICE_FILTERABLE_FIELDS = new Set(INVOICE_COLUMNS.filter((c) => c.filterable).map((c) => c.field));

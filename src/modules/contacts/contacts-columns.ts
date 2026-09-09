/**
 * Central column registry for the Contacts workspace.
 * Shared by both Customers and Vendors UIs.
 */

export const CONTACTS_TABLE_KEY_CUSTOMERS = 'contacts_customers';
export const CONTACTS_TABLE_KEY_VENDORS = 'contacts_vendors';

export interface ContactColumnDefinition {
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
  statusCategory?: 'contact';
}

export const CONTACT_COLUMNS: ContactColumnDefinition[] = [
  {
    id: 'contactName',
    label: 'Nombre',
    field: 'contactName',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 220,
    minWidth: 120,
    maxWidth: 360,
    align: 'left',
    priority: 1,
  },
  {
    id: 'companyName',
    label: 'Empresa',
    field: 'companyName',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 200,
    minWidth: 120,
    maxWidth: 320,
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
    statusCategory: 'contact',
  },
  {
    id: 'primaryEmail',
    label: 'Correo',
    field: 'primaryEmail',
    type: 'text',
    sortable: false,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 200,
    minWidth: 120,
    maxWidth: 300,
    align: 'left',
    priority: 4,
  },
  {
    id: 'primaryPhone',
    label: 'Teléfono',
    field: 'primaryPhone',
    type: 'text',
    sortable: false,
    filterable: true,
    defaultVisible: true,
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 180,
    align: 'left',
    priority: 5,
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
    priority: 6,
  },
  {
    id: 'paymentTermsLabel',
    label: 'Términos de pago',
    field: 'paymentTermsLabel',
    type: 'text',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 140,
    minWidth: 100,
    maxWidth: 200,
    align: 'left',
    priority: 7,
  },
  {
    id: 'outstandingReceivable',
    label: 'Saldo por cobrar',
    field: 'outstandingReceivable',
    type: 'currency',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 150,
    minWidth: 110,
    maxWidth: 200,
    align: 'right',
    priority: 8,
    formatter: 'currency',
  },
  {
    id: 'outstandingPayable',
    label: 'Saldo por pagar',
    field: 'outstandingPayable',
    type: 'currency',
    sortable: true,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 150,
    minWidth: 110,
    maxWidth: 200,
    align: 'right',
    priority: 9,
    formatter: 'currency',
  },
  {
    id: 'website',
    label: 'Sitio web',
    field: 'website',
    type: 'text',
    sortable: false,
    filterable: true,
    defaultVisible: false,
    defaultWidth: 160,
    minWidth: 100,
    maxWidth: 240,
    align: 'left',
    priority: 10,
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
    priority: 11,
    formatter: 'date',
  },
];

export const CONTACT_COLUMN_MAP: Record<string, ContactColumnDefinition> = Object.fromEntries(
  CONTACT_COLUMNS.map((c) => [c.id, c])
);

export const CONTACT_DEFAULT_COLUMN_ORDER: string[] = CONTACT_COLUMNS.sort(
  (a, b) => a.priority - b.priority
).map((c) => c.id);

export const CONTACT_DEFAULT_VISIBLE_COLUMNS: string[] = CONTACT_COLUMNS.filter(
  (c) => c.defaultVisible
).map((c) => c.id);

export const CONTACT_SORTABLE_FIELDS = new Set(
  CONTACT_COLUMNS.filter((c) => c.sortable).map((c) => c.field)
);

export const CONTACT_FILTERABLE_FIELDS = new Set(
  CONTACT_COLUMNS.filter((c) => c.filterable).map((c) => c.field)
);

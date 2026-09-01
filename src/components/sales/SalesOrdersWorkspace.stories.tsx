import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SalesOrdersWorkspace } from './SalesOrdersWorkspace';

const meta: Meta<typeof SalesOrdersWorkspace> = {
  title: 'Sales/SalesOrdersWorkspace',
  component: SalesOrdersWorkspace,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div style={{ height: '100vh' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SalesOrdersWorkspace>;

const mockUser = {
  id: 'user-1',
  name: 'Admin',
  username: 'admin',
  email: null,
  isSuperAdmin: true,
  permissionKeys: [
    'sales_orders.view',
    'sales_orders.export',
    'sales_orders.watch',
    'sales_orders.share_views',
  ],
  roleKeys: [],
  mustChangePassword: false,
};

const mockData = {
  data: [
    {
      id: '1',
      sales_order_number: 'OV-0001',
      reference_number: 'REF-001',
      order_date: '2026-09-01',
      customer_name: 'Cliente Demo SA',
      customer_phone: '+52 55 1234 5678',
      salesperson_name: 'Vendedor Uno',
      payment_method: 'Tarjeta',
      delivery_method: 'Envío terrestre',
      location_name: 'CDMX',
      branch_name: 'Sucursal Centro',
      status: 'Aprobada',
      sub_status: null,
      paid_status: 'Pagada',
      invoiced_status: 'Facturada',
      shipped_status: 'Enviada',
      currency_code: 'MXN',
      subtotal: '1000.00',
      discount_total: '50.00',
      tax_total: '160.00',
      shipping_charge: '100.00',
      adjustment: '0.00',
      total: '1210.00',
      balance: '0.00',
      sale_made_in_warehouse: true,
      source_remote_modified_at: '2026-09-01T12:00:00.000Z',
    },
    {
      id: '2',
      sales_order_number: 'OV-0002',
      reference_number: null,
      order_date: '2026-09-02',
      customer_name: 'Cliente Ejemplo',
      customer_phone: null,
      salesperson_name: 'Vendedor Dos',
      payment_method: 'Transferencia',
      delivery_method: 'Recogido en tienda',
      location_name: 'GDL',
      branch_name: null,
      status: 'Pendiente',
      sub_status: null,
      paid_status: 'Parcial',
      invoiced_status: 'No facturada',
      shipped_status: 'No enviada',
      currency_code: 'MXN',
      subtotal: '500.00',
      discount_total: '0.00',
      tax_total: '80.00',
      shipping_charge: '0.00',
      adjustment: '0.00',
      total: '580.00',
      balance: '290.00',
      sale_made_in_warehouse: false,
      source_remote_modified_at: '2026-09-02T10:00:00.000Z',
    },
  ],
  pagination: { page: 1, page_size: 50, total: 2, total_pages: 1 },
  aggregates: { count: 2, total_sum: '1790.00', balance_sum: '290.00' },
};

const mockPreference = {
  version: 1 as const,
  columnOrder: [],
  columnVisibility: {},
  columnWidths: {},
  columnPinning: { left: [], right: [] },
  density: 'normal' as const,
  pageSize: 50,
};

export const Default: Story = {
  args: {
    user: mockUser,
    initialData: mockData,
    initialQuery: {
      search: '',
      filters: { logic: 'AND', rules: [] },
      sort: [],
      page: 1,
      page_size: 50,
    },
    preference: mockPreference,
    views: { privateViews: [], sharedViews: [] },
    defaultViewId: null,
    watchedIds: new Set(['1']),
    unreadNotifications: 3,
    canExport: true,
    canWatch: true,
    canShareViews: true,
  },
};

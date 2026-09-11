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
      salesOrderNumber: 'OV-0001',
      referenceNumber: 'REF-001',
      orderDate: '2026-09-01',
      customerName: 'Cliente Demo SA',
      customerPhone: '+52 55 1234 5678',
      salespersonName: 'Vendedor Uno',
      paymentMethod: 'Tarjeta',
      deliveryMethod: 'Envío terrestre',
      locationName: 'CDMX',
      branchName: 'Sucursal Centro',
      status: 'confirmed',
      subStatus: null,
      ticketStatus: 'in_transit',
      paidStatus: 'paid',
      invoicedStatus: 'invoiced',
      shippedStatus: 'shipped',
      currencyCode: 'MXN',
      subtotal: '1000.00',
      discountTotal: '50.00',
      taxTotal: '160.00',
      shippingCharge: '100.00',
      adjustment: '0.00',
      total: '1210.00',
      balance: '0.00',
      saleMadeInWarehouse: true,
      shippingAddress: null,
      sourceRemoteModifiedAt: '2026-09-01T12:00:00.000Z',
      carrier: 'Fabian',
    },
    {
      id: '2',
      salesOrderNumber: 'OV-0002',
      referenceNumber: null,
      orderDate: '2026-09-02',
      customerName: 'Cliente Ejemplo',
      customerPhone: null,
      salespersonName: 'Vendedor Dos',
      paymentMethod: 'Transferencia',
      deliveryMethod: 'Recogido en tienda',
      locationName: 'GDL',
      branchName: null,
      status: 'pending',
      subStatus: null,
      ticketStatus: 'not_invoiced',
      paidStatus: 'partial',
      invoicedStatus: 'not_invoiced',
      shippedStatus: 'not_shipped',
      currencyCode: 'MXN',
      subtotal: '500.00',
      discountTotal: '0.00',
      taxTotal: '80.00',
      shippingCharge: '0.00',
      adjustment: '0.00',
      total: '580.00',
      balance: '290.00',
      saleMadeInWarehouse: false,
      shippingAddress: null,
      sourceRemoteModifiedAt: '2026-09-02T10:00:00.000Z',
      carrier: null,
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

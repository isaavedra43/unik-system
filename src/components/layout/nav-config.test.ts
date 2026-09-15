/**
 * Parity tests for nav-config.ts.
 *
 * The `legacy*` functions are copied from `git show HEAD:src/components/layout/AppShell.tsx`
 * (the shell before navigation was extracted) and are the reference implementation.
 * The only adaptation: sidebar icons were JSX elements (`<Home size={18} />`); here they
 * are the component they rendered (`Home`), which is what nav-config now stores.
 *
 * Additions made after the extraction are marked "added after extraction" in the
 * reference so the parity checks keep covering them (Operaciones → Expedientes, General → Mi trabajo).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  Bell,
  BookOpen,
  Bot,
  Boxes,
  ClipboardList,
  CreditCard,
  Database,
  FileSignature,
  FileText,
  HardDrive,
  Inbox,
  Megaphone,
  MessageCircle,
  MessageSquare,
  Phone,
  PhoneCall,
  Plug,
  Radio,
  Receipt,
  ShoppingCart,
  SlidersHorizontal,
  Truck,
  UserCog,
  Users as UsersIcon,
  Wallet,
  Workflow,
} from 'lucide-react';
import { Home, Shield, Users } from '@/components/ui/icons';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { PermissionKey } from '@/modules/auth/permissions';
import {
  BREADCRUMB_RULES,
  FLUSH_ROUTE_PREFIXES,
  NAV_CONFIG,
  buildBreadcrumbs,
  buildNavSections,
  can,
  isFlushRoute,
  visibleNavItems,
  type NavEntry,
  type NavSection,
} from './nav-config';

// The unit project does not transform JSX (tsconfig uses "jsx": "preserve"), so UNIK's own
// icon set (icons.tsx) is replaced by inert components. Both nav-config and the legacy
// reference below import this same mock, so icon identity comparisons stay meaningful.
vi.mock('@/components/ui/icons', () => ({
  Home: function Home() {
    return null;
  },
  Shield: function Shield() {
    return null;
  },
  Users: function Users() {
    return null;
  },
}));

// ---------------------------------------------------------------------------
// Legacy reference (HEAD:src/components/layout/AppShell.tsx)
// ---------------------------------------------------------------------------

function legacyBuildBreadcrumbs(pathname: string): { label: string; href?: string }[] {
  if (pathname === '/app') return [];
  if (pathname.startsWith('/app/admin/access')) {
    return [
      { label: 'Administración', href: '/app/admin/access' },
      { label: 'Usuarios y permisos' },
    ];
  }
  if (pathname.startsWith('/app/admin/integrations')) {
    return [
      { label: 'Administración', href: '/app/admin/integrations' },
      { label: 'Integraciones' },
    ];
  }
  if (pathname.startsWith('/app/admin/assistant')) {
    return [{ label: 'Administración', href: '/app/admin/assistant' }, { label: 'Asistente IA' }];
  }
  if (pathname.startsWith('/app/admin/chat')) {
    return [{ label: 'Administración', href: '/app/admin/chat' }, { label: 'Chat' }];
  }
  if (pathname.startsWith('/app/admin/files')) {
    return [{ label: 'Administración', href: '/app/admin/files' }, { label: 'Archivos' }];
  }
  if (pathname.startsWith('/app/admin/extensions')) {
    return [{ label: 'Administración', href: '/app/admin/extensions' }, { label: 'Extensiones' }];
  }
  const simple: Array<[string, string[]]> = [
    ['/app/admin/knowledge', ['Administración', 'Biblioteca aprobada']],
    ['/app/admin/comms', ['Administración', 'Canales y responsables']],
    ['/app/admin/voice', ['Administración', 'Telefonía']],
    ['/app/inbox', ['Comunicaciones', 'Bandeja externa']],
    ['/app/campaigns', ['Comunicaciones', 'Campañas']],
    ['/app/calls', ['Comunicaciones', 'Llamadas']],
  ];
  for (const [prefix, labels] of simple) {
    if (pathname.startsWith(prefix)) {
      return labels.map((label, i) =>
        i < labels.length - 1 ? { label, href: prefix } : { label }
      );
    }
  }
  if (pathname.startsWith('/app/assistant/extensions')) {
    return [{ label: 'Asistente IA', href: '/app/assistant' }, { label: 'Extensiones y skills' }];
  }
  if (pathname.startsWith('/app/assistant')) {
    return [{ label: 'Asistente IA' }];
  }
  if (pathname.startsWith('/app/chat')) {
    return [{ label: 'Chat' }];
  }
  // Added after extraction: "Mi trabajo" (plan 5.7).
  if (pathname.startsWith('/app/mywork')) {
    return [{ label: 'Mi trabajo' }];
  }
  if (pathname.startsWith('/app/account/security')) {
    return [{ label: 'Cuenta' }, { label: 'Seguridad' }];
  }
  if (pathname.startsWith('/app/account/notifications')) {
    return [{ label: 'Cuenta' }, { label: 'Mis notificaciones' }];
  }
  if (pathname === '/app/sales/orders') {
    return [{ label: 'Ventas' }, { label: 'Órdenes de venta' }];
  }
  if (pathname.startsWith('/app/sales/orders/')) {
    return [
      { label: 'Ventas' },
      { label: 'Órdenes de venta', href: '/app/sales/orders' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/contacts/customers') {
    return [{ label: 'Ventas' }, { label: 'Clientes' }];
  }
  if (pathname.startsWith('/app/contacts/customers/')) {
    return [
      { label: 'Ventas' },
      { label: 'Clientes', href: '/app/contacts/customers' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/contacts/vendors') {
    return [{ label: 'Compras' }, { label: 'Proveedores' }];
  }
  if (pathname.startsWith('/app/contacts/vendors/')) {
    return [
      { label: 'Compras' },
      { label: 'Proveedores', href: '/app/contacts/vendors' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/products') {
    return [{ label: 'Inventario' }, { label: 'Productos' }];
  }
  if (pathname.startsWith('/app/products/')) {
    return [
      { label: 'Inventario' },
      { label: 'Productos', href: '/app/products' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/packages') {
    return [{ label: 'Inventario' }, { label: 'Paquetes' }];
  }
  if (pathname.startsWith('/app/packages/')) {
    return [
      { label: 'Inventario' },
      { label: 'Paquetes', href: '/app/packages' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/quotes') {
    return [{ label: 'Ventas' }, { label: 'Cotizaciones' }];
  }
  if (pathname === '/app/quotes/new') {
    return [
      { label: 'Ventas' },
      { label: 'Cotizaciones', href: '/app/quotes' },
      { label: 'Nueva' },
    ];
  }
  if (pathname.startsWith('/app/quotes/') && pathname.endsWith('/edit')) {
    return [
      { label: 'Ventas' },
      { label: 'Cotizaciones', href: '/app/quotes' },
      { label: 'Editar' },
    ];
  }
  if (pathname.startsWith('/app/quotes/')) {
    return [
      { label: 'Ventas' },
      { label: 'Cotizaciones', href: '/app/quotes' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/invoices') {
    return [{ label: 'Ventas' }, { label: 'Facturas' }];
  }
  if (pathname.startsWith('/app/invoices/')) {
    return [
      { label: 'Ventas' },
      { label: 'Facturas', href: '/app/invoices' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/payments') {
    return [{ label: 'Ventas' }, { label: 'Pagos' }];
  }
  if (pathname.startsWith('/app/payments/')) {
    return [{ label: 'Ventas' }, { label: 'Pagos', href: '/app/payments' }, { label: 'Detalle' }];
  }
  if (pathname === '/app/purchase-orders') {
    return [{ label: 'Compras' }, { label: 'Órdenes de compra' }];
  }
  if (pathname.startsWith('/app/purchase-orders/')) {
    return [
      { label: 'Compras' },
      { label: 'Órdenes de compra', href: '/app/purchase-orders' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/bills') {
    return [{ label: 'Compras' }, { label: 'Facturas de compra' }];
  }
  if (pathname.startsWith('/app/bills/')) {
    return [
      { label: 'Compras' },
      { label: 'Facturas de compra', href: '/app/bills' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/vendor-credits') {
    return [{ label: 'Compras' }, { label: 'Créditos de proveedor' }];
  }
  if (pathname.startsWith('/app/vendor-credits/')) {
    return [
      { label: 'Compras' },
      { label: 'Créditos de proveedor', href: '/app/vendor-credits' },
      { label: 'Detalle' },
    ];
  }
  if (pathname === '/app/notifications') {
    return [{ label: 'Notificaciones' }];
  }
  return [];
}

function legacyIsFlush(pathname: string): boolean {
  const isWorkspace =
    (pathname.startsWith('/app/sales/orders') ||
      pathname.startsWith('/app/contacts/customers') ||
      pathname.startsWith('/app/contacts/vendors') ||
      pathname.startsWith('/app/products') ||
      pathname.startsWith('/app/packages') ||
      pathname.startsWith('/app/invoices') ||
      pathname.startsWith('/app/payments') ||
      pathname.startsWith('/app/purchase-orders') ||
      pathname.startsWith('/app/bills') ||
      pathname.startsWith('/app/vendor-credits')) &&
    !pathname.includes('/api');
  const isAssistantPage = pathname.startsWith('/app/assistant');
  const isChatPage = pathname.startsWith('/app/chat');
  const isInboxPage = pathname.startsWith('/app/inbox');
  return isWorkspace || isAssistantPage || isChatPage || isInboxPage;
}

function legacySections(user: CurrentUser): NavEntry[] {
  return [
    {
      title: 'General',
      items: [
        { href: '/app', label: 'Inicio', icon: Home, visible: true },
        // Added after extraction: "Mi trabajo" for every signed-in user (plan 5.7).
        { href: '/app/mywork', label: 'Mi trabajo', icon: ClipboardList, visible: true },
        {
          href: '/app/assistant',
          label: 'Asistente IA',
          icon: Bot,
          visible: user.permissionKeys.includes('assistant.use') || user.isSuperAdmin,
        },
      ],
    },
    // Added after extraction: operational cases (plan section 2.7).
    {
      title: 'Operaciones',
      items: [
        {
          href: '/app/operations',
          label: 'Expedientes',
          icon: Workflow,
          visible: user.permissionKeys.includes('operations.view') || user.isSuperAdmin,
        },
      ],
    },
    {
      title: 'Comunicaciones',
      items: [
        {
          href: '/app/chat',
          label: 'Chat',
          icon: MessageCircle,
          visible: user.permissionKeys.includes('chat.use') || user.isSuperAdmin,
        },
        {
          href: '/app/inbox',
          label: 'Bandeja externa',
          icon: Inbox,
          visible: user.permissionKeys.includes('inbox.use') || user.isSuperAdmin,
        },
        {
          href: '/app/campaigns',
          label: 'Campañas',
          icon: Megaphone,
          visible:
            user.permissionKeys.includes('campaigns.view') ||
            user.permissionKeys.includes('campaigns.manage') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/calls',
          label: 'Llamadas',
          icon: Phone,
          visible:
            user.permissionKeys.includes('calls.use') ||
            user.permissionKeys.includes('calls.supervise') ||
            user.isSuperAdmin,
        },
      ],
    },
    {
      kind: 'group',
      key: 'zoho',
      title: 'Zoho',
      icon: Database,
      sections: [
        {
          title: 'Ventas',
          items: [
            {
              href: '/app/sales/orders',
              label: 'Órdenes de venta',
              icon: ShoppingCart,
              visible: user.permissionKeys.includes('sales_orders.view') || user.isSuperAdmin,
            },
            {
              href: '/app/contacts/customers',
              label: 'Clientes',
              icon: UsersIcon,
              visible: user.permissionKeys.includes('customers.view') || user.isSuperAdmin,
            },
            {
              href: '/app/quotes',
              label: 'Cotizaciones',
              icon: FileSignature,
              visible: user.permissionKeys.includes('quotes.view') || user.isSuperAdmin,
            },
            {
              href: '/app/invoices',
              label: 'Facturas',
              icon: FileText,
              visible: user.permissionKeys.includes('invoices.view') || user.isSuperAdmin,
            },
            {
              href: '/app/payments',
              label: 'Pagos',
              icon: CreditCard,
              visible: user.permissionKeys.includes('payments.view') || user.isSuperAdmin,
            },
          ],
        },
        {
          title: 'Inventario',
          items: [
            {
              href: '/app/products',
              label: 'Productos',
              icon: Boxes,
              visible: user.permissionKeys.includes('products.view') || user.isSuperAdmin,
            },
            {
              href: '/app/packages',
              label: 'Paquetes',
              icon: Truck,
              visible: user.permissionKeys.includes('packages.view') || user.isSuperAdmin,
            },
          ],
        },
        {
          title: 'Compras',
          items: [
            {
              href: '/app/contacts/vendors',
              label: 'Proveedores',
              icon: UserCog,
              visible: user.permissionKeys.includes('vendors.view') || user.isSuperAdmin,
            },
            {
              href: '/app/purchase-orders',
              label: 'Órdenes de compra',
              icon: ShoppingCart,
              visible: user.permissionKeys.includes('purchase_orders.view') || user.isSuperAdmin,
            },
            {
              href: '/app/bills',
              label: 'Facturas de compra',
              icon: Receipt,
              visible: user.permissionKeys.includes('bills.view') || user.isSuperAdmin,
            },
            {
              href: '/app/vendor-credits',
              label: 'Créditos de proveedor',
              icon: Wallet,
              visible: user.permissionKeys.includes('vendor_credits.view') || user.isSuperAdmin,
            },
          ],
        },
      ],
    },
    {
      title: 'Administración',
      items: [
        {
          href: '/app/admin/access',
          label: 'Usuarios y permisos',
          icon: Users,
          visible:
            user.permissionKeys.includes('users.view') ||
            user.permissionKeys.includes('roles.view') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/admin/integrations',
          label: 'Integraciones',
          icon: Plug,
          visible: user.permissionKeys.includes('integrations.view') || user.isSuperAdmin,
        },
        {
          href: '/app/admin/assistant',
          label: 'Asistente IA',
          icon: Bot,
          visible: user.permissionKeys.includes('assistant.admin') || user.isSuperAdmin,
        },
        {
          href: '/app/admin/chat',
          label: 'Chat',
          icon: MessageSquare,
          visible: user.permissionKeys.includes('chat.admin') || user.isSuperAdmin,
        },
        {
          href: '/app/admin/files',
          label: 'Archivos',
          icon: HardDrive,
          visible: user.permissionKeys.includes('files.admin') || user.isSuperAdmin,
        },
        {
          href: '/app/admin/extensions',
          label: 'Extensiones',
          icon: Plug,
          visible:
            user.permissionKeys.includes('extensions.view') ||
            user.permissionKeys.includes('extensions.manage') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/admin/knowledge',
          label: 'Biblioteca aprobada',
          icon: BookOpen,
          visible: user.permissionKeys.includes('knowledge.manage') || user.isSuperAdmin,
        },
        {
          href: '/app/admin/comms',
          label: 'Canales y responsables',
          icon: Radio,
          visible: user.permissionKeys.includes('inbox.admin') || user.isSuperAdmin,
        },
        {
          href: '/app/admin/voice',
          label: 'Telefonía',
          icon: PhoneCall,
          visible: user.permissionKeys.includes('calls.admin') || user.isSuperAdmin,
        },
      ],
    },
    {
      title: 'Cuenta',
      items: [
        {
          href: '/app/account/security',
          label: 'Seguridad',
          icon: Shield,
          visible: true,
        },
        {
          href: '/app/notifications',
          label: 'Notificaciones',
          icon: Bell,
          visible: true,
        },
        {
          href: '/app/account/notifications',
          label: 'Configurar avisos',
          icon: SlidersHorizontal,
          visible: true,
        },
      ],
    },
  ];
}

/** Hrefs the legacy `Sidebar` rendered: items with `visible !== false`, groups flattened. */
function renderedHrefs(entries: NavEntry[]): string[] {
  const fromSection = (section: NavSection) =>
    section.items.filter((item) => item.visible !== false).map((item) => item.href);
  return entries.flatMap((entry) =>
    entry.kind === 'group' ? entry.sections.flatMap(fromSection) : fromSection(entry)
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeUser(permissionKeys: PermissionKey[], isSuperAdmin = false): CurrentUser {
  return {
    id: 'user-1',
    username: 'tester',
    name: 'Tester',
    email: null,
    mustChangePassword: false,
    roleKeys: [],
    permissionKeys,
    isSuperAdmin,
  };
}

/** Every permission key the legacy sidebar checked. */
const NAV_PERMISSION_KEYS: PermissionKey[] = [
  'assistant.use',
  'operations.view',
  'chat.use',
  'inbox.use',
  'campaigns.view',
  'campaigns.manage',
  'calls.use',
  'calls.supervise',
  'sales_orders.view',
  'customers.view',
  'quotes.view',
  'invoices.view',
  'payments.view',
  'products.view',
  'packages.view',
  'vendors.view',
  'purchase_orders.view',
  'bills.view',
  'vendor_credits.view',
  'users.view',
  'roles.view',
  'integrations.view',
  'assistant.admin',
  'chat.admin',
  'files.admin',
  'extensions.view',
  'extensions.manage',
  'knowledge.manage',
  'inbox.admin',
  'calls.admin',
];

const SUPER_ADMIN = makeUser([], true);
const NO_PERMISSIONS = makeUser([]);
const PARTIAL_A = makeUser([
  'assistant.use',
  'campaigns.manage',
  'calls.supervise',
  'quotes.view',
  'packages.view',
  'bills.view',
  'roles.view',
  'extensions.manage',
  'knowledge.manage',
]);
const PARTIAL_B = makeUser([
  'chat.use',
  'inbox.use',
  'campaigns.view',
  'calls.use',
  'sales_orders.view',
  'customers.view',
  'products.view',
  'vendors.view',
  'users.view',
  'chat.admin',
  'calls.admin',
]);
const ALL_KEYS_NOT_ADMIN = makeUser([...NAV_PERMISSION_KEYS]);

const USERS: Array<[string, CurrentUser]> = [
  ['super admin', SUPER_ADMIN],
  ['sin permisos', NO_PERMISSIONS],
  ['permisos parciales A', PARTIAL_A],
  ['permisos parciales B', PARTIAL_B],
  ['todas las llaves sin super admin', ALL_KEYS_NOT_ADMIN],
];

/** Route bases handled by the legacy shell (listed by hand, independent of nav-config). */
const LEGACY_ROUTE_BASES = [
  '/app/admin/access',
  '/app/admin/integrations',
  '/app/admin/assistant',
  '/app/admin/chat',
  '/app/admin/files',
  '/app/admin/extensions',
  '/app/admin/knowledge',
  '/app/admin/comms',
  '/app/admin/voice',
  '/app/inbox',
  '/app/campaigns',
  '/app/calls',
  '/app/assistant',
  '/app/assistant/extensions',
  '/app/chat',
  '/app/account/security',
  '/app/account/notifications',
  '/app/sales/orders',
  '/app/contacts/customers',
  '/app/contacts/vendors',
  '/app/products',
  '/app/packages',
  '/app/quotes',
  '/app/quotes/new',
  '/app/invoices',
  '/app/payments',
  '/app/purchase-orders',
  '/app/bills',
  '/app/vendor-credits',
  '/app/notifications',
];

/** Routes the legacy shell did not handle, plus near misses. */
const OTHER_ROUTE_BASES = [
  '',
  '/',
  '/login',
  '/api',
  '/api/health',
  '/app',
  '/app/api',
  '/app/admin',
  '/app/admin/control-tower',
  '/app/admin/control-tower/neural/grafo',
  '/app/admin/unknown',
  '/app/account',
  '/app/sales',
  '/app/contacts',
  '/app/mywork',
  '/app/reports',
  '/app/areas/compras/dashboard',
  '/app/areas/logistica/chofer/api/today',
  '/app/notifications/api/read',
  '/app/chat/api/messages',
  '/app/assistant/api/chat',
  '/app/inbox/api/accounts',
  '/app/products/sync/status',
  '/app/sales/orders/so-1/api',
  '/app/quotes/q-1/edit',
  '/app/quotes/new/edit',
  '/app/quotes/edit',
];

const PATH_VARIANTS = [
  '',
  '/',
  'x',
  '-legacy',
  '/id-123',
  '/id-123/',
  '/id-123/edit',
  '/id-123/edit/',
  '/id-123/editar',
  '/new',
  '/new/',
  '/new/edit',
  '/edit',
  '/api',
  '/api/rows',
  '/id-123/api',
  '/id-123/api/lines',
  '/apiary',
  '/sync',
  '/sync/status',
];

const NAV_HREFS = renderedHrefs(buildNavSections(SUPER_ADMIN));

const ALL_PATHS = Array.from(
  new Set(
    [
      ...LEGACY_ROUTE_BASES,
      ...OTHER_ROUTE_BASES,
      ...NAV_HREFS,
      ...BREADCRUMB_RULES.map((rule) => rule.path),
      ...FLUSH_ROUTE_PREFIXES.map((route) => route.prefix),
    ].flatMap((base) => PATH_VARIANTS.map((variant) => `${base}${variant}`))
  )
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildNavSections', () => {
  it.each(USERS)('reproduce secciones, ítems, iconos y visibilidad (%s)', (_name, user) => {
    expect(buildNavSections(user)).toStrictEqual(legacySections(user));
  });

  it.each(USERS)('muestra los mismos hrefs visibles que antes (%s)', (_name, user) => {
    expect(renderedHrefs(buildNavSections(user))).toStrictEqual(
      renderedHrefs(legacySections(user))
    );
  });

  it('super admin ve las 31 entradas', () => {
    expect(NAV_HREFS).toHaveLength(31);
    expect(renderedHrefs(buildNavSections(ALL_KEYS_NOT_ADMIN))).toStrictEqual(NAV_HREFS);
  });

  it('sin permisos sólo quedan Inicio, Mi trabajo y Cuenta', () => {
    expect(renderedHrefs(buildNavSections(NO_PERMISSIONS))).toStrictEqual([
      '/app',
      '/app/mywork',
      '/app/account/security',
      '/app/notifications',
      '/app/account/notifications',
    ]);
  });

  it('con permisos parciales muestra sólo lo concedido', () => {
    expect(renderedHrefs(buildNavSections(PARTIAL_A))).toStrictEqual([
      '/app',
      '/app/mywork',
      '/app/assistant',
      '/app/campaigns',
      '/app/calls',
      '/app/quotes',
      '/app/packages',
      '/app/bills',
      '/app/admin/access',
      '/app/admin/extensions',
      '/app/admin/knowledge',
      '/app/account/security',
      '/app/notifications',
      '/app/account/notifications',
    ]);
  });

  it.each(NAV_PERMISSION_KEYS)('cada llave por separado revela lo mismo que antes (%s)', (key) => {
    const user = makeUser([key]);
    expect(buildNavSections(user)).toStrictEqual(legacySections(user));
  });

  it('no repite hrefs dentro de una sección (llaves de React)', () => {
    const sections = NAV_CONFIG.flatMap((entry) =>
      entry.kind === 'group' ? entry.sections : [entry]
    );
    for (const section of sections) {
      const hrefs = section.items.map((item) => item.href);
      expect(new Set(hrefs).size, section.title).toBe(hrefs.length);
    }
  });
});

describe('can', () => {
  it('concede con cualquiera de las llaves o por super admin', () => {
    expect(can(PARTIAL_A, 'users.view', 'roles.view')).toBe(true);
    expect(can(PARTIAL_A, 'users.view')).toBe(false);
    expect(can(SUPER_ADMIN, 'users.view')).toBe(true);
    expect(can(NO_PERMISSIONS)).toBe(false);
    expect(can(SUPER_ADMIN)).toBe(true);
  });

  it('no lanza con llaves desconocidas', () => {
    const unknownKey = 'operations.unknown_key' as PermissionKey;
    expect(() => can(NO_PERMISSIONS, unknownKey)).not.toThrow();
    expect(can(NO_PERMISSIONS, unknownKey)).toBe(false);
    expect(can(SUPER_ADMIN, unknownKey)).toBe(true);
  });
});

describe('visibleNavItems', () => {
  it('oculta sólo los ítems con visible === false', () => {
    const section: NavSection = {
      title: 'Prueba',
      items: [
        { href: '/a', label: 'A', icon: Bell, visible: true },
        { href: '/b', label: 'B', icon: Bell, visible: false },
        { href: '/c', label: 'C', icon: Bell },
      ],
    };
    expect(visibleNavItems(section).map((item) => item.href)).toStrictEqual(['/a', '/c']);
  });
});

describe('buildBreadcrumbs', () => {
  it('coincide con la implementación anterior en todas las rutas', () => {
    expect(ALL_PATHS.length).toBeGreaterThan(1000);
    for (const pathname of ALL_PATHS) {
      expect(buildBreadcrumbs(pathname), pathname).toStrictEqual(legacyBuildBreadcrumbs(pathname));
    }
  });

  it('cubre todas las ramas anteriores', () => {
    const outputs = new Set(
      ALL_PATHS.map((pathname) => JSON.stringify(buildBreadcrumbs(pathname)))
    );
    // One distinct output per rule; the '/app' rule shares the empty list with unmatched routes.
    expect(outputs.size).toBe(BREADCRUMB_RULES.length);
  });

  it('resuelve los casos representativos', () => {
    expect(buildBreadcrumbs('/app')).toStrictEqual([]);
    expect(buildBreadcrumbs('/app/mywork')).toStrictEqual([{ label: 'Mi trabajo' }]);
    expect(buildBreadcrumbs('/app/sales/orders')).toStrictEqual([
      { label: 'Ventas' },
      { label: 'Órdenes de venta' },
    ]);
    expect(buildBreadcrumbs('/app/sales/orders/so-1')).toStrictEqual([
      { label: 'Ventas' },
      { label: 'Órdenes de venta', href: '/app/sales/orders' },
      { label: 'Detalle' },
    ]);
    expect(buildBreadcrumbs('/app/sales/ordersx')).toStrictEqual([]);
    expect(buildBreadcrumbs('/app/quotes/new')).toStrictEqual([
      { label: 'Ventas' },
      { label: 'Cotizaciones', href: '/app/quotes' },
      { label: 'Nueva' },
    ]);
    expect(buildBreadcrumbs('/app/quotes/q-1/edit')).toStrictEqual([
      { label: 'Ventas' },
      { label: 'Cotizaciones', href: '/app/quotes' },
      { label: 'Editar' },
    ]);
    expect(buildBreadcrumbs('/app/assistant/extensions/skill-1')).toStrictEqual([
      { label: 'Asistente IA', href: '/app/assistant' },
      { label: 'Extensiones y skills' },
    ]);
    expect(buildBreadcrumbs('/app/admin/comms/accounts')).toStrictEqual([
      { label: 'Administración', href: '/app/admin/comms' },
      { label: 'Canales y responsables' },
    ]);
    expect(buildBreadcrumbs('/app/notifications/other')).toStrictEqual([]);
  });

  it('devuelve copias que no alteran las reglas', () => {
    const first = buildBreadcrumbs('/app/inbox');
    first[0].label = 'Mutado';
    first.push({ label: 'Extra' });
    expect(buildBreadcrumbs('/app/inbox')).toStrictEqual([
      { label: 'Comunicaciones', href: '/app/inbox' },
      { label: 'Bandeja externa' },
    ]);
  });

  it('ordena BREADCRUMB_RULES de la ruta más larga a la más corta', () => {
    const lengths = BREADCRUMB_RULES.map((rule) => rule.path.length);
    expect(lengths).toStrictEqual([...lengths].sort((a, b) => b - a));
  });
});

describe('isFlushRoute', () => {
  it('coincide con la condición anterior en todas las rutas', () => {
    for (const pathname of ALL_PATHS) {
      expect(isFlushRoute(pathname), pathname).toBe(legacyIsFlush(pathname));
    }
  });

  it('excluye /api sólo en los espacios de trabajo', () => {
    expect(isFlushRoute('/app/products')).toBe(true);
    expect(isFlushRoute('/app/products/p-1')).toBe(true);
    expect(isFlushRoute('/app/products/api/rows')).toBe(false);
    expect(isFlushRoute('/app/contacts/customers/c-1/apiary')).toBe(false);
    expect(isFlushRoute('/app/assistant/api/chat')).toBe(true);
    expect(isFlushRoute('/app/chat/api/messages')).toBe(true);
    expect(isFlushRoute('/app/inbox/api/accounts')).toBe(true);
    expect(isFlushRoute('/app/admin/chat')).toBe(false);
    expect(isFlushRoute('/app/quotes')).toBe(false);
    expect(isFlushRoute('/app')).toBe(false);
  });
});

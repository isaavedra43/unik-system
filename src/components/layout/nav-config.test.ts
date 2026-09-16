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
  Factory,
  FileSignature,
  FileText,
  Gauge,
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
  ShoppingBag,
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
  AREA_NAV,
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
import {
  AREA_LIST,
  areaHref,
  areaSpaces,
  areaViewPermissions,
  flushAreaRoutes,
} from '@/modules/areas/area-registry';

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
  // Added after extraction: Control Tower views and Neural Operations (plan 7.7 / 7.8),
  // written by hand so a typo in the generated rules shows up as a difference.
  {
    const towerBase = '/app/admin/control-tower';
    const tower = { label: 'Control Tower', href: `${towerBase}/resumen` };
    const neuralBase = `${towerBase}/neural`;
    const neuralTools: Array<[string, string]> = [
      ['procesos', 'Procesos'],
      ['variantes', 'Variantes'],
      ['grafo', 'Grafo'],
      ['replay', 'Replay'],
      ['simulacion', 'Simulación'],
    ];
    for (const [slug, label] of neuralTools) {
      if (pathname.startsWith(`${neuralBase}/${slug}`)) {
        return [
          { label: 'Administración' },
          tower,
          { label: 'Neural Operations', href: `${neuralBase}/procesos` },
          { label },
        ];
      }
    }
    if (pathname.startsWith(neuralBase)) {
      return [{ label: 'Administración' }, tower, { label: 'Neural Operations' }];
    }
    const views: Array<[string, string]> = [
      ['resumen', 'Resumen'],
      ['personas', 'Personas'],
      ['excepciones', 'Excepciones'],
      ['aprobaciones', 'Aprobaciones'],
      ['auditoria', 'Auditoría'],
      ['configuracion', 'Configuración'],
    ];
    for (const [slug, label] of views) {
      if (pathname.startsWith(`${towerBase}/${slug}`)) {
        return [{ label: 'Administración' }, tower, { label }];
      }
    }
  }
  const simple: Array<[string, string[]]> = [
    // Added after extraction: Control Tower (plan 7.1).
    ['/app/admin/control-tower', ['Administración', 'Control Tower']],
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
  // Added after verification: management pages that hang from an area but are not
  // spaces of the registry, plus Expedientes and the Manufactura pages.
  for (const [areaKey, areaLabel, slug, label, parentSlug, parentLabel] of LEGACY_AREA_EXTRAS) {
    const path = `/app/areas/${areaKey}/${slug}`;
    const crumbs = [
      { label: 'Operaciones' },
      { label: areaLabel, href: `/app/areas/${areaKey}/dashboard` },
      { label: parentLabel, href: `/app/areas/${areaKey}/${parentSlug}` },
    ];
    if (pathname === path) return [...crumbs, { label }];
    if (pathname.startsWith(`${path}/`)) return [...crumbs, { label, href: path }];
  }
  if (pathname.startsWith('/app/operations/cases/')) {
    return [{ label: 'Operaciones', href: '/app/operations' }, { label: 'Expediente' }];
  }
  if (pathname.startsWith('/app/operations')) {
    return [{ label: 'Operaciones' }];
  }
  {
    const manufactura = {
      label: 'Manufactura',
      href: '/app/areas/manufactura/dashboard',
    };
    const orders = { label: 'Órdenes de producción', href: '/app/areas/manufactura/ordenes' };
    if (pathname === '/app/manufacturing/orders/nueva') {
      return [{ label: 'Operaciones' }, manufactura, orders, { label: 'Nueva' }];
    }
    if (pathname.startsWith('/app/manufacturing/orders')) {
      return [{ label: 'Operaciones' }, manufactura, orders, { label: 'Orden' }];
    }
    if (pathname.startsWith('/app/manufacturing/bom')) {
      return [{ label: 'Operaciones' }, manufactura, { label: 'Listas de materiales' }];
    }
    if (pathname.startsWith('/app/manufacturing/centros')) {
      return [{ label: 'Operaciones' }, manufactura, { label: 'Centros de trabajo' }];
    }
    if (pathname.startsWith('/app/manufacturing/trazabilidad')) {
      return [{ label: 'Operaciones' }, manufactura, { label: 'Trazabilidad' }];
    }
  }
  // Added after extraction: operational areas (plan 7.1). Written by hand here so a
  // typo in nav-config's generated rules shows up as a difference.
  for (const [key, label, spaces] of LEGACY_AREAS) {
    const home = `/app/areas/${key}/dashboard`;
    for (const [slug, spaceLabel] of spaces) {
      const path = `/app/areas/${key}/${slug}`;
      if (pathname === path) {
        return [{ label: 'Operaciones' }, { label, href: home }, { label: spaceLabel }];
      }
      if (pathname.startsWith(`${path}/`)) {
        return [
          { label: 'Operaciones' },
          { label, href: home },
          { label: spaceLabel, href: path },
          { label: 'Detalle' },
        ];
      }
    }
    if (pathname === `/app/areas/${key}`) {
      return [{ label: 'Operaciones' }, { label }];
    }
  }
  if (pathname === '/app/notifications') {
    return [{ label: 'Notificaciones' }];
  }
  return [];
}

/** Management pages of an area, listed independently of nav-config. */
const LEGACY_AREA_EXTRAS: Array<[string, string, string, string, string, string]> = [
  ['contabilidad', 'Contabilidad', 'obligaciones', 'Obligaciones', 'libro', 'Libro de caja'],
  ['contabilidad', 'Contabilidad', 'nomina', 'Nómina', 'libro', 'Libro de caja'],
  ['contabilidad', 'Contabilidad', 'cierre', 'Cierre mensual', 'libro', 'Libro de caja'],
  ['contabilidad', 'Contabilidad', 'presupuestos', 'Presupuestos', 'libro', 'Libro de caja'],
  ['contabilidad', 'Contabilidad', 'catalogos', 'Catálogos', 'libro', 'Libro de caja'],
  ['contabilidad', 'Contabilidad', 'gastos/nuevo', 'Capturar gasto', 'gastos', 'Gastos'],
  ['logistica', 'Logística', 'flota', 'Flotilla', 'despacho', 'Despacho'],
  ['logistica', 'Logística', 'chofer', 'Mis entregas', 'despacho', 'Despacho'],
  ['inventario', 'Inventario', 'perfiles', 'Perfil de producto', 'existencias', 'Existencias'],
];

/** Areas, their spaces and their crumbs, listed independently of nav-config. */
const LEGACY_AREAS: Array<[string, string, Array<[string, string]>]> = [
  [
    'ventas',
    'Ventas',
    [
      ['dashboard', 'Panel'],
      ['trabajo', 'Centro de trabajo'],
      ['comunicaciones', 'Comunicaciones'],
      ['radar', 'Radar de cierre'],
      ['oportunidades', 'Oportunidades'],
      ['pipeline', 'Embudo'],
    ],
  ],
  [
    'compras',
    'Compras',
    [
      ['dashboard', 'Panel'],
      ['trabajo', 'Centro de trabajo'],
      ['comunicaciones', 'Comunicaciones'],
      ['sourcing', 'Laboratorio de sourcing'],
      ['ordenes', 'Órdenes de compra'],
      ['rfq', 'Cotizaciones'],
      ['proveedores', 'Proveedores'],
    ],
  ],
  [
    'inventario',
    'Inventario',
    [
      ['dashboard', 'Panel'],
      ['trabajo', 'Centro de trabajo'],
      ['comunicaciones', 'Comunicaciones'],
      ['mapa', 'Mapa de ubicaciones'],
      ['existencias', 'Existencias'],
      ['conteos', 'Conteos'],
      ['movimientos', 'Movimientos'],
      ['ubicaciones', 'Ubicaciones'],
    ],
  ],
  [
    'manufactura',
    'Manufactura',
    [
      ['dashboard', 'Panel'],
      ['trabajo', 'Centro de trabajo'],
      ['comunicaciones', 'Comunicaciones'],
      ['tablero', 'Tablero de producción'],
      ['ordenes', 'Órdenes de producción'],
    ],
  ],
  [
    'logistica',
    'Logística',
    [
      ['dashboard', 'Panel'],
      ['trabajo', 'Centro de trabajo'],
      ['comunicaciones', 'Comunicaciones'],
      ['despacho', 'Despacho'],
      ['viajes', 'Viajes'],
    ],
  ],
  [
    'contabilidad',
    'Contabilidad',
    [
      ['dashboard', 'Panel'],
      ['trabajo', 'Centro de trabajo'],
      ['comunicaciones', 'Comunicaciones'],
      ['libro', 'Libro de caja'],
      ['gastos', 'Gastos'],
    ],
  ],
];

/** Area routes rendered edge to edge (work centre, communications and boards). */
const LEGACY_AREA_FLUSH = [
  '/app/areas/ventas/trabajo',
  '/app/areas/ventas/comunicaciones',
  '/app/areas/compras/trabajo',
  '/app/areas/compras/comunicaciones',
  '/app/areas/inventario/trabajo',
  '/app/areas/inventario/comunicaciones',
  '/app/areas/inventario/mapa',
  '/app/areas/manufactura/trabajo',
  '/app/areas/manufactura/comunicaciones',
  '/app/areas/manufactura/tablero',
  '/app/areas/logistica/trabajo',
  '/app/areas/logistica/comunicaciones',
  '/app/areas/logistica/despacho',
  '/app/areas/contabilidad/trabajo',
  '/app/areas/contabilidad/comunicaciones',
];

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
  // Added after extraction: area spaces (plan 7.1).
  const isAreaSpace =
    LEGACY_AREA_FLUSH.some((prefix) => pathname.startsWith(prefix)) && !pathname.includes('/api');
  // Added in the integration pass: operations (case list + 360) and the wide Control Tower surfaces.
  const isWideOperational =
    (pathname.startsWith('/app/operations') ||
      pathname.startsWith('/app/admin/control-tower/excepciones') ||
      pathname.startsWith('/app/admin/control-tower/neural')) &&
    !pathname.includes('/api');
  return (
    isWorkspace || isAssistantPage || isChatPage || isInboxPage || isAreaSpace || isWideOperational
  );
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
    // Added after extraction: operational cases (plan section 2.7) and one item per
    // operational area (plan 7.1).
    {
      title: 'Operaciones',
      items: [
        {
          href: '/app/areas/ventas/dashboard',
          label: 'Ventas',
          icon: ShoppingCart,
          visible:
            user.permissionKeys.includes('crm.view') ||
            user.permissionKeys.includes('sales_orders.view') ||
            user.permissionKeys.includes('operations.admin') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/areas/compras/dashboard',
          label: 'Compras',
          icon: ShoppingBag,
          visible:
            user.permissionKeys.includes('purchases.view') ||
            user.permissionKeys.includes('operations.admin') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/areas/inventario/dashboard',
          label: 'Inventario',
          icon: Boxes,
          visible:
            user.permissionKeys.includes('inventory.view') ||
            user.permissionKeys.includes('operations.admin') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/areas/manufactura/dashboard',
          label: 'Manufactura',
          icon: Factory,
          visible:
            user.permissionKeys.includes('manufacturing.view') ||
            user.permissionKeys.includes('operations.admin') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/areas/logistica/dashboard',
          label: 'Logística',
          icon: Truck,
          visible:
            user.permissionKeys.includes('logistics.view') ||
            user.permissionKeys.includes('operations.admin') ||
            user.isSuperAdmin,
        },
        {
          href: '/app/areas/contabilidad/dashboard',
          label: 'Contabilidad',
          icon: Wallet,
          visible:
            user.permissionKeys.includes('finance.view') ||
            user.permissionKeys.includes('operations.admin') ||
            user.isSuperAdmin,
        },
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
        // Added after extraction: Control Tower (plan 7.1).
        {
          href: '/app/admin/control-tower',
          label: 'Control Tower',
          icon: Gauge,
          visible: user.permissionKeys.includes('operations.admin') || user.isSuperAdmin,
        },
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
  'operations.admin',
  'crm.view',
  'purchases.view',
  'inventory.view',
  'manufacturing.view',
  'logistics.view',
  'finance.view',
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

  it('super admin ve las 38 entradas', () => {
    expect(NAV_HREFS).toHaveLength(38);
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

  it('los espacios de área full-bleed excluyen sus APIs', () => {
    expect(isFlushRoute('/app/areas/compras/trabajo')).toBe(true);
    expect(isFlushRoute('/app/areas/compras/trabajo/api')).toBe(false);
    expect(isFlushRoute('/app/areas/compras/dashboard')).toBe(false);
    expect(isFlushRoute('/app/areas/logistica/despacho')).toBe(true);
    expect(isFlushRoute('/app/areas/ventas/radar')).toBe(false);
  });
});

describe('áreas: navegación y registro no se separan', () => {
  it('la sección Operaciones lista las mismas áreas que el registro', () => {
    expect(AREA_NAV.map((area) => area.key)).toStrictEqual(AREA_LIST.map((area) => area.key));
    expect(AREA_NAV.map((area) => area.label)).toStrictEqual(AREA_LIST.map((area) => area.label));
    const operations = NAV_CONFIG.find(
      (entry) => entry.kind !== 'group' && entry.title === 'Operaciones'
    ) as { items: readonly { href: string }[] };
    expect(operations.items.map((item) => item.href)).toStrictEqual([
      ...AREA_LIST.map((area) => areaHref(area.key)),
      '/app/operations',
    ]);
  });

  it('cada área muestra en el menú los permisos que abren su espacio', () => {
    for (const area of AREA_LIST) {
      const entry = AREA_NAV.find((candidate) => candidate.key === area.key);
      expect([...(entry?.anyOf ?? [])], area.key).toStrictEqual(areaViewPermissions(area));
    }
  });

  it('los espacios y las migas coinciden con el registro de áreas', () => {
    for (const area of AREA_LIST) {
      const entry = AREA_NAV.find((candidate) => candidate.key === area.key);
      const spaces = areaSpaces(area);
      expect(
        entry?.spaces.map((space) => space.slug),
        area.key
      ).toStrictEqual(spaces.map((space) => space.slug));
      expect(
        entry?.spaces.map((space) => space.label),
        area.key
      ).toStrictEqual(spaces.map((space) => space.label));
      for (const space of spaces) {
        expect(buildBreadcrumbs(areaHref(area.key, space.slug))).toStrictEqual([
          { label: 'Operaciones' },
          { label: area.label, href: areaHref(area.key) },
          { label: space.label },
        ]);
      }
    }
  });

  it('las rutas full-bleed son exactamente las que marca el registro', () => {
    const fromNav = AREA_NAV.flatMap((area) =>
      area.spaces
        .filter((space) => space.flush)
        .map((space) => `/app/areas/${area.key}/${space.slug}`)
    );
    expect(fromNav.sort()).toStrictEqual([...flushAreaRoutes()].sort());
    for (const route of flushAreaRoutes()) expect(isFlushRoute(route), route).toBe(true);
  });

  it('el detalle de un espacio agrega la miga Detalle', () => {
    expect(buildBreadcrumbs('/app/areas/compras/ordenes/oc-1')).toStrictEqual([
      { label: 'Operaciones' },
      { label: 'Compras', href: '/app/areas/compras/dashboard' },
      { label: 'Órdenes de compra', href: '/app/areas/compras/ordenes' },
      { label: 'Detalle' },
    ]);
    expect(buildBreadcrumbs('/app/areas/compras')).toStrictEqual([
      { label: 'Operaciones' },
      { label: 'Compras' },
    ]);
    expect(buildBreadcrumbs('/app/areas/inexistente/dashboard')).toStrictEqual([]);
  });

  it('Control Tower vive en Administración con operations.admin', () => {
    expect(buildBreadcrumbs('/app/admin/control-tower/personas')).toStrictEqual([
      { label: 'Administración' },
      { label: 'Control Tower', href: '/app/admin/control-tower/resumen' },
      { label: 'Personas' },
    ]);
    const admin = NAV_CONFIG.find(
      (entry) => entry.kind !== 'group' && entry.title === 'Administración'
    ) as { items: readonly { href: string; anyOf?: readonly string[] }[] };
    const item = admin.items.find((candidate) => candidate.href === '/app/admin/control-tower');
    expect(item?.anyOf).toStrictEqual(['operations.admin']);
  });
});

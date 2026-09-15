/**
 * Navigation configuration for the app shell: sidebar entries, breadcrumbs and
 * full-bleed (flush) routes. Pure TypeScript — no JSX and no client state — so it
 * can be unit tested and extended by adding data.
 *
 * Visibility here is presentation only: every page, action and API route still
 * validates permissions on the server.
 */
import type { ComponentType } from 'react';
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
  type LucideIcon,
} from 'lucide-react';
import { Home, Shield, Users, type IconProps } from '@/components/ui/icons';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { PermissionKey } from '@/modules/auth/permissions';

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/**
 * Icon component rendered by the shell as `<icon size={18} />`. Lucide icons are
 * the default; a few legacy entries use UNIK's own set from `@/components/ui/icons`.
 */
export type NavIcon = LucideIcon | ComponentType<IconProps>;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  visible?: boolean;
}

export interface NavSection {
  kind?: 'section';
  title: string;
  items: NavItem[];
}

/** Collapsible group of sections (e.g. everything synced from Zoho). */
export interface NavGroup {
  kind: 'group';
  key: string;
  title: string;
  icon: NavIcon;
  sections: NavSection[];
}

export type NavEntry = NavSection | NavGroup;

/** Declarative sidebar item. */
export interface NavItemConfig {
  href: string;
  label: string;
  icon: NavIcon;
  /**
   * Permissions that reveal the item: any one of them is enough and super admins
   * see everything. Omit it for items every signed-in user sees.
   */
  anyOf?: readonly PermissionKey[];
}

export interface NavSectionConfig {
  kind?: 'section';
  title: string;
  items: readonly NavItemConfig[];
}

export interface NavGroupConfig {
  kind: 'group';
  key: string;
  title: string;
  icon: NavIcon;
  sections: readonly NavSectionConfig[];
}

export type NavEntryConfig = NavSectionConfig | NavGroupConfig;

/**
 * True when the user holds any of the given permission keys, or is a super admin.
 * Unlike `hasPermission` it never throws on unknown keys, so it is safe to call
 * from client code while rendering navigation.
 */
export function can(
  user: Pick<CurrentUser, 'permissionKeys' | 'isSuperAdmin'>,
  ...keys: readonly PermissionKey[]
): boolean {
  return keys.some((key) => user.permissionKeys.includes(key)) || user.isSuperAdmin;
}

/** Sidebar entries in display order. Sections or items are added here as data. */
export const NAV_CONFIG: readonly NavEntryConfig[] = [
  {
    title: 'General',
    items: [
      { href: '/app', label: 'Inicio', icon: Home },
      { href: '/app/mywork', label: 'Mi trabajo', icon: ClipboardList },
      { href: '/app/assistant', label: 'Asistente IA', icon: Bot, anyOf: ['assistant.use'] },
    ],
  },
  {
    title: 'Operaciones',
    items: [
      {
        href: '/app/operations',
        label: 'Expedientes',
        icon: Workflow,
        anyOf: ['operations.view'],
      },
    ],
  },
  {
    title: 'Comunicaciones',
    items: [
      { href: '/app/chat', label: 'Chat', icon: MessageCircle, anyOf: ['chat.use'] },
      { href: '/app/inbox', label: 'Bandeja externa', icon: Inbox, anyOf: ['inbox.use'] },
      {
        href: '/app/campaigns',
        label: 'Campañas',
        icon: Megaphone,
        anyOf: ['campaigns.view', 'campaigns.manage'],
      },
      {
        href: '/app/calls',
        label: 'Llamadas',
        icon: Phone,
        anyOf: ['calls.use', 'calls.supervise'],
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
            anyOf: ['sales_orders.view'],
          },
          {
            href: '/app/contacts/customers',
            label: 'Clientes',
            icon: UsersIcon,
            anyOf: ['customers.view'],
          },
          {
            href: '/app/quotes',
            label: 'Cotizaciones',
            icon: FileSignature,
            anyOf: ['quotes.view'],
          },
          { href: '/app/invoices', label: 'Facturas', icon: FileText, anyOf: ['invoices.view'] },
          { href: '/app/payments', label: 'Pagos', icon: CreditCard, anyOf: ['payments.view'] },
        ],
      },
      {
        title: 'Inventario',
        items: [
          { href: '/app/products', label: 'Productos', icon: Boxes, anyOf: ['products.view'] },
          { href: '/app/packages', label: 'Paquetes', icon: Truck, anyOf: ['packages.view'] },
        ],
      },
      {
        title: 'Compras',
        items: [
          {
            href: '/app/contacts/vendors',
            label: 'Proveedores',
            icon: UserCog,
            anyOf: ['vendors.view'],
          },
          {
            href: '/app/purchase-orders',
            label: 'Órdenes de compra',
            icon: ShoppingCart,
            anyOf: ['purchase_orders.view'],
          },
          {
            href: '/app/bills',
            label: 'Facturas de compra',
            icon: Receipt,
            anyOf: ['bills.view'],
          },
          {
            href: '/app/vendor-credits',
            label: 'Créditos de proveedor',
            icon: Wallet,
            anyOf: ['vendor_credits.view'],
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
        anyOf: ['users.view', 'roles.view'],
      },
      {
        href: '/app/admin/integrations',
        label: 'Integraciones',
        icon: Plug,
        anyOf: ['integrations.view'],
      },
      {
        href: '/app/admin/assistant',
        label: 'Asistente IA',
        icon: Bot,
        anyOf: ['assistant.admin'],
      },
      { href: '/app/admin/chat', label: 'Chat', icon: MessageSquare, anyOf: ['chat.admin'] },
      { href: '/app/admin/files', label: 'Archivos', icon: HardDrive, anyOf: ['files.admin'] },
      {
        href: '/app/admin/extensions',
        label: 'Extensiones',
        icon: Plug,
        anyOf: ['extensions.view', 'extensions.manage'],
      },
      {
        href: '/app/admin/knowledge',
        label: 'Biblioteca aprobada',
        icon: BookOpen,
        anyOf: ['knowledge.manage'],
      },
      {
        href: '/app/admin/comms',
        label: 'Canales y responsables',
        icon: Radio,
        anyOf: ['inbox.admin'],
      },
      { href: '/app/admin/voice', label: 'Telefonía', icon: PhoneCall, anyOf: ['calls.admin'] },
    ],
  },
  {
    title: 'Cuenta',
    items: [
      { href: '/app/account/security', label: 'Seguridad', icon: Shield },
      { href: '/app/notifications', label: 'Notificaciones', icon: Bell },
      { href: '/app/account/notifications', label: 'Configurar avisos', icon: SlidersHorizontal },
    ],
  },
];

function buildSection(section: NavSectionConfig, user: CurrentUser): NavSection {
  return {
    ...(section.kind ? { kind: section.kind } : {}),
    title: section.title,
    items: section.items.map((item) => ({
      href: item.href,
      label: item.label,
      icon: item.icon,
      visible: item.anyOf ? can(user, ...item.anyOf) : true,
    })),
  };
}

/** Resolves `NAV_CONFIG` for a user: every item carries an explicit `visible` flag. */
export function buildNavSections(user: CurrentUser): NavEntry[] {
  return NAV_CONFIG.map((entry): NavEntry =>
    entry.kind === 'group'
      ? {
          kind: 'group',
          key: entry.key,
          title: entry.title,
          icon: entry.icon,
          sections: entry.sections.map((section) => buildSection(section, user)),
        }
      : buildSection(entry, user)
  );
}

/** Items of a section that should be rendered. */
export function visibleNavItems(section: NavSection): NavItem[] {
  return section.items.filter((item) => item.visible !== false);
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

export interface Breadcrumb {
  label: string;
  href?: string;
}

export interface BreadcrumbRule {
  /** Path compared against the pathname. */
  path: string;
  /**
   * `exact`: pathname === path. `prefix`: raw `startsWith(path)` — include a
   * trailing '/' in `path` to match only nested pages.
   */
  match: 'exact' | 'prefix';
  /** Optional extra condition: the pathname must also end with this suffix. */
  suffix?: string;
  crumbs: readonly Breadcrumb[];
}

/** A page whose parent crumb links back to the page itself (admin, communications). */
function pageRule(path: string, parent: string, label: string): BreadcrumbRule {
  return { path, match: 'prefix', crumbs: [{ label: parent, href: path }, { label }] };
}

/** Entity list (`<area> / <plural>`) and its nested pages (`<area> / <plural> / Detalle`). */
function entityRules(path: string, area: string, plural: string): BreadcrumbRule[] {
  return [
    { path, match: 'exact', crumbs: [{ label: area }, { label: plural }] },
    {
      path: `${path}/`,
      match: 'prefix',
      crumbs: [{ label: area }, { label: plural, href: path }, { label: 'Detalle' }],
    },
  ];
}

/** Most specific rule first: longer path, then rules with a suffix, then exact matches. */
function compareRules(a: BreadcrumbRule, b: BreadcrumbRule): number {
  if (a.path.length !== b.path.length) return b.path.length - a.path.length;
  if (Boolean(a.suffix) !== Boolean(b.suffix)) return a.suffix ? -1 : 1;
  if (a.match !== b.match) return a.match === 'exact' ? -1 : 1;
  return 0;
}

/** Rules grouped by area for readability; `BREADCRUMB_RULES` holds them sorted. */
const DECLARED_BREADCRUMB_RULES: BreadcrumbRule[] = [
  { path: '/app', match: 'exact', crumbs: [] },

  pageRule('/app/admin/access', 'Administración', 'Usuarios y permisos'),
  pageRule('/app/admin/integrations', 'Administración', 'Integraciones'),
  pageRule('/app/admin/assistant', 'Administración', 'Asistente IA'),
  pageRule('/app/admin/chat', 'Administración', 'Chat'),
  pageRule('/app/admin/files', 'Administración', 'Archivos'),
  pageRule('/app/admin/extensions', 'Administración', 'Extensiones'),
  pageRule('/app/admin/knowledge', 'Administración', 'Biblioteca aprobada'),
  pageRule('/app/admin/comms', 'Administración', 'Canales y responsables'),
  pageRule('/app/admin/voice', 'Administración', 'Telefonía'),

  pageRule('/app/inbox', 'Comunicaciones', 'Bandeja externa'),
  pageRule('/app/campaigns', 'Comunicaciones', 'Campañas'),
  pageRule('/app/calls', 'Comunicaciones', 'Llamadas'),

  {
    path: '/app/assistant/extensions',
    match: 'prefix',
    crumbs: [{ label: 'Asistente IA', href: '/app/assistant' }, { label: 'Extensiones y skills' }],
  },
  { path: '/app/assistant', match: 'prefix', crumbs: [{ label: 'Asistente IA' }] },
  { path: '/app/chat', match: 'prefix', crumbs: [{ label: 'Chat' }] },
  { path: '/app/mywork', match: 'prefix', crumbs: [{ label: 'Mi trabajo' }] },

  {
    path: '/app/account/security',
    match: 'prefix',
    crumbs: [{ label: 'Cuenta' }, { label: 'Seguridad' }],
  },
  {
    path: '/app/account/notifications',
    match: 'prefix',
    crumbs: [{ label: 'Cuenta' }, { label: 'Mis notificaciones' }],
  },

  ...entityRules('/app/sales/orders', 'Ventas', 'Órdenes de venta'),
  ...entityRules('/app/contacts/customers', 'Ventas', 'Clientes'),
  ...entityRules('/app/quotes', 'Ventas', 'Cotizaciones'),
  {
    path: '/app/quotes/new',
    match: 'exact',
    crumbs: [
      { label: 'Ventas' },
      { label: 'Cotizaciones', href: '/app/quotes' },
      { label: 'Nueva' },
    ],
  },
  {
    path: '/app/quotes/',
    match: 'prefix',
    suffix: '/edit',
    crumbs: [
      { label: 'Ventas' },
      { label: 'Cotizaciones', href: '/app/quotes' },
      { label: 'Editar' },
    ],
  },
  ...entityRules('/app/invoices', 'Ventas', 'Facturas'),
  ...entityRules('/app/payments', 'Ventas', 'Pagos'),

  ...entityRules('/app/products', 'Inventario', 'Productos'),
  ...entityRules('/app/packages', 'Inventario', 'Paquetes'),

  ...entityRules('/app/contacts/vendors', 'Compras', 'Proveedores'),
  ...entityRules('/app/purchase-orders', 'Compras', 'Órdenes de compra'),
  ...entityRules('/app/bills', 'Compras', 'Facturas de compra'),
  ...entityRules('/app/vendor-credits', 'Compras', 'Créditos de proveedor'),

  { path: '/app/notifications', match: 'exact', crumbs: [{ label: 'Notificaciones' }] },
];

/** Breadcrumb rules ordered by specificity; the first matching rule wins. */
export const BREADCRUMB_RULES: readonly BreadcrumbRule[] = [...DECLARED_BREADCRUMB_RULES].sort(
  compareRules
);

function matchesRule(rule: BreadcrumbRule, pathname: string): boolean {
  const pathMatches =
    rule.match === 'exact' ? pathname === rule.path : pathname.startsWith(rule.path);
  return pathMatches && (rule.suffix === undefined || pathname.endsWith(rule.suffix));
}

/** Breadcrumbs for a pathname; unknown routes (and `/app` itself) have none. */
export function buildBreadcrumbs(pathname: string): Breadcrumb[] {
  const rule = BREADCRUMB_RULES.find((candidate) => matchesRule(candidate, pathname));
  return rule ? rule.crumbs.map((crumb) => ({ ...crumb })) : [];
}

// ---------------------------------------------------------------------------
// Full-bleed routes
// ---------------------------------------------------------------------------

export interface FlushRoutePrefix {
  /** Raw `startsWith` prefix. */
  prefix: string;
  /** When true, pathnames containing '/api' anywhere are not full-bleed. */
  excludeApi?: boolean;
}

/** Routes rendered edge to edge (`app-content-flush`) instead of the padded content area. */
export const FLUSH_ROUTE_PREFIXES: readonly FlushRoutePrefix[] = [
  // Zoho entity workspaces.
  { prefix: '/app/sales/orders', excludeApi: true },
  { prefix: '/app/contacts/customers', excludeApi: true },
  { prefix: '/app/contacts/vendors', excludeApi: true },
  { prefix: '/app/products', excludeApi: true },
  { prefix: '/app/packages', excludeApi: true },
  { prefix: '/app/invoices', excludeApi: true },
  { prefix: '/app/payments', excludeApi: true },
  { prefix: '/app/purchase-orders', excludeApi: true },
  { prefix: '/app/bills', excludeApi: true },
  { prefix: '/app/vendor-credits', excludeApi: true },
  // Conversational surfaces.
  { prefix: '/app/assistant' },
  { prefix: '/app/chat' },
  { prefix: '/app/inbox' },
];

export function isFlushRoute(pathname: string): boolean {
  return FLUSH_ROUTE_PREFIXES.some(
    (route) => pathname.startsWith(route.prefix) && !(route.excludeApi && pathname.includes('/api'))
  );
}

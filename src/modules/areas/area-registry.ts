import {
  Boxes,
  Factory,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { areaCopilotStarters } from '@/components/operations/copilot-starters';
import { isKnownPermission, type PermissionKey } from '@/modules/auth/permissions';
import { FINANCE_AREA_ACT_PERMISSIONS } from '@/modules/finance/permissions';
import {
  MANUFACTURING_APPROVER_PERMISSION,
  MANUFACTURING_AREA_ACT_PERMISSIONS,
} from '@/modules/manufacturing/permissions';
import { PURCHASES_ACT_PERMISSIONS, PURCHASES_PERMISSION } from '@/modules/purchases/permissions';
import { AREA_LABELS, type AreaKey } from '@/modules/operations/types';

/**
 * Registry of the six operational areas (plan 7.2). ISOMORPHIC: pure data and
 * pure functions, no Prisma and no React, so the server pages, the client
 * workspace, the navigation and the tests all read the same definition.
 *
 * Every permission here is a REAL key of an existing module (`crm.*`,
 * `purchases.*`, `inventory.*`, `manufacturing.*`, `logistics.*`, `finance.*`):
 * no `area.<key>.*` nor `operations.<área>.*` families are invented. The
 * transversal keys `operations.view|manage|admin` stay for the core.
 *
 * Administración is NOT an area workspace: its experience is the Control Tower
 * (`/app/admin/control-tower`), so `getArea('administracion')` returns null and
 * the route answers 404.
 *
 * Data the domain agents add: their own row kinds live in `workCenter.rowKinds`
 * and their extra columns in `workCenter.extraColumns`; the SQL branch that
 * fills those rows is registered from `src/modules/areas/<area>/register.ts`
 * (server) through `area-server-registry.ts`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Area keys that have a workspace under `/app/areas/<key>` (Administración is the Control Tower). */
export const AREA_WORKSPACE_KEYS = [
  'ventas',
  'compras',
  'inventario',
  'manufactura',
  'logistica',
  'contabilidad',
] as const satisfies readonly AreaKey[];

export type AreaWorkspaceKey = (typeof AREA_WORKSPACE_KEYS)[number];

export interface AreaPermissions {
  /** Any of these opens the area (plus `operations.admin`, added by `areaViewPermissions`). */
  view: readonly string[];
  /** Any of these lets a person run the area's row commands. */
  act: readonly string[];
  /** Any of these signs the area's business approvals. */
  approve: readonly string[];
  /**
   * Any of these EXPORTS the area's rows to CSV/XLSX. It is a narrower door
   * than `view`: the plan gives Compras, Ventas y Contabilidad their own key
   * (`purchases.export`, `crm.export`/`sales_orders.export`, `finance.export`),
   * so being able to read the area no longer means being able to take its
   * lists out of UNIK.
   *
   * Areas the plan gives no export key (Inventario, Manufactura, Logística)
   * leave it undefined and keep the old rule — whoever sees the area exports
   * it — instead of inventing a permission nobody can grant yet.
   */
  export?: readonly string[];
  /**
   * Extra keys that get PAST THE LAYOUT of the area but see nothing by
   * themselves. Every page under `/app/areas/<key>` checks its own rule again
   * (the spaces demand `view`), so this only stops the layout from turning a
   * page with its own, narrower audience into a 404 — the driver PWA being the
   * case: a driver holds `logistics.drive`, never `logistics.view`.
   */
  entry?: readonly string[];
}

/** Extra column of the work centre of an area; its value is read from `row.extra[field]`. */
export interface AreaExtraColumn {
  /** Key inside `AreaWorkRow.extra`. */
  field: string;
  label: string;
  type: 'text' | 'date' | 'number' | 'currency' | 'status' | 'boolean';
  /** Visible without opening the column manager. */
  defaultVisible?: boolean;
  width?: number;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  filterable?: boolean;
}

export interface AreaWorkCenter {
  /** Table preferences / saved views key (`areas:<key>:work`). */
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  /** Row kinds of the UNION: the common ones plus the area's own. */
  rowKinds: readonly string[];
  extraColumns?: readonly AreaExtraColumn[];
}

export interface AreaComms {
  /** Realtime + internal chat channel of the area. */
  channelKey: string;
  /** Roles (`equipo_<área>`) mapped to `CommAccount.teamKeys` for the external inbox. */
  inboxTeamKeys: readonly string[];
}

export interface AreaSpecialView {
  slug: string;
  label: string;
  /** Rendered edge to edge (maps, boards). */
  flush: boolean;
  description: string;
}

/** Detail / management page of an area (`/app/areas/<key>/<slug>` and `/<slug>/<id>`). */
export interface AreaSubpage {
  slug: string;
  label: string;
  permission: string;
  /** Row kinds listed by the subpage (a filtered view of the work centre). */
  rowKinds: readonly string[];
  description: string;
}

export interface AreaMeta {
  key: AreaWorkspaceKey;
  label: string;
  description: string;
  icon: LucideIcon;
  permissions: AreaPermissions;
  workCenter: AreaWorkCenter;
  comms: AreaComms;
  special: AreaSpecialView;
  subpages: readonly AreaSubpage[];
  copilotStarters: readonly string[];
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export const AREA_SPACE_SLUGS = {
  dashboard: 'dashboard',
  work: 'trabajo',
  comms: 'comunicaciones',
} as const;

export type AreaSpaceKind = 'dashboard' | 'work' | 'comms' | 'special' | 'subpage';

export interface AreaSpace {
  slug: string;
  label: string;
  kind: AreaSpaceKind;
  /** Full-bleed route (`app-content-flush`). */
  flush: boolean;
  /** Any of these permissions reveals the tab (empty = the area's view permissions). */
  permissions: readonly string[];
  description: string;
}

// ---------------------------------------------------------------------------
// Common row kinds
// ---------------------------------------------------------------------------

/** Branches every area has: its work items and the requests it receives and sends. */
export const COMMON_ROW_KINDS = ['work_item', 'request_in', 'request_out'] as const;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function meta(input: Omit<AreaMeta, 'label' | 'copilotStarters'> & { label?: string }): AreaMeta {
  return {
    ...input,
    label: input.label ?? AREA_LABELS[input.key],
    copilotStarters: areaCopilotStarters(input.key),
  };
}

const VENTAS = meta({
  key: 'ventas',
  description: 'Expedientes de venta, oportunidades y compromisos con el cliente.',
  icon: ShoppingCart,
  permissions: {
    view: ['crm.view', 'sales_orders.view'],
    act: ['crm.manage'],
    // No existe `crm.approve`: quien gestiona el embudo firma las decisiones comerciales.
    approve: ['crm.manage'],
    // Ver el embudo no es poder sacarlo: la tabla mezcla oportunidades y pedidos.
    export: ['crm.export', 'sales_orders.export'],
  },
  workCenter: {
    tableKey: 'areas:ventas:work',
    entityLabel: 'Pendiente',
    entityLabelPlural: 'Pendientes',
    rowKinds: [...COMMON_ROW_KINDS, 'case', 'opportunity', 'quote'],
    extraColumns: [
      { field: 'promisedAt', label: 'Prometido', type: 'date', defaultVisible: true, width: 130 },
      { field: 'phase', label: 'Fase', type: 'text', width: 130 },
    ],
  },
  comms: { channelKey: 'area:ventas', inboxTeamKeys: ['equipo_ventas'] },
  special: {
    slug: 'radar',
    label: 'Radar de cierre',
    flush: false,
    description: 'Señales de cierre y retención ordenadas por puntaje.',
  },
  subpages: [
    {
      slug: 'oportunidades',
      label: 'Oportunidades',
      permission: 'crm.view',
      rowKinds: ['opportunity'],
      description: 'Embudo comercial con su siguiente acción.',
    },
    {
      // `rowKinds: []` porque no es una tabla de filas: la sirve su propia página
      // (`/app/areas/[areaKey]/pipeline`), que gana sobre el espacio genérico.
      slug: 'pipeline',
      label: 'Embudo',
      permission: 'crm.view',
      rowKinds: [],
      description: 'Oportunidades por etapa y cotizaciones aceptadas por convertir.',
    },
  ],
});

const COMPRAS = meta({
  key: 'compras',
  description: 'Solicitudes, cotizaciones a proveedor, órdenes de compra y recepciones.',
  icon: ShoppingBag,
  permissions: {
    view: [PURCHASES_PERMISSION.view],
    act: [...PURCHASES_ACT_PERMISSIONS],
    approve: [PURCHASES_PERMISSION.approve],
    export: [PURCHASES_PERMISSION.export],
  },
  workCenter: {
    tableKey: 'areas:compras:work',
    entityLabel: 'Pendiente',
    entityLabelPlural: 'Pendientes',
    rowKinds: [
      ...COMMON_ROW_KINDS,
      'purchase_request',
      'rfq',
      'procurement_order',
      'goods_receipt',
      'supplier',
    ],
    extraColumns: [
      { field: 'vendorName', label: 'Proveedor', type: 'text', defaultVisible: true, width: 180 },
      { field: 'expectedAt', label: 'Llega', type: 'date', width: 130 },
    ],
  },
  comms: { channelKey: 'area:compras', inboxTeamKeys: ['equipo_compras'] },
  special: {
    slug: 'sourcing',
    label: 'Laboratorio de sourcing',
    flush: false,
    description: 'Búsqueda de proveedores, candidatos y comparación de cotizaciones.',
  },
  subpages: [
    {
      slug: 'ordenes',
      label: 'Órdenes de compra',
      permission: PURCHASES_PERMISSION.view,
      rowKinds: ['procurement_order'],
      description: 'Órdenes de compra de UNIK con su estado de pago y recepción.',
    },
    {
      slug: 'rfq',
      label: 'Cotizaciones',
      permission: PURCHASES_PERMISSION.view,
      rowKinds: ['rfq'],
      description: 'Cotizaciones pedidas a proveedores, con sus respuestas y su comparación.',
    },
    {
      slug: 'proveedores',
      label: 'Proveedores',
      permission: PURCHASES_PERMISSION.view,
      rowKinds: ['supplier'],
      description: 'Proveedores de UNIK con su calificación, sus productos y sus órdenes.',
    },
  ],
});

const INVENTARIO = meta({
  key: 'inventario',
  description: 'Verificaciones, conteos, reservas y movimientos por ubicación.',
  icon: Boxes,
  permissions: {
    view: ['inventory.view'],
    act: ['inventory.count', 'inventory.reserve', 'inventory.adjust', 'inventory.manage'],
    approve: ['inventory.adjust', 'inventory.manage'],
  },
  workCenter: {
    tableKey: 'areas:inventario:work',
    entityLabel: 'Pendiente',
    entityLabelPlural: 'Pendientes',
    rowKinds: [
      ...COMMON_ROW_KINDS,
      'verification',
      'stock_count',
      'reservation',
      'movement',
      // Compromisos previos al corte: restan del disponible hasta confirmarse o
      // liberarse, así que son trabajo del área, no un dato escondido.
      'legacy_claim',
    ],
    extraColumns: [
      { field: 'sku', label: 'SKU', type: 'text', defaultVisible: true, width: 140 },
      { field: 'confidence', label: 'Confianza', type: 'status', width: 130 },
    ],
  },
  comms: { channelKey: 'area:inventario', inboxTeamKeys: ['equipo_inventario'] },
  special: {
    slug: 'mapa',
    label: 'Mapa de ubicaciones',
    flush: true,
    description: 'Bodegas y ubicaciones coloreadas por nivel de confianza.',
  },
  subpages: [
    {
      slug: 'existencias',
      label: 'Existencias',
      permission: 'inventory.view',
      // Its own page (`/app/areas/inventario/existencias`): stock by product,
      // warehouse and location, not a filtered view of the work centre.
      rowKinds: [],
      description: 'Existencias por artículo con su confianza, disponible y reservado.',
    },
    {
      slug: 'conteos',
      label: 'Conteos',
      permission: 'inventory.view',
      rowKinds: ['stock_count'],
      description:
        'Conteos abiertos y sus diferencias por resolver: un conteo cerrado sigue aquí mientras le quede una diferencia por decidir.',
    },
    {
      slug: 'movimientos',
      label: 'Movimientos',
      permission: 'inventory.view',
      rowKinds: ['movement'],
      description:
        'Entradas, salidas, traspasos y ajustes del día. Se registran desde Existencias, con el botón «Registrar» del artículo.',
    },
    {
      slug: 'ubicaciones',
      label: 'Ubicaciones',
      permission: 'inventory.view',
      // Its own page: warehouses, locations and label printing.
      rowKinds: [],
      description: 'Bodegas, ubicaciones y etiquetas para imprimir.',
    },
  ],
});

const MANUFACTURA = meta({
  key: 'manufactura',
  description: 'Órdenes de producción, operaciones por centro y control de merma.',
  icon: Factory,
  permissions: {
    view: ['manufacturing.view'],
    act: [...MANUFACTURING_AREA_ACT_PERMISSIONS],
    approve: [MANUFACTURING_APPROVER_PERMISSION],
  },
  workCenter: {
    tableKey: 'areas:manufactura:work',
    entityLabel: 'Pendiente',
    entityLabelPlural: 'Pendientes',
    rowKinds: [...COMMON_ROW_KINDS, 'production_order', 'production_operation'],
    extraColumns: [
      { field: 'workCenter', label: 'Centro', type: 'text', defaultVisible: true, width: 150 },
      { field: 'plannedEndAt', label: 'Termina', type: 'date', width: 130 },
    ],
  },
  comms: { channelKey: 'area:manufactura', inboxTeamKeys: ['equipo_manufactura'] },
  special: {
    slug: 'tablero',
    label: 'Tablero de producción',
    flush: true,
    description: 'Carga por centro y turno con las órdenes en curso.',
  },
  subpages: [
    {
      slug: 'ordenes',
      label: 'Órdenes de producción',
      permission: 'manufacturing.view',
      rowKinds: ['production_order'],
      description: 'Órdenes de producción con material, avance y calidad.',
    },
  ],
});

const LOGISTICA = meta({
  key: 'logistica',
  description: 'Entregas planeadas, viajes, evidencias y sincronización con Zoho.',
  icon: Truck,
  permissions: {
    view: ['logistics.view'],
    act: ['logistics.dispatch', 'logistics.manage_fleet'],
    approve: ['logistics.manage_fleet'],
    // A driver holds `logistics.drive` and nothing else: without this the layout
    // 404s their own PWA (`/app/areas/logistica/chofer`). It opens no space:
    // every one of them still demands `logistics.view`.
    entry: ['logistics.drive'],
  },
  workCenter: {
    tableKey: 'areas:logistica:work',
    entityLabel: 'Pendiente',
    entityLabelPlural: 'Pendientes',
    rowKinds: [...COMMON_ROW_KINDS, 'delivery_order', 'trip'],
    extraColumns: [
      { field: 'carrier', label: 'Transportista', type: 'text', defaultVisible: true, width: 170 },
      { field: 'plannedDate', label: 'Planeada', type: 'date', width: 130 },
    ],
  },
  comms: { channelKey: 'area:logistica', inboxTeamKeys: ['equipo_logistica'] },
  special: {
    slug: 'despacho',
    label: 'Despacho',
    flush: true,
    description: 'Entregas sin asignar, mapa de paradas y viajes del día.',
  },
  subpages: [
    {
      slug: 'viajes',
      label: 'Viajes',
      permission: 'logistics.view',
      rowKinds: ['trip'],
      description: 'Viajes con su chofer, unidad y paradas.',
    },
  ],
});

const CONTABILIDAD = meta({
  key: 'contabilidad',
  description: 'Gastos, obligaciones por pagar y cobrar, y cierre del periodo.',
  icon: Wallet,
  permissions: {
    view: ['finance.view'],
    act: [...FINANCE_AREA_ACT_PERMISSIONS],
    approve: ['finance.approve'],
    export: ['finance.export'],
  },
  workCenter: {
    tableKey: 'areas:contabilidad:work',
    entityLabel: 'Pendiente',
    entityLabelPlural: 'Pendientes',
    rowKinds: [...COMMON_ROW_KINDS, 'expense', 'obligation', 'period_close_task'],
    extraColumns: [
      {
        field: 'counterparty',
        label: 'Contraparte',
        type: 'text',
        defaultVisible: true,
        width: 180,
      },
      { field: 'periodKey', label: 'Periodo', type: 'text', width: 110 },
    ],
  },
  comms: { channelKey: 'area:contabilidad', inboxTeamKeys: ['equipo_contabilidad'] },
  special: {
    slug: 'libro',
    label: 'Libro de caja',
    flush: false,
    description: 'Saldos de cuentas, renglones del libro y avance del cierre.',
  },
  subpages: [
    {
      slug: 'gastos',
      label: 'Gastos',
      permission: 'finance.view',
      rowKinds: ['expense'],
      description: 'Gastos capturados, su aprobación y su comprobante.',
    },
  ],
});

export const AREA_REGISTRY: Readonly<Record<AreaWorkspaceKey, AreaMeta>> = {
  ventas: VENTAS,
  compras: COMPRAS,
  inventario: INVENTARIO,
  manufactura: MANUFACTURA,
  logistica: LOGISTICA,
  contabilidad: CONTABILIDAD,
};

/** Areas in display order (same order as the operations core). */
export const AREA_LIST: readonly AreaMeta[] = AREA_WORKSPACE_KEYS.map((key) => AREA_REGISTRY[key]);

export function isAreaWorkspaceKey(value: unknown): value is AreaWorkspaceKey {
  return typeof value === 'string' && (AREA_WORKSPACE_KEYS as readonly string[]).includes(value);
}

/** Area metadata, or null for an unknown key (the route answers 404). */
export function getArea(areaKey: string | null | undefined): AreaMeta | null {
  return isAreaWorkspaceKey(areaKey) ? AREA_REGISTRY[areaKey] : null;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Keys of the list that exist in the code-first registry (a module not installed yet contributes nothing). */
export function knownAreaPermissions(keys: readonly string[]): PermissionKey[] {
  const out: PermissionKey[] = [];
  for (const key of keys) {
    if (isKnownPermission(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Any of these opens the area: its module view permissions or `operations.admin`. */
export function areaViewPermissions(area: AreaMeta): PermissionKey[] {
  return knownAreaPermissions([...area.permissions.view, 'operations.admin']);
}

/**
 * Any of these gets past the area's LAYOUT. It is a coarse gate, never an
 * authorization: the spaces demand `areaViewPermissions` again, and each page
 * with its own audience (the driver PWA) checks its own rule. Widening this
 * shows nobody anything new — it only stops a 404 on a page meant for them.
 */
export function areaEntryPermissions(area: AreaMeta): PermissionKey[] {
  return knownAreaPermissions([
    ...area.permissions.view,
    ...(area.permissions.entry ?? []),
    'operations.admin',
  ]);
}

/**
 * Any of these EXPORTS the rows of the area. When the area declares its own
 * export keys they are the only door (plus `operations.admin`, who already
 * reads everything); when it declares none, exporting is what viewing has
 * always been.
 */
export function areaExportPermissions(area: AreaMeta): PermissionKey[] {
  const own = area.permissions.export ?? area.permissions.view;
  return knownAreaPermissions([...own, 'operations.admin']);
}

/** Any of these lets a person run the commands of the area's rows. */
export function areaActPermissions(area: AreaMeta): PermissionKey[] {
  return knownAreaPermissions([...area.permissions.act, 'operations.manage', 'operations.admin']);
}

/** Any of these signs the business approvals of the area. */
export function areaApprovePermissions(area: AreaMeta): PermissionKey[] {
  return knownAreaPermissions([...area.permissions.approve, 'operations.admin']);
}

/**
 * Any of these signs the PROPOSALS OF THE AREA'S AI AGENT (`approverScope.permissions`): the
 * same «Aprobar» column, WITHOUT `operations.admin` — administering operations does not sign
 * the decisions of the AI. Single source of the table the AI layer publishes
 * (`AREA_APPROVER_PERMISSION_CANDIDATES`, `docs/modules/agents.md` §Aprobaciones): an area with
 * no workspace (Administración) contributes nothing and its scope is responsible + backup.
 */
export function areaAgentApproverPermissions(areaKey: string): PermissionKey[] {
  return knownAreaPermissions(getArea(areaKey)?.permissions.approve ?? []);
}

interface PermissionHolder {
  permissionKeys: readonly string[];
  isSuperAdmin: boolean;
}

/** True when the holder has any of the keys (super admins always). Never throws on unknown keys. */
export function holdsAny(user: PermissionHolder, keys: readonly string[]): boolean {
  return user.isSuperAdmin || keys.some((key) => user.permissionKeys.includes(key));
}

// ---------------------------------------------------------------------------
// Spaces and links
// ---------------------------------------------------------------------------

export const AREA_BASE_PATH = '/app/areas';

export function areaHref(areaKey: string, slug: string = AREA_SPACE_SLUGS.dashboard): string {
  return `${AREA_BASE_PATH}/${encodeURIComponent(areaKey)}/${encodeURIComponent(slug)}`;
}

export function areaDetailHref(areaKey: string, slug: string, id: string): string {
  return `${areaHref(areaKey, slug)}/${encodeURIComponent(id)}`;
}

/** Every space of an area in tab order: the three fixed ones, the special view and its subpages. */
export function areaSpaces(area: AreaMeta): AreaSpace[] {
  return [
    {
      slug: AREA_SPACE_SLUGS.dashboard,
      label: 'Panel',
      kind: 'dashboard',
      flush: false,
      permissions: area.permissions.view,
      description: `Indicadores de ${area.label} con su frescura.`,
    },
    {
      slug: AREA_SPACE_SLUGS.work,
      label: 'Centro de trabajo',
      kind: 'work',
      flush: true,
      permissions: area.permissions.view,
      description: `Todo lo que ${area.label} tiene que atender, con la IA supervisando la tabla.`,
    },
    {
      slug: AREA_SPACE_SLUGS.comms,
      label: 'Comunicaciones',
      kind: 'comms',
      flush: true,
      permissions: area.permissions.view,
      description: `Canal del área, salas de expediente y solicitudes de ${area.label}.`,
    },
    {
      slug: area.special.slug,
      label: area.special.label,
      kind: 'special',
      flush: area.special.flush,
      permissions: area.permissions.view,
      description: area.special.description,
    },
    ...area.subpages.map((subpage): AreaSpace => ({
      slug: subpage.slug,
      label: subpage.label,
      kind: 'subpage',
      flush: false,
      permissions: [subpage.permission],
      description: subpage.description,
    })),
  ];
}

/** The space of a slug, or null when the area does not have it (404). */
export function findAreaSpace(area: AreaMeta, slug: string | null | undefined): AreaSpace | null {
  if (!slug) return null;
  return areaSpaces(area).find((space) => space.slug === slug) ?? null;
}

/** Spaces the person may open (the rest are not rendered; the server checks again). */
export function visibleAreaSpaces(area: AreaMeta, user: PermissionHolder): AreaSpace[] {
  return areaSpaces(area).filter((space) =>
    holdsAny(user, knownAreaPermissions([...space.permissions, 'operations.admin']))
  );
}

/** The subpage of a slug (detail pages live under it). */
export function findAreaSubpage(area: AreaMeta, slug: string): AreaSubpage | null {
  return area.subpages.find((subpage) => subpage.slug === slug) ?? null;
}

/** Row kinds a space lists: the whole work centre, or the subset of a subpage. */
export function rowKindsForSpace(area: AreaMeta, space: AreaSpace): readonly string[] {
  if (space.kind !== 'subpage') return area.workCenter.rowKinds;
  const subpage = findAreaSubpage(area, space.slug);
  return subpage ? subpage.rowKinds : area.workCenter.rowKinds;
}

// ---------------------------------------------------------------------------
// Serializable view for Client Components
// ---------------------------------------------------------------------------

/**
 * What a Client Component needs from an area. `AreaMeta.icon` is a React
 * component and cannot cross the server/client boundary, so pages pass this
 * instead.
 */
export interface AreaClientMeta {
  key: AreaWorkspaceKey;
  label: string;
  description: string;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  rowKinds: string[];
  specialSlug: string;
  specialLabel: string;
  copilotStarters: string[];
}

export function toAreaClientMeta(area: AreaMeta): AreaClientMeta {
  return {
    key: area.key,
    label: area.label,
    description: area.description,
    tableKey: area.workCenter.tableKey,
    entityLabel: area.workCenter.entityLabel,
    entityLabelPlural: area.workCenter.entityLabelPlural,
    rowKinds: [...area.workCenter.rowKinds],
    specialSlug: area.special.slug,
    specialLabel: area.special.label,
    copilotStarters: [...area.copilotStarters],
  };
}

/** Full-bleed area routes (`/app/areas/<key>/<space>`), for `isFlushRoute`. */
export function flushAreaRoutes(): string[] {
  return AREA_LIST.flatMap((area) =>
    areaSpaces(area)
      .filter((space) => space.flush)
      .map((space) => areaHref(area.key, space.slug))
  );
}

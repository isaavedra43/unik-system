import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Permissions of Compras y Laboratorio de Sourcing (plan 6.1; code-first
 * registry, no migration). `purchase_orders.*` stays the read-only module of
 * the historical Zoho purchase orders.
 *
 * - `purchases.view`: requests, RFQs with their comparison, procurement orders,
 *   receipts, suppliers, candidates and searches (read only).
 * - `purchases.manage_suppliers`: create and edit suppliers, their products and
 *   evaluations; link a supplier to a Zoho vendor; promote a sourcing candidate.
 * - `purchases.request`: create, cancel and consolidate purchase requests.
 * - `purchases.manage_orders`: RFQs (create, invite, confirm, compare, select)
 *   and procurement orders (create, edit a draft, submit, request payment,
 *   send, allocate, cancel, close).
 * - `purchases.approve`: approver of the `procurement` business approvals
 *   (double signature from the configured threshold).
 * - `purchases.receive`: goods receipts, direct deliveries and resolution of
 *   receipt differences.
 * - `purchases.sourcing`: run web/catalog searches of the Sourcing Lab and work
 *   the candidates.
 * - `purchases.export`: export procurement lists.
 *
 * super_admin bypasses the list, so these keys apply to that role automatically.
 */
export const PURCHASES_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'purchases.view',
    group: 'Compras',
    label: 'Ver compras',
    description:
      'Permite consultar solicitudes de compra, cotizaciones, órdenes, recepciones, proveedores y el laboratorio de sourcing',
  },
  {
    key: 'purchases.manage_suppliers',
    group: 'Compras',
    label: 'Gestionar proveedores',
    description:
      'Permite dar de alta y editar proveedores, sus productos y evaluaciones, y promover candidatos del laboratorio',
  },
  {
    key: 'purchases.request',
    group: 'Compras',
    label: 'Solicitar compras',
    description: 'Permite crear, cancelar y consolidar solicitudes de compra',
  },
  {
    key: 'purchases.manage_orders',
    group: 'Compras',
    label: 'Gestionar órdenes de compra',
    description:
      'Permite cotizar con proveedores, crear, enviar, asignar, cancelar y cerrar órdenes de compra y solicitar su pago',
  },
  {
    key: 'purchases.approve',
    group: 'Compras',
    label: 'Aprobar compras',
    description:
      'Permite firmar la aprobación de órdenes de compra (doble firma desde el umbral configurado)',
  },
  {
    key: 'purchases.receive',
    group: 'Compras',
    label: 'Recibir compras',
    description:
      'Permite registrar recepciones de material, entregas directas del proveedor y resolver diferencias',
  },
  {
    key: 'purchases.sourcing',
    group: 'Compras',
    label: 'Laboratorio de sourcing',
    description:
      'Permite buscar proveedores en la web y en catálogos autorizados y trabajar los candidatos encontrados',
  },
  {
    key: 'purchases.export',
    group: 'Compras',
    label: 'Exportar compras',
    description: 'Permite exportar listados de órdenes y solicitudes de compra',
  },
];

export const PURCHASES_PERMISSION = {
  view: 'purchases.view',
  manageSuppliers: 'purchases.manage_suppliers',
  request: 'purchases.request',
  manageOrders: 'purchases.manage_orders',
  approve: 'purchases.approve',
  receive: 'purchases.receive',
  sourcing: 'purchases.sourcing',
  export: 'purchases.export',
} as const;

/** Action keys a person may hold to act for Compras (operations-tool-kit `AREA_ACT_PERMISSION_CANDIDATES`). */
export const PURCHASES_ACT_PERMISSIONS = [
  PURCHASES_PERMISSION.request,
  PURCHASES_PERMISSION.manageOrders,
  PURCHASES_PERMISSION.receive,
  PURCHASES_PERMISSION.sourcing,
  PURCHASES_PERMISSION.manageSuppliers,
] as const;

/**
 * Action keys of the Compras AI identity (agents `AGENT_AREA_PERMISSION_CANDIDATES.compras.act`):
 * drafting requests, RFQs and orders and searching suppliers. Never approvals, receipts (a physical
 * fact recorded by a person), supplier master data or exports.
 */
export const PURCHASES_AGENT_ACT_PERMISSIONS = [
  PURCHASES_PERMISSION.request,
  PURCHASES_PERMISSION.manageOrders,
  PURCHASES_PERMISSION.sourcing,
] as const;

import { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Sales Orders module permissions.
 *
 * Only permissions for IMPLEMENTED features are registered here.
 * Do NOT add permissions for features that do not exist yet.
 *
 * super_admin bypasses the permission list entirely, so these keys
 * apply automatically to that role without explicit assignment.
 */
export const SALES_ORDERS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'sales_orders.view',
    group: 'Órdenes de venta',
    label: 'Ver órdenes de venta',
    description: 'Permite consultar el workspace de órdenes de venta y abrir el detalle',
  },
  {
    key: 'sales_orders.export',
    group: 'Órdenes de venta',
    label: 'Exportar órdenes de venta',
    description: 'Permite exportar órdenes a CSV o Excel',
  },
  {
    key: 'sales_orders.watch',
    group: 'Órdenes de venta',
    label: 'Seguir órdenes de venta',
    description: 'Permite marcar órdenes para recibir notificaciones cuando cambien',
  },
  {
    key: 'sales_orders.share_views',
    group: 'Órdenes de venta',
    label: 'Compartir vistas de órdenes',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
  {
    key: 'estimates.create',
    group: 'Cotizaciones',
    label: 'Crear cotizaciones',
    description: 'Permite al asistente IA crear cotizaciones (estimates) en Zoho Inventory',
  },
];

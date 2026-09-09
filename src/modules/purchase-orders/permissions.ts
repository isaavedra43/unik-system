import { PermissionDefinition } from '@/modules/auth/permissions';

export const PURCHASE_ORDERS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'purchase_orders.view',
    group: 'Órdenes de Compra',
    label: 'Ver órdenes de compra',
    description: 'Permite consultar el workspace de órdenes de compra y abrir el detalle',
  },
  {
    key: 'purchase_orders.export',
    group: 'Órdenes de Compra',
    label: 'Exportar órdenes de compra',
    description: 'Permite exportar órdenes de compra a CSV o Excel',
  },
  {
    key: 'purchase_orders.watch',
    group: 'Órdenes de Compra',
    label: 'Seguir órdenes de compra',
    description: 'Permite marcar órdenes de compra para recibir notificaciones cuando cambien',
  },
];

export const PURCHASE_ORDER_ENTITY_TYPE = 'purchase_order';

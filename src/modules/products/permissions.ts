import { PermissionDefinition } from '@/modules/auth/permissions';

export const PRODUCTS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'products.view',
    group: 'Productos',
    label: 'Ver productos',
    description: 'Permite consultar el workspace de productos y abrir el detalle',
  },
  {
    key: 'products.export',
    group: 'Productos',
    label: 'Exportar productos',
    description: 'Permite exportar productos a CSV o Excel',
  },
  {
    key: 'products.watch',
    group: 'Productos',
    label: 'Seguir productos',
    description: 'Permite marcar productos para recibir notificaciones cuando cambien',
  },
  {
    key: 'products.share_views',
    group: 'Productos',
    label: 'Compartir vistas de productos',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
];

export const PRODUCT_ENTITY_TYPE = 'product';

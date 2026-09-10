import { PermissionDefinition } from '@/modules/auth/permissions';

export const BILLS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'bills.view',
    group: 'Facturas de compra',
    label: 'Ver facturas de compra',
    description: 'Permite consultar el workspace de facturas de compra y abrir el detalle',
  },
  {
    key: 'bills.export',
    group: 'Facturas de compra',
    label: 'Exportar facturas de compra',
    description: 'Permite exportar facturas de compra a CSV o Excel',
  },
  {
    key: 'bills.watch',
    group: 'Facturas de compra',
    label: 'Seguir facturas de compra',
    description: 'Permite marcar facturas de compra para recibir notificaciones cuando cambien',
  },
  {
    key: 'bills.share_views',
    group: 'Facturas de compra',
    label: 'Compartir vistas de facturas de compra',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
];

export const BILL_ENTITY_TYPE = 'bill';

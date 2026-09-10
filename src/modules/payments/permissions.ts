import { PermissionDefinition } from '@/modules/auth/permissions';

export const PAYMENTS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'payments.view',
    group: 'Pagos',
    label: 'Ver pagos',
    description: 'Permite consultar el workspace de pagos recibidos y abrir el detalle',
  },
  {
    key: 'payments.export',
    group: 'Pagos',
    label: 'Exportar pagos',
    description: 'Permite exportar pagos a CSV o Excel',
  },
  {
    key: 'payments.watch',
    group: 'Pagos',
    label: 'Seguir pagos',
    description: 'Permite marcar pagos para recibir notificaciones cuando cambien',
  },
  {
    key: 'payments.share_views',
    group: 'Pagos',
    label: 'Compartir vistas de pagos',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
];

export const PAYMENT_ENTITY_TYPE = 'customer_payment';

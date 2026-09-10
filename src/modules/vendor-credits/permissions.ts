import { PermissionDefinition } from '@/modules/auth/permissions';

export const VENDOR_CREDITS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'vendor_credits.view',
    group: 'Créditos de Proveedor',
    label: 'Ver créditos de proveedor',
    description: 'Permite consultar el workspace de créditos de proveedor y abrir el detalle',
  },
  {
    key: 'vendor_credits.export',
    group: 'Créditos de Proveedor',
    label: 'Exportar créditos de proveedor',
    description: 'Permite exportar créditos de proveedor a CSV o Excel',
  },
  {
    key: 'vendor_credits.watch',
    group: 'Créditos de Proveedor',
    label: 'Seguir créditos de proveedor',
    description: 'Permite marcar créditos de proveedor para recibir notificaciones cuando cambien',
  },
  {
    key: 'vendor_credits.share_views',
    group: 'Créditos de Proveedor',
    label: 'Compartir vistas de créditos de proveedor',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
];

export const VENDOR_CREDIT_ENTITY_TYPE = 'vendor_credit';

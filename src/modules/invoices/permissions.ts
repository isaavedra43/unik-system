import { PermissionDefinition } from '@/modules/auth/permissions';

export const INVOICES_PERMISSIONS: PermissionDefinition[] = [
  { key: 'invoices.view', group: 'Facturas', label: 'Ver facturas', description: 'Permite consultar el workspace de facturas y abrir el detalle' },
  { key: 'invoices.export', group: 'Facturas', label: 'Exportar facturas', description: 'Permite exportar facturas a CSV o Excel' },
  { key: 'invoices.watch', group: 'Facturas', label: 'Seguir facturas', description: 'Permite marcar facturas para recibir notificaciones cuando cambien' },
  { key: 'invoices.share_views', group: 'Facturas', label: 'Compartir vistas de facturas', description: 'Permite compartir vistas guardadas con otros usuarios de UNIK' },
];

export const INVOICE_ENTITY_TYPE = 'invoice';

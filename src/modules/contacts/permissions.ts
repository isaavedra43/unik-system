import { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Contacts module permissions.
 * Shared by Customers and Vendors — the permission key includes the module
 * prefix so roles can grant access to one without the other if needed.
 */
export const CONTACTS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'customers.view',
    group: 'Clientes',
    label: 'Ver clientes',
    description: 'Permite consultar el workspace de clientes y abrir el detalle',
  },
  {
    key: 'customers.export',
    group: 'Clientes',
    label: 'Exportar clientes',
    description: 'Permite exportar clientes a CSV o Excel',
  },
  {
    key: 'customers.watch',
    group: 'Clientes',
    label: 'Seguir clientes',
    description: 'Permite marcar clientes para recibir notificaciones cuando cambien',
  },
  {
    key: 'customers.share_views',
    group: 'Clientes',
    label: 'Compartir vistas de clientes',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
  {
    key: 'vendors.view',
    group: 'Proveedores',
    label: 'Ver proveedores',
    description: 'Permite consultar el workspace de proveedores y abrir el detalle',
  },
  {
    key: 'vendors.export',
    group: 'Proveedores',
    label: 'Exportar proveedores',
    description: 'Permite exportar proveedores a CSV o Excel',
  },
  {
    key: 'vendors.watch',
    group: 'Proveedores',
    label: 'Seguir proveedores',
    description: 'Permite marcar proveedores para recibir notificaciones cuando cambien',
  },
  {
    key: 'vendors.share_views',
    group: 'Proveedores',
    label: 'Compartir vistas de proveedores',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
];

export const CONTACT_ENTITY_TYPE_CUSTOMER = 'contact_customer';
export const CONTACT_ENTITY_TYPE_VENDOR = 'contact_vendor';

import { PermissionDefinition } from '@/modules/auth/permissions';

export const BILLS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'bills.view',
    group: 'Bills',
    label: 'Ver bills',
    description: 'Permite consultar el workspace de bills (facturas de proveedores) y abrir el detalle',
  },
  {
    key: 'bills.export',
    group: 'Bills',
    label: 'Exportar bills',
    description: 'Permite exportar bills a CSV o Excel',
  },
  {
    key: 'bills.watch',
    group: 'Bills',
    label: 'Seguir bills',
    description: 'Permite marcar bills para recibir notificaciones cuando cambien',
  },
];

export const BILL_ENTITY_TYPE = 'bill';

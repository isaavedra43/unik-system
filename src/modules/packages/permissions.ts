import { PermissionDefinition } from '@/modules/auth/permissions';

export const PACKAGES_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'packages.view',
    group: 'Paquetes',
    label: 'Ver paquetes',
    description: 'Permite consultar el workspace de paquetes y abrir el detalle',
  },
  {
    key: 'packages.export',
    group: 'Paquetes',
    label: 'Exportar paquetes',
    description: 'Permite exportar paquetes a CSV o Excel',
  },
  {
    key: 'packages.watch',
    group: 'Paquetes',
    label: 'Seguir paquetes',
    description: 'Permite marcar paquetes para recibir notificaciones cuando cambien',
  },
  {
    key: 'packages.ship',
    group: 'Paquetes',
    label: 'Enviar paquetes y asignar transportista',
    description: 'Permite crear, editar y eliminar la orden de envío del paquete en Zoho, asignar transportista y marcarlo como entregado',
  },
  {
    key: 'packages.edit',
    group: 'Paquetes',
    label: 'Editar paquetes',
    description: 'Permite cambiar la fecha y las notas del paquete en Zoho',
  },
  {
    key: 'packages.share_views',
    group: 'Paquetes',
    label: 'Compartir vistas de paquetes',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
];

export const PACKAGE_ENTITY_TYPE = 'package';

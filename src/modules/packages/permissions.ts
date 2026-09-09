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
    key: 'packages.share_views',
    group: 'Paquetes',
    label: 'Compartir vistas de paquetes',
    description: 'Permite compartir vistas guardadas con otros usuarios de UNIK',
  },
];

export const PACKAGE_ENTITY_TYPE = 'package';

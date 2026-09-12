import { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Object storage (files) permissions.
 *
 * Access to a concrete file is NEVER granted by these keys: it always derives
 * from the owning resource (conversation, channel, document, call). These keys
 * only gate the administration surface (quotas, migration, backups, reports).
 */
export const FILES_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'files.admin',
    group: 'Archivos',
    label: 'Administrar almacenamiento',
    description:
      'Permite ver el estado del almacenamiento, ejecutar migraciones, respaldos, limpiezas y ajustar cuotas',
  },
];

import { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Integrations module permissions.
 *
 * These control access to the API monitoring and configuration panel at
 * /app/admin/integrations. super_admin bypasses the permission list entirely.
 */
export const INTEGRATIONS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'integrations.view',
    group: 'Integraciones',
    label: 'Ver integraciones',
    description:
      'Permite visualizar el panel de monitoreo de APIs, llamadas y estadísticas',
  },
  {
    key: 'integrations.manage',
    group: 'Integraciones',
    label: 'Configurar integraciones',
    description:
      'Permite modificar frecuencias, timeouts, límites y habilitar/deshabilitar integraciones',
  },
];

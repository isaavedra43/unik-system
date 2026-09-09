import { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Chat module permissions.
 *
 * Only permissions for IMPLEMENTED features are registered here.
 * super_admin bypasses the permission list entirely, so these keys
 * apply automatically to that role without explicit assignment.
 */
export const CHAT_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'chat.use',
    group: 'Chat',
    label: 'Usar el chat interno',
    description: 'Permite conversar con otros colaboradores, crear grupos y enviar mensajes',
  },
  {
    key: 'chat.admin',
    group: 'Chat',
    label: 'Administrar el chat',
    description: 'Permite moderar grupos, ver métricas y gestionar el chat interno',
  },
];

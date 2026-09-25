import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Virtual computer (venue) + browser automation. These gate the most powerful
 * capabilities in the system — every tool is enabledByDefault:false and
 * side-effecting actions still produce approval proposals.
 */
export const VENUE_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'browser.use',
    group: 'Agentes e Internet',
    label: 'Usar navegador del agente',
    description: 'Permite al asistente operar un navegador dentro de la computadora virtual (leer páginas; acciones externas requieren aprobación)',
  },
  {
    key: 'venue.exec',
    group: 'Agentes e Internet',
    label: 'Ejecutar comandos en venue',
    description: 'Permite al asistente correr comandos dentro del sandbox desechable (nunca en el servidor)',
  },
  {
    key: 'venue.files',
    group: 'Agentes e Internet',
    label: 'Archivos del venue',
    description: 'Permite al asistente leer y escribir archivos del workspace del sandbox',
  },
];

import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Operations core permissions (code-first registry, no migration).
 *
 * - `operations.view`: see cases, work items, requests, incidents and their
 *   realtime channels.
 * - `operations.manage`: operate the core (start tracking an order manually,
 *   reassign work, open incidents, answer area requests).
 * - `operations.admin`: configure the core (flags, cutover, SLAs, approval
 *   policies) and see the Control Tower. Also the fallback approver of every
 *   business approval scope.
 *
 * super_admin bypasses the list, so these keys apply to that role automatically.
 */
export const OPERATIONS_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'operations.view',
    group: 'Operaciones',
    label: 'Ver operaciones',
    description:
      'Permite consultar expedientes, trabajos, solicitudes entre áreas e incidencias en tiempo real',
  },
  {
    key: 'operations.manage',
    group: 'Operaciones',
    label: 'Gestionar operaciones',
    description:
      'Permite iniciar seguimiento de órdenes, reasignar trabajos, abrir incidencias y responder solicitudes',
  },
  {
    key: 'operations.admin',
    group: 'Operaciones',
    label: 'Administrar operaciones',
    description:
      'Permite configurar el núcleo operativo (flags, corte, SLA, políticas de aprobación) y ver la Torre de Control',
  },
];

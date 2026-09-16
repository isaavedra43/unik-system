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
 *   business approval scope, and — since the Control Tower's `excepciones`
 *   space is declared under this key (plan 7.7: "acciones reasignar/escalar/
 *   cerrar") — an operator of the core as well: see
 *   `OPERATIONS_OPERATOR_PERMISSIONS`.
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
      'Permite configurar el núcleo operativo (flags, corte, SLA, políticas de aprobación), ver la Torre de Control y actuar sobre sus excepciones',
  },
];

export const OPERATIONS_VIEW_PERMISSION = 'operations.view';
export const OPERATIONS_MANAGE_PERMISSION = 'operations.manage';
export const OPERATIONS_ADMIN_PERMISSION = 'operations.admin';

/**
 * QUIÉN OPERA EL NÚCLEO sin ser la persona responsable de la fila.
 *
 * El plan abre la Torre de Control con `operations.admin` (7.7) y su espacio
 * `excepciones` declara acciones — reasignar, escalar, cerrar — sobre trabajos,
 * incidencias y solicitudes. Mientras el motor sólo aceptó `operations.manage`,
 * quien administraba operaciones veía TODAS las excepciones y no podía tocar
 * ninguna; peor todavía, `work-actions.ts` (centro de trabajo del área y "Mi
 * trabajo") sí ofrecía los botones a un `operations.admin`, así que el motor
 * respondía 403 a un botón que la propia app acababa de pintar.
 *
 * Esta constante es la única definición de esa regla. Administrar sigue siendo
 * distinto de operar en todo lo demás (configuración, corte, SLA, políticas):
 * lo que abre es actuar sobre el trabajo, las incidencias y las solicitudes,
 * que es justo lo que la Torre ofrece. Un permiso `operations.*` nuevo NO entra
 * aquí sin pasar por el plan.
 */
export const OPERATIONS_OPERATOR_PERMISSIONS: readonly string[] = [
  OPERATIONS_MANAGE_PERMISSION,
  OPERATIONS_ADMIN_PERMISSION,
];

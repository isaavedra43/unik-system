import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Progressive inventory permissions (code-first registry, no migration).
 *
 * - `inventory.view`: stock by confidence level, movements, reservations,
 *   counts, locations and labels (read only).
 * - `inventory.count`: start physical counts, capture lines and close them.
 *   Closing only applies adjustments when the actor also has `inventory.adjust`;
 *   otherwise the differences stay pending with a work item.
 * - `inventory.adjust`: adjustments, approval of count differences, resolution
 *   of count disputes and blocking/unblocking stock.
 * - `inventory.reserve`: reserve and release stock for cases and record
 *   commitments made before the cutover (legacy claims).
 * - `inventory.manage`: physical movements (receipts, issues, returns,
 *   transfers, production), warehouses, locations, item profiles and
 *   container labels.
 *
 * super_admin bypasses the list, so these keys apply to that role automatically.
 */
export const INVENTORY_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'inventory.view',
    group: 'Inventario',
    label: 'Ver inventario',
    description:
      'Permite consultar existencias por nivel de confianza, movimientos, reservas, conteos y ubicaciones',
  },
  {
    key: 'inventory.count',
    group: 'Inventario',
    label: 'Contar inventario',
    description:
      'Permite iniciar conteos físicos, capturar líneas y cerrarlos (los ajustes requieren además el permiso de ajustar)',
  },
  {
    key: 'inventory.adjust',
    group: 'Inventario',
    label: 'Ajustar inventario',
    description:
      'Permite registrar ajustes, autorizar diferencias de conteo, resolver disputas y bloquear o desbloquear existencias',
  },
  {
    key: 'inventory.reserve',
    group: 'Inventario',
    label: 'Reservar inventario',
    description:
      'Permite reservar y liberar existencias para expedientes y registrar compromisos previos al corte',
  },
  {
    key: 'inventory.manage',
    group: 'Inventario',
    label: 'Gestionar inventario',
    description:
      'Permite registrar entradas, salidas y traspasos, y configurar bodegas, ubicaciones, perfiles de artículo y etiquetas',
  },
];

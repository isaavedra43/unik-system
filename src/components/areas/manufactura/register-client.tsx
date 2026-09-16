'use client';

import { registerAreaClient } from '@/components/areas/area-client-registry';
import { Badge } from '@/components/ui/primitives';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import { extraNumber, extraString } from '@/modules/areas/area-work-row';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import { ProductionBoard } from './ProductionBoard';

/**
 * Client side of the Manufactura area (plan 7.2): its specialized view (the
 * production board) and the few cells where the shared renderer would lose
 * information — the quantity without its unit, and a blocked order without the
 * reason that blocks it.
 *
 * Imported on demand by `src/components/areas/register-all-client.tsx`.
 */

function renderCell(row: AreaWorkRow, column: EntityColumnDefinition) {
  const isOrder = row.rowKind === 'production_order';
  const isOperation = row.rowKind === 'production_operation';
  if (!isOrder && !isOperation) return undefined;

  if (column.id === 'quantity' && row.quantity) {
    const unit = extraString(row.extra, 'plannedUnit');
    const quantity = Number(row.quantity);
    const value = Number.isFinite(quantity) ? quantity.toLocaleString('es-MX') : row.quantity;
    return unit ? `${value} ${unit}` : value;
  }

  if (column.id === 'status' && isOrder && row.status === 'blocked') {
    const reason = extraString(row.extra, 'blockedReason');
    return (
      <Badge variant="danger">
        <span title={reason ?? 'Bloqueada por falta de material'}>{row.statusLabel}</span>
      </Badge>
    );
  }

  if (column.id === 'title' && isOperation) {
    const minutes = extraNumber(row.extra, 'plannedMinutes');
    const center = extraString(row.extra, 'workCenter');
    return (
      <span className="area-row-title">
        <span className="area-row-title-main">{row.title}</span>
        <span className="area-row-sub">
          {[center, minutes !== null ? `${minutes} min planeados` : null, row.caseNumber]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    );
  }

  return undefined;
}

registerAreaClient('manufactura', {
  SpecialView: ProductionBoard,
  renderCell,
  rowKindLabels: {
    production_order: 'Orden de producción',
    production_operation: 'Operación',
  },
});

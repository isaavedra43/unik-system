'use client';

import {
  registerAreaClient,
  type AreaDetailExtrasProps,
} from '@/components/areas/area-client-registry';
import { Badge } from '@/components/ui/primitives';
import { extraString, type AreaWorkRow } from '@/modules/areas/area-work-row';
import { extraColumnId } from '@/modules/areas/work-columns';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import { CountDecisionsPanel } from './CountDecisionsPanel';
import { LegacyClaimPanel } from './LegacyClaimPanel';
import { LocationsMap } from './LocationsMap';
import { confidenceLabel, confidenceTone, formatQty } from './inventario-model';

/**
 * Client side of Inventario (plan 7.2): the map as its specialized view, the
 * labels of its own row kinds, the cells that only make sense here (the
 * confidence badge, the SKU in monospace and quantities with their unit) and
 * the management panels of its rows.
 *
 * `DetailExtras` is where the two decisions of plan §3.3 live, because neither
 * fits the generic row dialog: deciding the differences of a count (one
 * decision per line, with a confirmed quantity) and settling a legacy claim
 * (which picks a demand of a case).
 */

function InventoryDetailExtras({ rowKind, entityId, areaKey }: AreaDetailExtrasProps) {
  if (rowKind === 'stock_count') {
    return <CountDecisionsPanel areaKey={areaKey} countId={entityId} />;
  }
  if (rowKind === 'legacy_claim') {
    return <LegacyClaimPanel areaKey={areaKey} claimId={entityId} />;
  }
  return null;
}

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

const CONFIDENCE_COLUMN = extraColumnId('confidence');
const SKU_COLUMN = extraColumnId('sku');

registerAreaClient('inventario', {
  SpecialView: LocationsMap,
  DetailExtras: InventoryDetailExtras,
  rowKindLabels: {
    verification: 'Verificación',
    stock_count: 'Conteo',
    reservation: 'Reserva',
    movement: 'Movimiento',
    legacy_claim: 'Compromiso previo',
  },
  renderCell: (row: AreaWorkRow, column: EntityColumnDefinition) => {
    if (column.id === CONFIDENCE_COLUMN) {
      const value = extraString(row.extra, 'confidence');
      if (!value) return undefined;
      return <Badge variant={BADGE_BY_TONE[confidenceTone(value)]}>{confidenceLabel(value)}</Badge>;
    }
    if (column.id === SKU_COLUMN) {
      const sku = extraString(row.extra, 'sku');
      return sku ? <span className="inv-label-fallback">{sku}</span> : undefined;
    }
    if (column.id === 'quantity' && row.quantity !== null) {
      // Inventory quantities only read well next to their unit.
      const unit = extraString(row.extra, 'unit');
      if (row.rowKind === 'stock_count') {
        const lines = Number(row.quantity);
        return Number.isFinite(lines) ? `${lines} ${lines === 1 ? 'línea' : 'líneas'}` : undefined;
      }
      return formatQty(row.quantity, unit);
    }
    return undefined;
  },
});

export {};

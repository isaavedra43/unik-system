'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { registerAreaClient } from '@/components/areas/area-client-registry';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import { extraFieldKey } from '@/modules/areas/work-columns';
import { extraString, type AreaWorkRow } from '@/modules/areas/area-work-row';
import {
  formatDayLabel,
  tripHref,
  type DispatchDelivery,
} from '@/modules/areas/logistica/logistics-view-model';
import { DispatchBoard } from './DispatchBoard';
import { ZohoSyncPill } from './ZohoSyncPill';
import '@/styles/operations/logistica.css';

/**
 * Client side of Logística (plan 7.2): how its own rows are rendered in the work
 * centre and the specialized space (Despacho). Importing this file registers it;
 * `register-all-client.tsx` loads it on demand for this area only.
 */

/** The delivery fields the Zoho pill needs, read from the row's `extra`. */
function deliveryFromRow(
  row: AreaWorkRow
): Pick<DispatchDelivery, 'status' | 'zohoSyncState' | 'zohoError' | 'mode'> {
  return {
    status: row.status,
    zohoSyncState: extraString(row.extra, 'zohoSyncState') ?? 'not_required',
    zohoError: extraString(row.extra, 'zohoError'),
    mode: extraString(row.extra, 'mode') ?? '',
  };
}

function renderCell(row: AreaWorkRow, column: EntityColumnDefinition): ReactNode | undefined {
  // "Transportista": the carrier plus the state of the Zoho mirror, which is
  // what tells a dispatcher whether the shipment is really placed.
  if (extraFieldKey(column.field) === 'carrier') {
    const carrier = extraString(row.extra, 'carrier');
    const tripNumber = extraString(row.extra, 'tripNumber');
    const tripId = extraString(row.extra, 'tripId');
    if (row.rowKind === 'delivery_order') {
      return (
        <span className="area-row-title">
          <span className="area-row-title-main">{carrier ?? 'Sin transportista'}</span>
          <span className="area-row-sub">
            <ZohoSyncPill delivery={deliveryFromRow(row)} />
            {tripId && tripNumber ? (
              <Link href={tripHref(tripId)} onClick={(event) => event.stopPropagation()}>
                {tripNumber}
              </Link>
            ) : null}
          </span>
        </span>
      );
    }
    if (row.rowKind === 'trip') {
      const done = extraString(row.extra, 'stopsDone') ?? '0';
      const total = extraString(row.extra, 'stopsTotal') ?? '0';
      return (
        <span className="area-row-title">
          <span className="area-row-title-main">{carrier ?? 'Sin unidad'}</span>
          <span className="area-row-sub">
            {done} de {total} paradas entregadas
          </span>
        </span>
      );
    }
    return undefined;
  }

  if (extraFieldKey(column.field) === 'plannedDate' && row.rowKind !== 'work_item') {
    const planned = extraString(row.extra, 'plannedDate');
    return planned ? formatDayLabel(planned) : undefined;
  }

  // The title of a trip links to its page, where the stops are reordered.
  if (column.id === 'title' && row.rowKind === 'trip') {
    return (
      <span className="area-row-title">
        <Link
          className="area-row-title-main"
          href={tripHref(row.sourceId)}
          onClick={(event) => event.stopPropagation()}
        >
          {row.title}
        </Link>
        <span className="area-row-sub">
          {extraString(row.extra, 'driverName') ?? 'Sin chofer'}
          {extraString(row.extra, 'driverActive') === 'false' ? ' · chofer inactivo' : ''}
        </span>
      </span>
    );
  }

  return undefined;
}

registerAreaClient('logistica', {
  renderCell,
  SpecialView: DispatchBoard,
  rowKindLabels: {
    delivery_order: 'Entrega',
    trip: 'Viaje',
  },
});

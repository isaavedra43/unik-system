'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { registerAreaClient } from '@/components/areas/area-client-registry';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import { extraString } from '@/modules/areas/area-work-row';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import {
  opportunityHref,
  quoteHref,
  salesOrderHref,
  VENTAS_ROW_KINDS,
} from '@/modules/areas/ventas/ventas-constants';
import { RadarCierre } from './RadarCierre';

/**
 * Lado de cliente del área Ventas (plan 7.2): la vista especial (Radar de
 * cierre) y las celdas propias del centro de trabajo, donde el título de cada
 * fila lleva a su ficha real (oportunidad, cotización u orden de venta).
 */

function rowSubtitle(row: AreaWorkRow, extra: string | null): ReactNode {
  const parts = [extra, row.customerName].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? <span className="area-row-sub">{parts.join(' · ')}</span> : null;
}

function renderVentasCell(row: AreaWorkRow, column: EntityColumnDefinition): ReactNode | undefined {
  if (column.id !== 'title') return undefined;

  if (row.rowKind === VENTAS_ROW_KINDS.opportunity) {
    return (
      <span className="area-row-title">
        <Link
          className="area-row-title-main"
          href={opportunityHref(row.sourceId)}
          onClick={(event) => event.stopPropagation()}
        >
          {row.title}
        </Link>
        {rowSubtitle(row, extraString(row.extra, 'number'))}
      </span>
    );
  }

  if (row.rowKind === VENTAS_ROW_KINDS.quote) {
    return (
      <span className="area-row-title">
        <Link
          className="area-row-title-main"
          href={quoteHref(row.sourceId)}
          onClick={(event) => event.stopPropagation()}
        >
          {row.title}
        </Link>
        {rowSubtitle(row, extraString(row.extra, 'estimateNumber'))}
      </span>
    );
  }

  if (row.rowKind === VENTAS_ROW_KINDS.case) {
    const salesOrderId = extraString(row.extra, 'salesOrderId');
    return (
      <span className="area-row-title">
        {salesOrderId ? (
          <Link
            className="area-row-title-main"
            href={salesOrderHref(salesOrderId)}
            onClick={(event) => event.stopPropagation()}
          >
            {row.title}
          </Link>
        ) : (
          <span className="area-row-title-main">{row.title}</span>
        )}
        {rowSubtitle(row, row.caseNumber)}
      </span>
    );
  }

  return undefined;
}

registerAreaClient('ventas', {
  SpecialView: RadarCierre,
  renderCell: renderVentasCell,
});

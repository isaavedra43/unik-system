'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { registerAreaClient } from '@/components/areas/area-client-registry';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import { extraString } from '@/modules/areas/area-work-row';
import {
  CONTABILIDAD_AREA_KEY,
  CONTABILIDAD_ROW_KIND_LABELS,
  EXPENSE_ROW_KIND,
  OBLIGATION_ROW_KIND,
  PERIOD_CLOSE_ROW_KIND,
  contabilidadFocusHref,
  formatMoney,
} from '@/modules/areas/contabilidad/contabilidad-model';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import { CashBook } from './CashBook';

/**
 * Client side of Contabilidad (plan 7.2): the special view (Libro de caja) and
 * the cells of its own row kinds, where the title of a row leads to the place
 * where that row is actually attended and the amount is shown in the currency
 * of the record, not always in pesos.
 */

const OWN_ROW_KINDS = new Set([EXPENSE_ROW_KIND, OBLIGATION_ROW_KIND, PERIOD_CLOSE_ROW_KIND]);

function subtitle(row: AreaWorkRow): ReactNode {
  const parts = [
    extraString(row.extra, 'counterparty'),
    row.rowKind === PERIOD_CLOSE_ROW_KIND ? extraString(row.extra, 'periodKey') : null,
    row.caseNumber,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? <span className="area-row-sub">{parts.join(' · ')}</span> : null;
}

function renderContabilidadCell(
  row: AreaWorkRow,
  column: EntityColumnDefinition
): ReactNode | undefined {
  if (!OWN_ROW_KINDS.has(row.rowKind)) return undefined;

  if (column.id === 'title') {
    const href = contabilidadFocusHref(row.rowKind, row.sourceId);
    return (
      <span className="area-row-title">
        {href ? (
          <Link
            className="area-row-title-main"
            href={href}
            onClick={(event) => event.stopPropagation()}
          >
            {row.title}
          </Link>
        ) : (
          <span className="area-row-title-main">{row.title}</span>
        )}
        {subtitle(row)}
      </span>
    );
  }

  // Money of a row lives in its own currency (an obligation may not be in MXN).
  if (column.id === 'amount') {
    if (row.amount === null) return <span className="text-muted">—</span>;
    const currency = extraString(row.extra, 'currency') ?? 'MXN';
    return <span className="fin-num">{formatMoney(row.amount, currency)}</span>;
  }

  if (column.id === 'quantity' && row.rowKind === PERIOD_CLOSE_ROW_KIND) {
    const blockers = Number(row.quantity ?? 0);
    if (!Number.isFinite(blockers) || blockers <= 0) {
      return <span className="text-muted">Sin bloqueos</span>;
    }
    return (
      <span className="fin-negative">{blockers === 1 ? '1 bloqueo' : `${blockers} bloqueos`}</span>
    );
  }

  return undefined;
}

registerAreaClient(CONTABILIDAD_AREA_KEY, {
  SpecialView: CashBook,
  renderCell: renderContabilidadCell,
  rowKindLabels: CONTABILIDAD_ROW_KIND_LABELS,
});

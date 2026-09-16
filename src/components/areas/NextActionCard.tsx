'use client';

import '@/styles/operations/area-mobile.css';
import Link from 'next/link';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { formatDueLabel } from '@/components/operations/mywork-model';
import { rowKindLabel, type AreaWorkRow } from '@/modules/areas/area-work-row';
import { nextActionReasonLabel, type AreaNextAction } from '@/modules/areas/next-action';
import {
  getRowActions,
  noActionsReason,
  primaryRowAction,
  type AreaRowAction,
  type RowActionActor,
} from '@/modules/areas/work-actions';

/**
 * "Mi siguiente acción" of an area (plan 7.10): the one row this person should
 * attend now, why, its primary action and the way into its case.
 *
 * It decides nothing: `pickNextAction` chose the row, `getRowActions` decides
 * which command may be offered, and the engine validates it again.
 */

export interface NextActionCardProps {
  next: AreaNextAction | null;
  areaLabel: string;
  /** Server time of the render, so the due label matches on hydration. */
  now: Date;
  actor: RowActionActor;
  actPermissions: readonly string[];
  busy?: boolean;
  /** Case page link, or null while that page does not exist (`operationsCaseHref`). */
  caseHref?: string | null;
  onAction: (row: AreaWorkRow, action: AreaRowAction) => void;
  /** Opens the full detail of the row. */
  onOpen: (row: AreaWorkRow) => void;
}

const TITLE_ID = 'area-next-action-title';

export function NextActionCard({
  next,
  areaLabel,
  now,
  actor,
  actPermissions,
  busy = false,
  caseHref = null,
  onAction,
  onOpen,
}: NextActionCardProps) {
  if (!next) {
    return (
      <section className="area-next area-next-empty" aria-labelledby={TITLE_ID}>
        <p className="area-next-eyebrow">Mi siguiente acción</p>
        <h2 id={TITLE_ID} className="area-next-title">
          <CheckCircle2 size={16} aria-hidden="true" /> Estás al día
        </h2>
        <p className="area-next-reason">
          No tienes trabajo pendiente en {areaLabel}. Cuando te asignen algo aparecerá aquí.
        </p>
      </section>
    );
  }

  const { row, reason } = next;
  const actions = getRowActions(row, actor, { actPermissions: [...actPermissions] });
  const primary = primaryRowAction(actions);
  const due = row.dueAt ? formatDueLabel(row.dueAt, now, { closed: !row.open }) : null;
  const dueClass =
    due?.tone === 'danger' ? 'area-due-danger' : due?.tone === 'warning' ? 'area-due-warning' : '';

  return (
    <section className="area-next" aria-labelledby={TITLE_ID}>
      <div>
        <p className="area-next-eyebrow">Mi siguiente acción</p>
        <h2 id={TITLE_ID} className="area-next-title">
          {row.title}
        </h2>
      </div>

      <p className="area-next-reason">{nextActionReasonLabel(reason)}</p>

      <p className="area-next-meta">
        <span>{rowKindLabel(row.rowKind)}</span>
        <span>{row.statusLabel}</span>
        {due ? (
          <time dateTime={row.dueAt ?? undefined} title={due.title} className={dueClass}>
            {due.label}
          </time>
        ) : (
          <span>Sin fecha</span>
        )}
        {row.customerName ? <span>{row.customerName}</span> : null}
      </p>

      <div className="area-next-actions">
        {primary ? (
          <Button
            type="button"
            size="sm"
            variant={primary.tone === 'danger' ? 'danger' : 'primary'}
            isLoading={busy}
            onClick={() => onAction(row, primary)}
          >
            {primary.label}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(row)}>
          Ver detalle
          <ArrowRight size={14} aria-hidden="true" />
        </Button>
        {caseHref && row.caseNumber ? (
          <Link href={caseHref} className="btn btn-ghost btn-sm">
            Ver expediente {row.caseNumber}
          </Link>
        ) : null}
      </div>

      {!primary ? <p className="area-next-hint">{noActionsReason(row, actor)}</p> : null}
      {primary && caseHref === null && row.caseNumber ? (
        <p className="area-next-hint">Expediente {row.caseNumber}</p>
      ) : null}
    </section>
  );
}

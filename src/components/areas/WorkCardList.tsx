'use client';

import '@/styles/operations/area-mobile.css';
import { EmptyState } from '@/components/ui/composite';
import { Button } from '@/components/ui/primitives';
import { type AreaWorkRow } from '@/modules/areas/area-work-row';
import {
  getRowActions,
  primaryRowAction,
  type AreaRowAction,
  type RowActionActor,
} from '@/modules/areas/work-actions';
import { workCardSummary } from './area-mobile-model';

/**
 * Work rows as cards (plan 7.10): the phone version of the area table. Each
 * card carries the kind, the title, a status dot, the due date and the owner;
 * tapping it opens the full detail, and the primary action (when the engine
 * would accept one) is one tap away.
 */

export interface WorkCardListProps {
  rows: readonly AreaWorkRow[];
  /** Server time of the render, so due labels match on hydration. */
  now: Date;
  actor: RowActionActor;
  actPermissions: readonly string[];
  /** Row whose detail is open. */
  activeRowId?: string | null;
  /** Row waiting for its command. */
  busyRowId?: string | null;
  onOpen: (row: AreaWorkRow) => void;
  onAction: (row: AreaWorkRow, action: AreaRowAction) => void;
  emptyTitle?: string;
  emptyMessage?: string;
}

const DOT_CLASS = {
  default: 'area-card-dot',
  success: 'area-card-dot area-card-dot-success',
  danger: 'area-card-dot area-card-dot-danger',
  warning: 'area-card-dot area-card-dot-warning',
  info: 'area-card-dot area-card-dot-info',
  weak: 'area-card-dot area-card-dot-weak',
} as const;

export function WorkCardList({
  rows,
  now,
  actor,
  actPermissions,
  activeRowId = null,
  busyRowId = null,
  onOpen,
  onAction,
  emptyTitle = 'Nada que atender',
  emptyMessage = 'Cuando llegue trabajo a esta vista aparecerá aquí.',
}: WorkCardListProps) {
  if (rows.length === 0) {
    return <EmptyState icon="check" title={emptyTitle} message={emptyMessage} />;
  }

  return (
    <ul className="area-cards">
      {rows.map((row) => {
        const summary = workCardSummary(row, now);
        const actions = getRowActions(row, actor, { actPermissions: [...actPermissions] });
        const primary = primaryRowAction(actions);
        const dueClass =
          summary.due?.tone === 'danger'
            ? 'area-due-danger'
            : summary.due?.tone === 'warning'
              ? 'area-due-warning'
              : '';
        return (
          <li
            key={row.id}
            className={`area-card ${row.id === activeRowId ? 'area-card-active' : ''}`.trim()}
          >
            <button
              type="button"
              className="area-card-main"
              onClick={() => onOpen(row)}
              aria-label={`Abrir ${summary.kindLabel}: ${row.title}`}
            >
              <span className="area-card-head">
                <span className={DOT_CLASS[summary.tone]} aria-hidden="true" />
                <span className="area-card-kind">{summary.kindLabel}</span>
                <span className="area-card-status">{summary.statusLabel}</span>
              </span>
              <span className="area-card-title">{row.title}</span>
              <span className="area-card-meta">
                {summary.due ? (
                  <span className={dueClass} title={summary.due.title}>
                    {summary.due.label}
                  </span>
                ) : (
                  <span>Sin fecha</span>
                )}
                <span>{summary.ownerLabel}</span>
                {summary.context ? <span>{summary.context}</span> : null}
              </span>
            </button>
            {primary ? (
              <div className="area-card-actions">
                <Button
                  type="button"
                  size="sm"
                  variant={primary.tone === 'danger' ? 'danger' : 'primary'}
                  isLoading={busyRowId === row.id}
                  onClick={() => onAction(row, primary)}
                >
                  {primary.label}
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

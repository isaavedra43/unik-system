'use client';

import Link from 'next/link';
import { useDraggable } from '@dnd-kit/core';
import { GripVertical, Move, Play } from 'lucide-react';
import { Badge, Button } from '@/components/ui/primitives';
import { formatDueLabel } from '@/components/operations/mywork-model';
import {
  canMoveOrder,
  cardBadges,
  type BoardBadgeTone,
  type BoardCard as BoardCardData,
} from '@/modules/areas/manufactura/board-model';
import { productionOrderUrl } from '@/modules/manufacturing/manufacturing-types';

export interface BoardCardProps {
  card: BoardCardData;
  /** Server time of the render, so the due labels match on hydration. */
  now: Date;
  /** The person may run the commands of the area (the engine checks again). */
  canAct: boolean;
  /** Opens the keyboard alternative of the drag ("Mover a…"). */
  onMove: (card: BoardCardData) => void;
}

const BADGE_BY_TONE: Record<BoardBadgeTone, 'default' | 'success' | 'danger' | 'warning' | 'info'> =
  {
    danger: 'danger',
    warning: 'warning',
    info: 'info',
    success: 'success',
    default: 'default',
  };

/**
 * One production order on the board (plan 7.6). It can be dragged to another
 * work centre by its handle, and the same move is always available from the
 * keyboard through "Mover a…" — the drag is never the only way to do it.
 *
 * When the order cannot change centre (a BOM order, or one already prepared)
 * the card says WHY instead of silently refusing the drop.
 */
export function BoardCard({ card, now, canAct, onMove }: BoardCardProps) {
  const move = canMoveOrder(card);
  const draggable = canAct && move.ok;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    disabled: !draggable,
    data: { card },
  });

  const badges = cardBadges(card, now);
  const due = card.plannedEndAt ? formatDueLabel(card.plannedEndAt, now) : null;

  return (
    <li
      ref={setNodeRef}
      className={`mfg-card${draggable ? ' mfg-card-draggable' : ''}${isDragging ? ' mfg-card-dragging' : ''}`}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      aria-label={`${card.number}, ${card.statusLabel}`}
    >
      <div className="mfg-card-head">
        <div className="area-row-title">
          <span className="mfg-card-number">{card.number}</span>
          <span className="mfg-card-title" title={card.title}>
            {card.title}
          </span>
          <span className="mfg-card-meta">
            {card.plannedQty} {card.plannedUnit}
            {card.caseNumber ? ` · ${card.caseNumber}` : ''}
            {due ? ` · ${due.label}` : ''}
          </span>
        </div>
        {draggable ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Arrastrar ${card.number} a otro centro de trabajo`}
            title="Arrastrar a otro centro"
            {...listeners}
            {...attributes}
          >
            <GripVertical size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {badges.length > 0 ? (
        <div className="mfg-card-badges">
          {badges.map((badge) => (
            <Badge key={badge.id} variant={BADGE_BY_TONE[badge.tone]}>
              <span title={badge.title}>{badge.label}</span>
            </Badge>
          ))}
        </div>
      ) : null}

      {card.runningOperation ? (
        <p className="mfg-card-running">
          <Play size={14} aria-hidden="true" />
          {card.runningOperation.seq}. {card.runningOperation.name}
          {card.runningOperation.assignedUserName
            ? ` · ${card.runningOperation.assignedUserName}`
            : ''}
        </p>
      ) : card.pendingOperations > 0 ? (
        <p className="mfg-card-meta">
          {card.pendingOperations === 1
            ? '1 operación por hacer'
            : `${card.pendingOperations} operaciones por hacer`}
        </p>
      ) : null}

      <div className="mfg-card-actions">
        <Link className="btn btn-secondary btn-sm" href={productionOrderUrl(card.id)}>
          Abrir orden
        </Link>
        {canAct && move.ok ? (
          <Button variant="ghost" size="sm" onClick={() => onMove(card)}>
            <Move size={14} aria-hidden="true" />
            Mover a…
          </Button>
        ) : null}
        {canAct && !move.ok ? <span className="mfg-card-meta">{move.reason}</span> : null}
      </div>
    </li>
  );
}

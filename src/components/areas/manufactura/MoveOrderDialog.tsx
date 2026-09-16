'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Button, FormField, Select } from '@/components/ui/primitives';
import {
  canMoveOrder,
  describeMove,
  describeWindow,
  isRealMove,
  type BoardCard,
  type BoardCenter,
  type MoveTarget,
} from '@/modules/areas/manufactura/board-model';

export interface MoveOrderDialogProps {
  card: BoardCard;
  /** Every centre of the board; the "sin centro" column is not a destination. */
  centers: BoardCenter[];
  online: boolean;
  onClose: () => void;
  /** Sends `manufacturing.order.schedule`; true when it was accepted or queued. */
  onSubmit: (card: BoardCard, target: MoveTarget) => Promise<boolean>;
}

/**
 * Keyboard alternative to dragging a card (plan 7.6): choose the work centre
 * and, optionally, the shift it should start in. The engine re-plans the pending
 * operations of the order against the shifts of that centre, so leaving the
 * shift empty is the normal case — the planner decides.
 */
export function MoveOrderDialog({
  card,
  centers,
  online,
  onClose,
  onSubmit,
}: MoveOrderDialogProps) {
  const destinations = useMemo(
    () => centers.filter((center): center is BoardCenter & { id: string } => center.id !== null),
    [centers]
  );
  const [centerId, setCenterId] = useState(
    () => destinations.find((center) => center.id !== card.workCenterId)?.id ?? ''
  );
  const [windowStart, setWindowStart] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const move = canMoveOrder(card);
  const center = destinations.find((entry) => entry.id === centerId) ?? null;
  const windows = center?.windows ?? [];
  const selectedWindow = windows.find((entry) => entry.start === windowStart) ?? null;

  async function submit() {
    if (busy) return;
    setError(null);
    if (!center) {
      setError('Elige el centro de trabajo al que se mueve la orden.');
      return;
    }
    const target: MoveTarget = {
      workCenterId: center.id,
      ...(windowStart ? { plannedStartAt: windowStart } : {}),
    };
    if (!isRealMove(card, target)) {
      setError('La orden ya está en ese centro: elige otro o un turno distinto.');
      return;
    }
    setBusy(true);
    try {
      const done = await onSubmit(card, target);
      if (done) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo mover la orden');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mover {card.number}</DialogTitle>
          <DialogDescription>
            {card.title} · {card.plannedQty} {card.plannedUnit}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {!move.ok ? <Alert variant="warning">{move.reason}</Alert> : null}
          {!online ? (
            <Alert variant="info">
              Sin conexión: el movimiento se guarda en este dispositivo y se envía solo al volver.
            </Alert>
          ) : null}

          {destinations.length === 0 ? (
            <Alert variant="warning">
              No hay centros de trabajo activos a los que mover la orden.
            </Alert>
          ) : (
            <>
              <FormField
                label="Centro de trabajo"
                htmlFor="mfg-move-center"
                help="La orden se reprograma contra los turnos de ese centro."
              >
                <Select
                  id="mfg-move-center"
                  value={centerId}
                  onChange={(event) => {
                    setCenterId(event.target.value);
                    setWindowStart('');
                  }}
                  disabled={busy || !move.ok}
                >
                  <option value="">Elige un centro…</option>
                  {destinations.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.id === card.workCenterId ? ' (actual)' : ''}
                    </option>
                  ))}
                </Select>
              </FormField>

              <FormField
                label="Turno (opcional)"
                htmlFor="mfg-move-window"
                help="Si lo dejas vacío, el planeador busca el primer turno con espacio."
              >
                <Select
                  id="mfg-move-window"
                  value={windowStart}
                  onChange={(event) => setWindowStart(event.target.value)}
                  disabled={busy || !move.ok || windows.length === 0}
                >
                  <option value="">Que decida el planeador</option>
                  {windows.map((entry) => (
                    <option
                      key={`${entry.day}-${entry.shiftName}-${entry.start}`}
                      value={entry.start}
                    >
                      {describeWindow(entry)}
                    </option>
                  ))}
                </Select>
              </FormField>

              {center ? (
                <p className="mfg-section-hint">
                  {describeMove(card, center.name, selectedWindow)}.
                  {selectedWindow?.overloaded
                    ? ' Ese turno ya está sobrecargado: se avisará al responsable del centro.'
                    : ''}
                </p>
              ) : null}
            </>
          )}

          {error ? <Alert variant="error">{error}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={busy || !move.ok || destinations.length === 0}
          >
            {busy ? 'Moviendo…' : 'Mover orden'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

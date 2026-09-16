'use client';

import { useState } from 'react';
import {
  cancelOrderAction,
  finishOperationAction,
  pauseOperationAction,
  prepareOrderAction,
  reserveMaterialsAction,
  scheduleOrderAction,
  startOperationAction,
} from '@/app/app/manufacturing/actions';
import {
  Alert,
  Badge,
  Button,
  FormField,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import type {
  ProductionOperationDTO,
  WorkCenterDTO,
} from '@/modules/manufacturing/manufacturing-dto';
import type { ProductionOrderRow } from '@/modules/manufacturing/manufacturing-queries';
import type { ProductionOrderAction } from '@/modules/manufacturing/production-state';
import { useOrderAction } from './use-order-action';

export interface OrderPlanPanelProps {
  order: ProductionOrderRow;
  operations: ProductionOperationDTO[];
  /** Active work centres, for scheduling. */
  centers: Array<Pick<WorkCenterDTO, 'id' | 'name' | 'capacityUnitLabel'>>;
  /** Operator names already resolved on the server. */
  operatorNames: Record<string, string>;
}

const OPERATION_BADGE = {
  pending: 'default',
  running: 'info',
  paused: 'warning',
  done: 'success',
  skipped: 'weak',
} as const;

function can(order: ProductionOrderRow, action: ProductionOrderAction): boolean {
  return order.allowedActions.includes(action);
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Plan and floor of a production order: schedule it, commit its material,
 * prepare it, and start / pause / finish its operations.
 *
 * Every button matches an action the engine already said this person may run
 * (`allowedActions` = state machine ∩ permissions), and the command validates
 * it again.
 */
export function OrderPlanPanel({ order, operations, centers, operatorNames }: OrderPlanPanelProps) {
  const { runAction, pending, error } = useOrderAction();
  const [workCenterId, setWorkCenterId] = useState(order.workCenterId ?? '');
  const [plannedStartAt, setPlannedStartAt] = useState(toLocalInput(order.plannedStartAt));
  const [allowProvisional, setAllowProvisional] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState('');
  const [pauseFor, setPauseFor] = useState<string | null>(null);
  const [finishFor, setFinishFor] = useState<string | null>(null);
  const [finishMinutes, setFinishMinutes] = useState('');
  const [finishNote, setFinishNote] = useState('');

  const schedulable = can(order, 'schedule');
  const bomOrder = order.kind === 'bom';

  return (
    <section className="mfg-section" aria-labelledby="mfg-plan">
      <h2 id="mfg-plan" className="mfg-section-title">
        Plan y piso
        <span className="mfg-section-hint">
          {order.workCenterName ? `Centro actual: ${order.workCenterName}` : 'Sin centro asignado'}
        </span>
      </h2>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {order.blockedReason ? (
        <Alert variant="warning" title="Orden bloqueada">
          {order.blockedReason}
        </Alert>
      ) : null}

      {schedulable ? (
        <div className="mfg-inline-form">
          <FormField
            label="Centro de trabajo"
            htmlFor="mfg-plan-center"
            help={
              bomOrder
                ? 'En una orden con lista de materiales el centro se define en cada operación.'
                : 'Al programar se recalcula la carga de los turnos.'
            }
          >
            <Select
              id="mfg-plan-center"
              value={workCenterId}
              disabled={pending || bomOrder}
              onChange={(event) => setWorkCenterId(event.target.value)}
            >
              <option value="">Sin cambio</option>
              {centers.map((center) => (
                <option key={center.id} value={center.id}>
                  {center.name}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Inicia" htmlFor="mfg-plan-start" help="Vacío = lo decide el planeador.">
            <Input
              id="mfg-plan-start"
              type="datetime-local"
              value={plannedStartAt}
              disabled={pending}
              onChange={(event) => setPlannedStartAt(event.target.value)}
            />
          </FormField>

          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              void runAction(() =>
                scheduleOrderAction({
                  productionOrderId: order.id,
                  ...(workCenterId && workCenterId !== order.workCenterId ? { workCenterId } : {}),
                  ...(plannedStartAt
                    ? { plannedStartAt: new Date(plannedStartAt).toISOString() }
                    : {}),
                })
              )
            }
          >
            Programar
          </Button>
        </div>
      ) : null}

      <div className="mfg-card-actions">
        {can(order, 'reserve_materials') ? (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={pending}
              onClick={() =>
                void runAction(() =>
                  reserveMaterialsAction({
                    productionOrderId: order.id,
                    ...(allowProvisional ? { allowProvisional: true } : {}),
                  })
                )
              }
            >
              Reservar materiales
            </Button>
            <label className="mfg-day-toggle">
              <input
                type="checkbox"
                checked={allowProvisional}
                disabled={pending}
                onChange={(event) => setAllowProvisional(event.target.checked)}
              />
              Aceptar existencias provisionales
            </label>
          </>
        ) : null}

        {can(order, 'prepare') ? (
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() =>
              void runAction(() => prepareOrderAction({ productionOrderId: order.id }))
            }
          >
            Preparar material
          </Button>
        ) : null}

        {can(order, 'cancel') ? (
          <Button
            variant="danger"
            size="sm"
            disabled={pending}
            onClick={() => setCancelOpen((open) => !open)}
          >
            Cancelar orden
          </Button>
        ) : null}
      </div>

      {cancelOpen ? (
        <div className="mfg-inline-form">
          <FormField
            label="Motivo de la cancelación"
            htmlFor="mfg-cancel-reason"
            help="Se libera el material reservado y queda en la cronología del expediente."
          >
            <Textarea
              id="mfg-cancel-reason"
              rows={2}
              maxLength={500}
              value={cancelReason}
              disabled={pending}
              onChange={(event) => setCancelReason(event.target.value)}
            />
          </FormField>
          <Button
            variant="danger"
            size="sm"
            disabled={pending || cancelReason.trim().length === 0}
            onClick={() =>
              void runAction(
                () =>
                  cancelOrderAction({
                    productionOrderId: order.id,
                    reason: cancelReason.trim(),
                  }),
                { onDone: () => setCancelOpen(false) }
              )
            }
          >
            Confirmar cancelación
          </Button>
        </div>
      ) : null}

      <h3 className="mfg-section-title">Operaciones</h3>
      {operations.length === 0 ? (
        <p className="mfg-section-hint">
          La orden todavía no tiene operaciones: al programarla se crea la primera en su centro de
          trabajo.
        </p>
      ) : (
        <div className="mfg-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Operación</th>
                <th scope="col">Estado</th>
                <th scope="col">Minutos</th>
                <th scope="col">Responsable</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((operation) => (
                <tr key={operation.id}>
                  <td>{operation.seq}</td>
                  <td>{operation.name}</td>
                  <td>
                    <Badge
                      variant={
                        OPERATION_BADGE[operation.status as keyof typeof OPERATION_BADGE] ??
                        'default'
                      }
                    >
                      {operation.statusLabel}
                    </Badge>
                  </td>
                  <td>
                    {operation.actualMinutes ?? operation.plannedMinutes ?? '—'}
                    {operation.actualMinutes !== null ? ' reales' : ' planeados'}
                  </td>
                  <td>
                    {operation.assignedUserId
                      ? (operatorNames[operation.assignedUserId] ?? 'Asignada')
                      : '—'}
                  </td>
                  <td>
                    <span className="mfg-card-actions">
                      {can(order, 'start_operation') &&
                      (operation.status === 'pending' || operation.status === 'paused') ? (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            void runAction(() =>
                              startOperationAction({
                                productionOrderId: order.id,
                                operationId: operation.id,
                              })
                            )
                          }
                        >
                          Iniciar
                        </Button>
                      ) : null}
                      {can(order, 'pause_operation') && operation.status === 'running' ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={pending}
                          onClick={() => setPauseFor(operation.id)}
                        >
                          Pausar
                        </Button>
                      ) : null}
                      {can(order, 'finish_operation') &&
                      (operation.status === 'running' || operation.status === 'paused') ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={pending}
                          onClick={() => setFinishFor(operation.id)}
                        >
                          Terminar
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pauseFor ? (
        <div className="mfg-inline-form">
          <FormField
            label="Motivo de la pausa"
            htmlFor="mfg-pause-reason"
            help="Queda registrado en la orden (opcional, hasta 500 caracteres)."
          >
            <Input
              id="mfg-pause-reason"
              value={pauseReason}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setPauseReason(event.target.value)}
            />
          </FormField>
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() =>
              void runAction(
                () =>
                  pauseOperationAction({
                    productionOrderId: order.id,
                    operationId: pauseFor,
                    ...(pauseReason.trim() ? { reason: pauseReason.trim() } : {}),
                  }),
                {
                  onDone: () => {
                    setPauseFor(null);
                    setPauseReason('');
                  },
                }
              )
            }
          >
            Pausar operación
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setPauseFor(null)}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {finishFor ? (
        <div className="mfg-inline-form">
          <FormField
            label="Minutos reales"
            htmlFor="mfg-finish-minutes"
            help="Vacío = los minutos que midió el sistema."
          >
            <Input
              id="mfg-finish-minutes"
              type="number"
              min={0}
              max={100000}
              value={finishMinutes}
              disabled={pending}
              onChange={(event) => setFinishMinutes(event.target.value)}
            />
          </FormField>
          <FormField label="Nota" htmlFor="mfg-finish-note">
            <Input
              id="mfg-finish-note"
              value={finishNote}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setFinishNote(event.target.value)}
            />
          </FormField>
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() =>
              void runAction(
                () =>
                  finishOperationAction({
                    productionOrderId: order.id,
                    operationId: finishFor,
                    ...(finishMinutes.trim() && Number.isFinite(Number(finishMinutes))
                      ? { actualMinutes: Number(finishMinutes) }
                      : {}),
                    ...(finishNote.trim() ? { note: finishNote.trim() } : {}),
                  }),
                {
                  onDone: () => {
                    setFinishFor(null);
                    setFinishMinutes('');
                    setFinishNote('');
                  },
                }
              )
            }
          >
            Terminar operación
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setFinishFor(null)}>
            Cancelar
          </Button>
        </div>
      ) : null}
    </section>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import {
  Alert,
  Badge,
  Button,
  FormField,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { purchasesBoardTouches } from '@/modules/areas/compras/compras-model';
import {
  DIFFERENCE_KIND_OPTIONS,
  DIFFERENCE_RESOLUTION_LABELS,
  acceptedQty,
  differenceFormToPayload,
  differenceKindLabel,
  emptyReceiptForm,
  receiptFormIsPristine,
  receiptFormToPayload,
  type DifferenceForm,
  type ReceiptLineForm,
  type ReceiptOrderLine,
} from '@/modules/areas/compras/detail-model';
import {
  DIFFERENCE_RESOLUTIONS,
  PURCHASES_BOARD_CHANNEL,
  PURCHASES_REALTIME_TYPE,
} from '@/modules/purchases/purchases-types';
import { recordGoodsReceiptAction, resolveReceiptDifferenceAction } from './compras-actions';

/**
 * Capture panel of a procurement order (plan 6.1): what ARRIVED, line by line,
 * with the quantity accepted and the quantity rejected, and the settlement of
 * the differences that stayed open.
 *
 * This is the one flow the shared row dialog can never collect — it is a table
 * of numbers, not a note — and it was the missing half of Compras: `postReceipt`
 * with quantities and `resolve_difference` had no caller outside the AI tools,
 * and the read-only route `/api/compras/orders/[orderId]` had no consumer.
 *
 * Only material that is POSTED moves the inventory, so the panel is explicit
 * about it: a draft is saved without giving entry to the warehouse and the
 * receipt row posts it later.
 */

interface ReceiptLineView {
  id: string;
  orderLineId: string;
  qtyReceived: string;
  qtyAccepted: string;
  qtyRejected: string;
  differenceKind: string;
  incidentId: string | null;
}

interface ReceiptView {
  id: string;
  number: string;
  status: string;
  receivedAt: string | null;
  lines: ReceiptLineView[];
}

interface OrderView {
  id: string;
  number: string;
  status: string;
  statusLabel: string;
  currency: string;
  lines: Array<ReceiptOrderLine & { unit: string; qtyAccepted: string }>;
  receipts: ReceiptView[];
}

export interface ReceiptCapturePanelProps {
  areaKey: string;
  orderId: string;
  canAct: boolean;
}

const RECEIVABLE_ORDER_STATUSES = [
  'approved',
  'pending_payment',
  'awaiting_receipt',
  'partially_received',
  'disputed',
];

const EMPTY_DIFFERENCE: DifferenceForm = {
  receiptLineId: '',
  resolution: '',
  note: '',
  creditQty: '',
};

export function ReceiptCapturePanel({ areaKey, orderId, canAct }: ReceiptCapturePanelProps) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [lines, setLines] = useState<ReceiptLineForm[]>([]);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [difference, setDifference] = useState<DifferenceForm>(EMPTY_DIFFERENCE);
  const [remoteChange, setRemoteChange] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/compras/orders/${encodeURIComponent(orderId)}`,
        { headers: { accept: 'application/json' } }
      );
      if (!response.ok) throw new Error('order_fetch_failed');
      const body = (await response.json()) as { order: OrderView };
      setOrder(body.order);
      setLines(emptyReceiptForm(body.order.lines));
      setRemoteChange(false);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [areaKey, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * `purchases:board` (plan 6.6): the 35 commands of Compras publish there.
   * The panel only listens to what touches ITS order and, when the capture is
   * still untouched, refreshes by itself; if somebody is typing, it offers the
   * refresh instead of throwing the capture away.
   */
  useOperationsRealtime(
    [PURCHASES_BOARD_CHANNEL],
    [PURCHASES_REALTIME_TYPE],
    useCallback(
      (_type, data) => {
        if (!purchasesBoardTouches(data, { orderId })) return;
        setRemoteChange(true);
      },
      [orderId]
    )
  );

  const pristine = receiptFormIsPristine(lines, notes) && difference.receiptLineId === '';

  useEffect(() => {
    if (!remoteChange || !pristine || pending) return;
    void load();
  }, [remoteChange, pristine, pending, load]);

  /** Receipt lines that opened a difference and nobody has settled yet. */
  const openDifferences = useMemo(() => {
    if (!order) return [];
    return order.receipts.flatMap((receipt) =>
      receipt.lines
        .filter((line) => line.differenceKind !== 'none' && line.incidentId)
        .map((line) => ({ receipt, line }))
    );
  }, [order]);

  const canReceive = Boolean(order && RECEIVABLE_ORDER_STATUSES.includes(order.status));

  function setLine(orderLineId: string, patch: Partial<ReceiptLineForm>) {
    setLines((current) =>
      current.map((line) => (line.orderLineId === orderLineId ? { ...line, ...patch } : line))
    );
  }

  function submit(post: boolean) {
    if (!order) return;
    const built = receiptFormToPayload({
      orderId: order.id,
      orderLines: order.lines,
      lines,
      post,
      notes,
    });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    startTransition(async () => {
      const result = await recordGoodsReceiptAction(built.payload);
      if (!result.ok) {
        toast.error(result.error);
        setErrors([result.error]);
        return;
      }
      toast.success(
        result.data.posted
          ? `Recepción ${result.data.number} registrada: el material ya está en el almacén`
          : `Recepción ${result.data.number} guardada como borrador`
      );
      setNotes('');
      await load();
    });
  }

  function settleDifference() {
    if (!order) return;
    const built = differenceFormToPayload(difference);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    startTransition(async () => {
      const result = await resolveReceiptDifferenceAction({ orderId: order.id, ...built.payload });
      if (!result.ok) {
        toast.error(result.error);
        setErrors([result.error]);
        return;
      }
      toast.success('Diferencia resuelta');
      setDifference(EMPTY_DIFFERENCE);
      await load();
    });
  }

  if (state === 'loading') {
    return <LoadingState variant="list" rows={3} label="Cargando las partidas de la orden…" />;
  }
  if (state === 'failed' || !order) {
    return (
      <ErrorState
        title="No pudimos abrir las partidas de la orden"
        message="Recarga la página; si el problema sigue, avisa a Administración."
      />
    );
  }

  const byId = new Map(order.lines.map((line) => [line.id, line]));

  return (
    <section className="area-drawer-section" aria-labelledby="order-receipts">
      <h3 id="order-receipts" className="area-drawer-section-title">
        Recepción del material
      </h3>

      {remoteChange && !pristine ? (
        <Alert variant="info" title="Esta orden cambió mientras capturabas">
          <p>
            Alguien registró un movimiento de esta orden de compra. Tu captura sigue aquí; al
            actualizar se pierde lo que escribiste.
          </p>
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={pending}>
            Actualizar la orden
          </Button>
        </Alert>
      ) : null}

      {errors.length > 0 ? (
        <Alert variant="error" title="Revisa la captura">
          <ul>
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {!canAct ? (
        <p className="area-row-sub">
          Puedes consultar lo que ya llegó; capturar una recepción lo hace quien recibe material.
        </p>
      ) : !canReceive ? (
        <Alert variant="info">
          Esta orden está {order.statusLabel.toLowerCase()}: no se puede capturar material hasta que
          el proveedor tenga la orden.
        </Alert>
      ) : (
        <>
          <div className="compras-receipt-table" role="table" aria-label="Captura de la recepción">
            <div className="compras-receipt-row compras-receipt-head" role="row">
              <span role="columnheader">Partida</span>
              <span role="columnheader">Falta</span>
              <span role="columnheader">Llegó</span>
              <span role="columnheader">Rechazado</span>
              <span role="columnheader">Se acepta</span>
              <span role="columnheader">Diferencia</span>
              <span role="columnheader">Lote</span>
            </div>
            {lines.map((line) => {
              const orderLine = byId.get(line.orderLineId);
              return (
                <div className="compras-receipt-row" role="row" key={line.orderLineId}>
                  <span role="cell">
                    {orderLine?.description ?? line.orderLineId}
                    <span className="area-row-sub">{orderLine?.unit ?? ''}</span>
                  </span>
                  <span role="cell">{orderLine?.qtyPending ?? '—'}</span>
                  <span role="cell">
                    <Input
                      inputMode="decimal"
                      aria-label={`Cantidad recibida de ${orderLine?.description ?? ''}`}
                      value={line.received}
                      onChange={(event) =>
                        setLine(line.orderLineId, { received: event.target.value })
                      }
                    />
                  </span>
                  <span role="cell">
                    <Input
                      inputMode="decimal"
                      aria-label={`Cantidad rechazada de ${orderLine?.description ?? ''}`}
                      value={line.rejected}
                      onChange={(event) =>
                        setLine(line.orderLineId, { rejected: event.target.value })
                      }
                    />
                  </span>
                  <span role="cell">{acceptedQty(line)}</span>
                  <span role="cell">
                    <Select
                      aria-label={`Diferencia de ${orderLine?.description ?? ''}`}
                      value={line.differenceKind}
                      onChange={(event) =>
                        setLine(line.orderLineId, {
                          differenceKind: event.target.value as ReceiptLineForm['differenceKind'],
                        })
                      }
                    >
                      <option value="">La que muestren las cantidades</option>
                      {DIFFERENCE_KIND_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </span>
                  <span role="cell">
                    <Input
                      aria-label={`Lote de ${orderLine?.description ?? ''}`}
                      value={line.lotCode}
                      onChange={(event) =>
                        setLine(line.orderLineId, { lotCode: event.target.value })
                      }
                    />
                  </span>
                </div>
              );
            })}
          </div>

          <FormField
            label="Nota de la recepción"
            htmlFor="receipt-notes"
            help="Lo que hay que saber de cómo llegó: queda en la orden y en el expediente."
          >
            <Textarea
              id="receipt-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </FormField>

          <div className="area-drawer-actions">
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => submit(false)}>
              Guardar como borrador
            </Button>
            <Button size="sm" disabled={pending} onClick={() => submit(true)}>
              {pending ? 'Registrando…' : 'Registrar y dar entrada'}
            </Button>
          </div>
        </>
      )}

      {openDifferences.length > 0 ? (
        <>
          <h4 className="area-drawer-section-title">Diferencias por resolver</h4>
          <ul className="compras-difference-list">
            {openDifferences.map(({ receipt, line }) => {
              const orderLine = byId.get(line.orderLineId);
              const selected = difference.receiptLineId === line.id;
              return (
                <li key={line.id} className="compras-difference">
                  <div className="compras-response-head">
                    <strong>{orderLine?.description ?? line.orderLineId}</strong>
                    <Badge variant="warning">{differenceKindLabel(line.differenceKind)}</Badge>
                    <span className="area-row-sub">
                      {receipt.number} · llegó {line.qtyReceived}, se aceptó {line.qtyAccepted}
                      {Number(line.qtyRejected) > 0 ? `, se rechazó ${line.qtyRejected}` : ''}
                    </span>
                  </div>
                  {canAct ? (
                    selected ? (
                      <div className="compras-response-form">
                        <FormField label="Cómo se resuelve" htmlFor={`res-${line.id}`}>
                          <Select
                            id={`res-${line.id}`}
                            value={difference.resolution}
                            onChange={(event) =>
                              setDifference((form) => ({
                                ...form,
                                resolution: event.target.value as DifferenceForm['resolution'],
                              }))
                            }
                          >
                            <option value="">Elige una salida</option>
                            {DIFFERENCE_RESOLUTIONS.map((resolution) => (
                              <option key={resolution} value={resolution}>
                                {DIFFERENCE_RESOLUTION_LABELS[resolution]}
                              </option>
                            ))}
                          </Select>
                        </FormField>
                        {difference.resolution === 'credit' ? (
                          <FormField
                            label="Cantidad que se abona"
                            htmlFor={`credit-${line.id}`}
                            help="Vacío = todo lo que sigue pendiente de esa partida."
                          >
                            <Input
                              id={`credit-${line.id}`}
                              inputMode="decimal"
                              value={difference.creditQty}
                              onChange={(event) =>
                                setDifference((form) => ({
                                  ...form,
                                  creditQty: event.target.value,
                                }))
                              }
                            />
                          </FormField>
                        ) : null}
                        <FormField label="Qué pasó" htmlFor={`note-${line.id}`}>
                          <Textarea
                            id={`note-${line.id}`}
                            rows={2}
                            value={difference.note}
                            onChange={(event) =>
                              setDifference((form) => ({ ...form, note: event.target.value }))
                            }
                          />
                        </FormField>
                        <div className="area-drawer-actions">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={pending}
                            onClick={() => setDifference(EMPTY_DIFFERENCE)}
                          >
                            Cancelar
                          </Button>
                          <Button size="sm" disabled={pending} onClick={settleDifference}>
                            Resolver la diferencia
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="area-drawer-actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={pending}
                          onClick={() =>
                            setDifference({ ...EMPTY_DIFFERENCE, receiptLineId: line.id })
                          }
                        >
                          Resolver
                        </Button>
                      </div>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}

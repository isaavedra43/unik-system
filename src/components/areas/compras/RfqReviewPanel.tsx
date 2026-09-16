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
  orderedComparison,
  responseActions,
  rfqReviewIsPristine,
  selectResponseFormToPayload,
  type ComparisonEntry,
  type SelectResponseForm,
} from '@/modules/areas/compras/detail-model';
import {
  PURCHASES_BOARD_CHANNEL,
  PURCHASES_REALTIME_TYPE,
} from '@/modules/purchases/purchases-types';
import {
  confirmRfqResponseAction,
  rejectRfqResponseAction,
  selectRfqResponseAction,
} from './compras-actions';

/**
 * Review panel of an RFQ (plan 6.1): the responses the suppliers sent, the
 * comparison WITH ITS SCORE (landed cost, lead time, risk and spec match) and,
 * on each one, the three decisions a person makes — confirm what we understood,
 * discard it, or pick it and create the order.
 *
 * Before this panel `confirmResponse`, `rejectResponse` and `selectResponse`
 * had no caller outside the AI tools, and the read-only route that computes the
 * comparison (`/api/compras/rfqs/[rfqId]`) had no consumer at all.
 *
 * Nothing is decided here: every button ends in a command that re-checks
 * `purchases.manage_orders`, the state of the RFQ and the optimistic version.
 */

interface RfqResponseView {
  id: string;
  name: string | null;
  status: string;
  statusLabel: string;
  landedTotal: string | null;
  currency: string;
  leadTimeDays: number | null;
  reviewReasons: string[];
}

interface RfqView {
  id: string;
  number: string;
  status: string;
  statusLabel: string;
  responses: RfqResponseView[];
  comparison: ComparisonEntry[];
}

export interface RfqReviewPanelProps {
  areaKey: string;
  rfqId: string;
  canAct: boolean;
}

function money(amount: string | number | null, currency: string): string {
  if (amount === null || amount === '') return '—';
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

const EMPTY_SELECTION: SelectResponseForm = {
  responseId: '',
  deliveryMode: '',
  warehouseId: '',
  directDeliveryCaseId: '',
  expectedAt: '',
  notes: '',
};

export function RfqReviewPanel({ areaKey, rfqId, canAct }: RfqReviewPanelProps) {
  const [rfq, setRfq] = useState<RfqView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [errors, setErrors] = useState<string[]>([]);
  const [rejecting, setRejecting] = useState<{ responseId: string; reason: string } | null>(null);
  const [selection, setSelection] = useState<SelectResponseForm>(EMPTY_SELECTION);
  const [remoteChange, setRemoteChange] = useState(false);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/compras/rfqs/${encodeURIComponent(rfqId)}`,
        { headers: { accept: 'application/json' } }
      );
      if (!response.ok) throw new Error('rfq_fetch_failed');
      const body = (await response.json()) as { rfq: RfqView };
      setRfq(body.rfq);
      setRemoteChange(false);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [areaKey, rfqId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A supplier answering, a response being confirmed or somebody else picking
   * one all publish on `purchases:board` (plan 6.6). The panel reloads when
   * nothing is half-written and otherwise offers the refresh, so a comparison
   * is never read out of date and a started selection is never lost.
   */
  useOperationsRealtime(
    [PURCHASES_BOARD_CHANNEL],
    [PURCHASES_REALTIME_TYPE],
    useCallback(
      (_type, data) => {
        if (!purchasesBoardTouches(data, { rfqId })) return;
        setRemoteChange(true);
      },
      [rfqId]
    )
  );

  const pristine = rfqReviewIsPristine(selection, rejecting);

  useEffect(() => {
    if (!remoteChange || !pristine || pending) return;
    void load();
  }, [remoteChange, pristine, pending, load]);

  const scoreOf = useMemo(() => {
    const map = new Map<string, ComparisonEntry>();
    for (const entry of rfq?.comparison ?? []) map.set(entry.responseId, entry);
    return map;
  }, [rfq]);

  const ordered = useMemo(() => {
    if (!rfq) return [];
    const ranked = orderedComparison(rfq.comparison).map((entry) => entry.responseId);
    return [...rfq.responses].sort((a, b) => {
      const ia = ranked.indexOf(a.id);
      const ib = ranked.indexOf(b.id);
      if (ia === ib) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }, [rfq]);

  function run(work: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setErrors([]);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        toast.error(result.error ?? 'No se pudo completar la acción');
        setErrors(result.error ? [result.error] : []);
        return;
      }
      toast.success(success);
      setRejecting(null);
      setSelection(EMPTY_SELECTION);
      await load();
    });
  }

  if (state === 'loading') {
    return <LoadingState variant="list" rows={3} label="Cargando las respuestas…" />;
  }
  if (state === 'failed' || !rfq) {
    return (
      <ErrorState
        title="No pudimos abrir las respuestas"
        message="Recarga la página; si el problema sigue, avisa a Administración."
      />
    );
  }

  return (
    <section className="area-drawer-section" aria-labelledby="rfq-review">
      <h3 id="rfq-review" className="area-drawer-section-title">
        Respuestas y comparación
      </h3>

      {remoteChange && !pristine ? (
        <Alert variant="info" title="Esta cotización cambió">
          <p>
            Llegó un movimiento de esta cotización. Al actualizar se pierde la selección que
            empezaste.
          </p>
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={pending}>
            Actualizar la comparación
          </Button>
        </Alert>
      ) : null}

      {errors.length > 0 ? (
        <Alert variant="error" title="No se pudo completar">
          <ul>
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {rfq.responses.length === 0 ? (
        <p className="area-row-sub">
          Todavía no responde ningún proveedor. Cuando llegue una respuesta a la bandeja, aparece
          aquí con su costo puesto en bodega.
        </p>
      ) : (
        <ul className="compras-response-list">
          {ordered.map((response) => {
            const score = scoreOf.get(response.id);
            const actions = canAct ? responseActions(response, rfq.status) : [];
            return (
              <li key={response.id} className="compras-response">
                <div className="compras-response-head">
                  <strong>{response.name ?? 'Proveedor sin nombre'}</strong>
                  <Badge variant={response.status === 'selected' ? 'success' : 'default'}>
                    {response.statusLabel}
                  </Badge>
                  {score?.recommended ? <Badge variant="success">Recomendada</Badge> : null}
                  {score && !score.comparable ? (
                    <Badge variant="warning">No comparable</Badge>
                  ) : null}
                </div>
                <p className="area-row-sub">
                  {money(response.landedTotal, response.currency)} puesto en bodega
                  {response.leadTimeDays !== null ? ` · ${response.leadTimeDays} día(s)` : ''}
                  {score ? ` · puntaje ${Math.round(score.score)} (lugar ${score.rank})` : ''}
                </p>
                {response.reviewReasons.length > 0 ? (
                  <p className="area-row-sub">Revisar: {response.reviewReasons.join(' · ')}</p>
                ) : null}
                {score && score.reasons.length > 0 ? (
                  <p className="area-row-sub">{score.reasons.join(' · ')}</p>
                ) : null}

                {actions.length > 0 ? (
                  <div className="area-drawer-actions">
                    {actions.map((action) => (
                      <Button
                        key={action.id}
                        size="sm"
                        variant={
                          action.tone === 'danger'
                            ? 'danger'
                            : action.tone === 'primary'
                              ? 'primary'
                              : 'secondary'
                        }
                        disabled={pending}
                        title={action.hint}
                        onClick={() => {
                          if (action.id === 'confirm') {
                            run(
                              () =>
                                confirmRfqResponseAction({
                                  rfqId: rfq.id,
                                  responseId: response.id,
                                }),
                              'Respuesta confirmada'
                            );
                            return;
                          }
                          if (action.id === 'reject') {
                            setSelection(EMPTY_SELECTION);
                            setRejecting({ responseId: response.id, reason: '' });
                            return;
                          }
                          setRejecting(null);
                          setSelection({ ...EMPTY_SELECTION, responseId: response.id });
                        }}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                ) : null}

                {rejecting?.responseId === response.id ? (
                  <div className="compras-response-form">
                    <FormField
                      label="Motivo"
                      htmlFor={`reject-${response.id}`}
                      help="Sale de la comparación. Queda en la cronología de la cotización."
                    >
                      <Textarea
                        id={`reject-${response.id}`}
                        rows={2}
                        value={rejecting.reason}
                        onChange={(event) =>
                          setRejecting({ responseId: response.id, reason: event.target.value })
                        }
                      />
                    </FormField>
                    <div className="area-drawer-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending}
                        onClick={() => setRejecting(null)}
                      >
                        Cancelar
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={pending || rejecting.reason.trim().length < 3}
                        onClick={() =>
                          run(
                            () =>
                              rejectRfqResponseAction({
                                rfqId: rfq.id,
                                responseId: response.id,
                                reason: rejecting.reason,
                              }),
                            'Respuesta descartada'
                          )
                        }
                      >
                        Descartar respuesta
                      </Button>
                    </div>
                  </div>
                ) : null}

                {selection.responseId === response.id ? (
                  <div className="compras-response-form">
                    <FormField
                      label="A dónde llega el material"
                      htmlFor={`mode-${response.id}`}
                      help="Sin elegir, la orden usa el destino que ya trae la cotización."
                    >
                      <Select
                        id={`mode-${response.id}`}
                        value={selection.deliveryMode}
                        onChange={(event) =>
                          setSelection((form) => ({
                            ...form,
                            deliveryMode: event.target.value as SelectResponseForm['deliveryMode'],
                          }))
                        }
                      >
                        <option value="">Como venga en la cotización</option>
                        <option value="warehouse">A nuestra bodega</option>
                        <option value="direct_to_customer">Directo al cliente</option>
                      </Select>
                    </FormField>
                    {selection.deliveryMode === 'direct_to_customer' ? (
                      <FormField
                        label="Expediente que recibe"
                        htmlFor={`case-${response.id}`}
                        help="Una entrega directa necesita el expediente al que llega el material."
                      >
                        <Input
                          id={`case-${response.id}`}
                          value={selection.directDeliveryCaseId}
                          onChange={(event) =>
                            setSelection((form) => ({
                              ...form,
                              directDeliveryCaseId: event.target.value,
                            }))
                          }
                        />
                      </FormField>
                    ) : null}
                    <FormField label="Fecha esperada" htmlFor={`date-${response.id}`}>
                      <Input
                        id={`date-${response.id}`}
                        type="date"
                        value={selection.expectedAt}
                        onChange={(event) =>
                          setSelection((form) => ({ ...form, expectedAt: event.target.value }))
                        }
                      />
                    </FormField>
                    <FormField label="Notas para la orden" htmlFor={`notes-${response.id}`}>
                      <Textarea
                        id={`notes-${response.id}`}
                        rows={2}
                        value={selection.notes}
                        onChange={(event) =>
                          setSelection((form) => ({ ...form, notes: event.target.value }))
                        }
                      />
                    </FormField>
                    <div className="area-drawer-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending}
                        onClick={() => setSelection(EMPTY_SELECTION)}
                      >
                        Cancelar
                      </Button>
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          const built = selectResponseFormToPayload(selection);
                          if (!built.ok) {
                            setErrors(built.errors);
                            return;
                          }
                          run(
                            () => selectRfqResponseAction({ rfqId: rfq.id, ...built.payload }),
                            'Cotización cerrada: se creó el borrador de la orden'
                          );
                        }}
                      >
                        Elegir y crear la orden
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!canAct && rfq.responses.length > 0 ? (
        <p className="area-row-sub">
          Puedes consultar la comparación; confirmar, descartar o elegir una respuesta lo hace quien
          gestiona las órdenes de compra.
        </p>
      ) : null}
    </section>
  );
}

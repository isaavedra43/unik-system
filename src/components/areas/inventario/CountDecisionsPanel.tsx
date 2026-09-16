'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  decideCountAdjustmentAction,
  resolveCountDisputeAction,
} from '@/app/app/areas/inventario/actions';
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
import type { CountDetail, CountLineRow } from '@/modules/inventory/inventory-queries';
import {
  ADJUSTMENT_DECISION_LABELS,
  DECISION_NOTE_MAX,
  DISPUTE_DECISIONS,
  DISPUTE_DECISION_LABELS,
  buildAdjustmentDecision,
  buildDisputeResolution,
  formatQty,
  formatSignedQty,
  groupCountLines,
  type DisputeDecision,
} from './inventario-model';

/**
 * Diferencias de un conteo cerrado (plan §3.3): autorizar el ajuste de lo que
 * quedó DENTRO de tolerancia y resolver lo que quedó EN DISPUTA.
 *
 * Es el panel que faltaba: los dos comandos existían y nadie los invocaba, así
 * que una línea en disputa se quedaba `disputed` para siempre, el perfil del
 * artículo seguía `DISPUTED` y cada necesidad de ese SKU se atoraba en
 * «verificar disponibilidad». Cerrar el trabajo de «Autorizar ajuste» con una
 * nota no tocaba ni la línea ni el perfil.
 *
 * El panel sólo aparece cuando hay algo que decidir; las reglas (permiso
 * `inventory.adjust`, conteo cerrado, línea todavía sin resolver, nota
 * obligatoria en la disputa) las vuelve a aplicar el motor dentro de la misma
 * transacción.
 */

export interface CountDecisionsPanelProps {
  areaKey: string;
  countId: string;
}

type CountPayload = CountDetail & { can?: { decide?: boolean } };

interface DisputeForm {
  decision: DisputeDecision;
  confirmedQty: string;
  unit: string;
  note: string;
}

function emptyDispute(line: CountLineRow): DisputeForm {
  return { decision: 'adjust', confirmedQty: '', unit: line.unit ?? '', note: '' };
}

function lineTitle(line: CountLineRow): string {
  return line.productName ?? line.sku ?? line.zohoItemId ?? 'Artículo';
}

function lineWhere(line: CountLineRow): string {
  return [line.locationCode, line.variantLabel, line.containerKey].filter(Boolean).join(' · ');
}

export function CountDecisionsPanel({ areaKey, countId }: CountDecisionsPanelProps) {
  const [detail, setDetail] = useState<CountPayload | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [disputes, setDisputes] = useState<Record<string, DisputeForm>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/app/areas/${encodeURIComponent(areaKey)}/api/inventario/counts/${encodeURIComponent(countId)}`,
        { headers: { accept: 'application/json' } }
      );
      const body = (await response.json().catch(() => ({}))) as Partial<CountPayload> & {
        error?: string;
      };
      if (!response.ok || !body.count) throw new Error(body.error ?? 'count_fetch_failed');
      setDetail(body as CountPayload);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, [areaKey, countId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'loading') {
    return <LoadingState variant="list" rows={2} label="Cargando las diferencias del conteo…" />;
  }
  if (state === 'failed' || !detail) {
    return (
      <ErrorState
        title="No pudimos cargar las diferencias"
        message="Vuelve a intentarlo; el conteo sigue donde estaba."
        onRetry={() => {
          setState('loading');
          void load();
        }}
      />
    );
  }

  const { pending: pendingLines, disputed } = groupCountLines(detail.lines);
  if (pendingLines.length === 0 && disputed.length === 0) return null;

  const canDecide = detail.can?.decide === true;
  const busy = pending || busyLineId !== null;

  function noteOf(lineId: string): string {
    return notes[lineId] ?? '';
  }

  function disputeOf(line: CountLineRow): DisputeForm {
    return disputes[line.id] ?? emptyDispute(line);
  }

  function run(
    lineId: string,
    action: () => Promise<{ ok: boolean; message?: string; error?: string }>
  ) {
    setError(null);
    setBusyLineId(lineId);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          toast.success(result.message ?? 'Listo');
          await load();
        } else {
          setError(result.error ?? 'No se pudo registrar la decisión');
          toast.error(result.error ?? 'No se pudo registrar la decisión');
        }
      } finally {
        setBusyLineId(null);
      }
    });
  }

  function decide(line: CountLineRow, decision: 'approve' | 'reject') {
    const input = buildAdjustmentDecision({
      lineId: line.id,
      decision,
      note: noteOf(line.id),
    });
    if (!input.ok) {
      setError(input.error);
      return;
    }
    run(line.id, async () => {
      const result = await decideCountAdjustmentAction(input.value);
      return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
    });
  }

  function resolve(line: CountLineRow) {
    const form = disputeOf(line);
    const input = buildDisputeResolution({
      lineId: line.id,
      decision: form.decision,
      confirmedQty: form.confirmedQty,
      unit: form.unit,
      note: form.note,
    });
    if (!input.ok) {
      setError(input.error);
      return;
    }
    run(line.id, async () => {
      const result = await resolveCountDisputeAction(input.value);
      return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
    });
  }

  return (
    <section className="area-drawer-section" aria-labelledby="inv-count-decisions">
      <h3 id="inv-count-decisions" className="area-drawer-section-title">
        Diferencias por decidir
      </h3>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {!canDecide ? (
        <Alert variant="info">
          Ves las diferencias, pero decidirlas necesita el permiso de ajustar inventario. Pídeselo a
          quien administra el área.
        </Alert>
      ) : null}

      {pendingLines.length > 0 ? (
        <div className="inv-card">
          <p className="inv-card-title">
            <span>Esperan autorización ({pendingLines.length})</span>
          </p>
          <p className="inv-card-hint">
            Están DENTRO de la tolerancia del artículo: autorizar mueve el libro, conservar lo deja
            como estaba. Quien cerró el conteo no podía ajustar, por eso quedaron aquí.
          </p>
          <ul className="inv-list">
            {pendingLines.map((line) => (
              <li key={line.id} className="inv-list-item inv-decision-row">
                <span className="inv-list-main">
                  <span>{lineTitle(line)}</span>
                  <span className="inv-list-sub">
                    {[
                      `Esperado ${formatQty(line.expectedQty, line.unit)}`,
                      `contado ${formatQty(line.countedQty, line.unit)}`,
                      `diferencia ${formatSignedQty(line.diffQty, line.unit)}`,
                      lineWhere(line),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {canDecide ? (
                  <div className="inv-decision-form">
                    <FormField label="Nota (opcional)" htmlFor={`inv-note-${line.id}`}>
                      <Input
                        id={`inv-note-${line.id}`}
                        value={noteOf(line.id)}
                        maxLength={DECISION_NOTE_MAX}
                        onChange={(event) =>
                          setNotes((current) => ({ ...current, [line.id]: event.target.value }))
                        }
                        placeholder="Qué encontraste"
                        autoComplete="off"
                      />
                    </FormField>
                    <div className="inv-capture-actions">
                      <Button
                        size="sm"
                        onClick={() => decide(line, 'approve')}
                        isLoading={busyLineId === line.id}
                        disabled={busy}
                      >
                        {ADJUSTMENT_DECISION_LABELS.approve}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => decide(line, 'reject')}
                        disabled={busy}
                      >
                        {ADJUSTMENT_DECISION_LABELS.reject}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {disputed.length > 0 ? (
        <div className="inv-card">
          <p className="inv-card-title">
            <span>En disputa ({disputed.length})</span>
            <Badge variant="danger">Bloquean compromisos</Badge>
          </p>
          <p className="inv-card-hint">
            Están FUERA de la tolerancia: mientras sigan abiertas el artículo queda «en disputa» y
            no se puede prometer. Resolverlas lo devuelve a «provisional».
          </p>
          <ul className="inv-list">
            {disputed.map((line) => {
              const form = disputeOf(line);
              return (
                <li key={line.id} className="inv-list-item inv-decision-row">
                  <span className="inv-list-main">
                    <span>{lineTitle(line)}</span>
                    <span className="inv-list-sub">
                      {[
                        `Esperado ${formatQty(line.expectedQty, line.unit)}`,
                        `contado ${formatQty(line.countedQty, line.unit)}`,
                        `diferencia ${formatSignedQty(line.diffQty, line.unit)}`,
                        lineWhere(line),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {canDecide ? (
                    <div className="inv-decision-form">
                      <FormField label="Decisión" htmlFor={`inv-dispute-decision-${line.id}`}>
                        <Select
                          id={`inv-dispute-decision-${line.id}`}
                          value={form.decision}
                          onChange={(event) =>
                            setDisputes((current) => ({
                              ...current,
                              [line.id]: {
                                ...form,
                                decision: event.target.value as DisputeDecision,
                              },
                            }))
                          }
                        >
                          {DISPUTE_DECISIONS.map((value) => (
                            <option key={value} value={value}>
                              {DISPUTE_DECISION_LABELS[value]}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                      {form.decision === 'adjust' ? (
                        <>
                          <FormField
                            label="Cantidad confirmada (opcional)"
                            htmlFor={`inv-dispute-qty-${line.id}`}
                            help="Si volviste a contar, escribe lo que hay de verdad; vacío usa lo capturado."
                          >
                            <Input
                              id={`inv-dispute-qty-${line.id}`}
                              value={form.confirmedQty}
                              inputMode="decimal"
                              autoComplete="off"
                              onChange={(event) =>
                                setDisputes((current) => ({
                                  ...current,
                                  [line.id]: { ...form, confirmedQty: event.target.value },
                                }))
                              }
                            />
                          </FormField>
                          <FormField label="Unidad" htmlFor={`inv-dispute-unit-${line.id}`}>
                            <Input
                              id={`inv-dispute-unit-${line.id}`}
                              value={form.unit}
                              maxLength={30}
                              autoComplete="off"
                              onChange={(event) =>
                                setDisputes((current) => ({
                                  ...current,
                                  [line.id]: { ...form, unit: event.target.value },
                                }))
                              }
                            />
                          </FormField>
                        </>
                      ) : null}
                      <FormField
                        label="Cómo se resolvió"
                        htmlFor={`inv-dispute-note-${line.id}`}
                        help="Obligatorio: queda en la bitácora del artículo y del expediente."
                      >
                        <Textarea
                          id={`inv-dispute-note-${line.id}`}
                          value={form.note}
                          rows={2}
                          maxLength={DECISION_NOTE_MAX}
                          onChange={(event) =>
                            setDisputes((current) => ({
                              ...current,
                              [line.id]: { ...form, note: event.target.value },
                            }))
                          }
                        />
                      </FormField>
                      <div className="inv-capture-actions">
                        <Button
                          size="sm"
                          onClick={() => resolve(line)}
                          isLoading={busyLineId === line.id}
                          disabled={busy}
                        >
                          Resolver diferencia
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

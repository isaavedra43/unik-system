'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import '@/styles/operations/ventas.css';
import {
  describeSubmitOutcome,
  formatDateTime,
  formatDueLabel,
} from '@/components/operations/mywork-model';
import { Alert, Badge, Button, Select } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { PipelineStageDTO } from '@/modules/crm/crm-dto';
import type { OpportunityDetail } from '@/modules/crm/crm-queries';
import { ACTIVITY_KIND_LABELS, type ManualActivityKind } from '@/modules/crm/types';
import {
  formatMoney,
  formatProbability,
  INBOX_HREF,
  quoteHref,
  salesOrderHref,
  VENTAS_API,
  ventasRadarHref,
  ventasWorkHref,
} from '@/modules/areas/ventas/ventas-constants';
import {
  buildActivityCommand,
  buildMoveStageCommand,
  buildNextActionCommand,
  lostReasonError,
  moveTargets,
  planStageMove,
  stageTone,
  toCard,
} from './pipeline-model';

/**
 * Detalle de una oportunidad (plan 7.4): sus datos, la línea de tiempo, las
 * cotizaciones, órdenes, expedientes y conversaciones ligadas, y las tres cosas
 * que se hacen desde aquí: mover de etapa, fijar la siguiente acción y
 * registrar una actividad.
 *
 * Todo se ejecuta como comando del CRM por la cola offline; la creación de la
 * orden de venta en Zoho es la misma escritura idempotente que usa la IA con
 * aprobación.
 */

export interface OpportunityDetailClientProps {
  userId: string;
  detail: OpportunityDetail;
  stages: PipelineStageDTO[];
  nowIso: string;
}

const ACTIVITY_OPTIONS = [
  'note',
  'call',
  'task',
  'objection',
  'objection_resolved',
] as const satisfies readonly ManualActivityKind[];

const activitySchema = z.object({
  kind: z.enum(ACTIVITY_OPTIONS),
  summary: z
    .string()
    .trim()
    .min(1, 'Escribe qué pasó')
    .max(2000, 'La nota admite hasta 2000 caracteres'),
  nextActionText: z.string().trim().max(240, 'Máximo 240 caracteres').optional(),
  nextActionAt: z.string().trim().optional(),
});

type ActivityForm = z.infer<typeof activitySchema>;

export function OpportunityDetailClient({
  userId,
  detail,
  stages,
  nowIso,
}: OpportunityDetailClientProps) {
  const router = useRouter();
  const { submit, online } = useOfflineCommandQueue(userId);
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const opportunity = detail.opportunity;
  const card = useMemo(() => toCard(opportunity), [opportunity]);
  const canManage = detail.permissions.canManage;

  const [busy, setBusy] = useState(false);
  const [stageId, setStageId] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [stageError, setStageError] = useState<string | null>(null);
  const [nextActionText, setNextActionText] = useState(opportunity.nextActionText ?? '');
  const [nextActionAt, setNextActionAt] = useState('');
  const [nextActionError, setNextActionError] = useState<string | null>(null);

  const run = useCallback(
    async (command: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => {
      setBusy(true);
      try {
        const outcome = await submit<Record<string, unknown>>(command);
        const feedback = describeSubmitOutcome(outcome, successMessage);
        if (feedback.kind === 'success') toast.success(feedback.message);
        else if (feedback.kind === 'queued') toast.info(feedback.message);
        else if (feedback.kind === 'conflict') toast.warning(feedback.message);
        else toast.error(feedback.message);
        if (feedback.refresh) router.refresh();
        return feedback.kind === 'success' || feedback.kind === 'queued';
      } finally {
        setBusy(false);
      }
    },
    [router, submit]
  );

  const targets = useMemo(
    () => moveTargets(stages, opportunity.stageId),
    [stages, opportunity.stageId]
  );
  const targetStage = targets.find((stage) => stage.id === stageId) ?? null;
  const needsReason = targetStage?.kind === 'lost';

  async function moveStage() {
    if (!targetStage) {
      setStageError('Elige la etapa destino');
      return;
    }
    const plan = planStageMove(card, targetStage);
    if (plan.kind === 'noop') {
      setStageError(plan.message);
      return;
    }
    if (plan.kind === 'needs_reason') {
      const invalid = lostReasonError(lostReason);
      if (invalid) {
        setStageError(invalid);
        return;
      }
    }
    setStageError(null);
    const done = await run(
      buildMoveStageCommand(card, targetStage, needsReason ? lostReason : undefined),
      `${opportunity.number} movida a ${targetStage.name}`
    );
    if (done) {
      setStageId('');
      setLostReason('');
    }
  }

  async function saveNextAction() {
    const text = nextActionText.trim();
    if (text.length < 2) {
      setNextActionError('Describe la siguiente acción');
      return;
    }
    if (!nextActionAt) {
      setNextActionError('Indica cuándo la vas a hacer');
      return;
    }
    const when = new Date(nextActionAt);
    if (Number.isNaN(when.getTime())) {
      setNextActionError('La fecha no es válida');
      return;
    }
    setNextActionError(null);
    await run(
      buildNextActionCommand({
        opportunityId: opportunity.id,
        version: opportunity.version,
        nextActionText: text,
        nextActionAt: when.toISOString(),
      }),
      'Siguiente acción guardada'
    );
  }

  const activityForm = useForm<ActivityForm>({
    resolver: zodResolver(activitySchema),
    defaultValues: { kind: 'note', summary: '', nextActionText: '', nextActionAt: '' },
  });

  const onActivity = activityForm.handleSubmit(async (values) => {
    const done = await run(
      buildActivityCommand({
        opportunityId: opportunity.id,
        kind: values.kind,
        summary: values.summary,
        ...(values.nextActionText ? { nextActionText: values.nextActionText } : {}),
        ...(values.nextActionAt
          ? { nextActionAt: new Date(values.nextActionAt).toISOString() }
          : {}),
      }),
      'Actividad registrada'
    );
    if (done)
      activityForm.reset({ kind: values.kind, summary: '', nextActionText: '', nextActionAt: '' });
  });

  const due = opportunity.nextActionAt ? formatDueLabel(opportunity.nextActionAt, now) : null;

  return (
    <div className="ventas-detail">
      <div className="ventas-detail-main">
        {!online ? (
          <Alert variant="warning">
            Sin conexión: lo que registres se enviará en cuanto vuelvas a estar en línea.
          </Alert>
        ) : null}

        <section className="ventas-panel" aria-labelledby="opp-facts">
          <h2 id="opp-facts" className="ventas-panel-title">
            Datos de la oportunidad
          </h2>
          <div className="ventas-toolbar">
            <Badge
              variant={
                stageTone(opportunity.stageKind) === 'success'
                  ? 'success'
                  : stageTone(opportunity.stageKind) === 'danger'
                    ? 'danger'
                    : 'info'
              }
            >
              {opportunity.stageName ?? 'Sin etapa'}
            </Badge>
            <Badge variant={opportunity.status === 'open' ? 'default' : 'weak'}>
              {opportunity.statusLabel}
            </Badge>
            {opportunity.stageSlaExceededHours !== null ? (
              <Badge variant="warning">{opportunity.stageSlaExceededHours} h sobre el SLA</Badge>
            ) : null}
          </div>
          <dl className="ventas-facts">
            <div>
              <dt>Folio</dt>
              <dd>{opportunity.number}</dd>
            </div>
            <div>
              <dt>Cliente</dt>
              <dd>{opportunity.contactName}</dd>
            </div>
            <div>
              <dt>Vendedor</dt>
              <dd>{opportunity.salespersonName ?? 'Sin asignar'}</dd>
            </div>
            <div>
              <dt>Valor estimado</dt>
              <dd>{formatMoney(opportunity.estimatedValue, opportunity.currency)}</dd>
            </div>
            <div>
              <dt>Probabilidad</dt>
              <dd>{formatProbability(opportunity.effectiveProbability)}</dd>
            </div>
            <div>
              <dt>Siguiente acción</dt>
              <dd>
                {opportunity.nextActionText ?? 'Sin definir'}
                {due ? (
                  <div
                    className={
                      due.tone === 'danger'
                        ? 'ventas-card-due-danger'
                        : due.tone === 'warning'
                          ? 'ventas-card-due-warning'
                          : 'ventas-muted'
                    }
                  >
                    {due.label}
                  </div>
                ) : null}
              </dd>
            </div>
            {opportunity.lostReason ? (
              <div>
                <dt>Motivo de la pérdida</dt>
                <dd>{opportunity.lostReason}</dd>
              </div>
            ) : null}
            <div>
              <dt>Última actividad</dt>
              <dd>{formatDateTime(opportunity.lastActivityAt)}</dd>
            </div>
          </dl>
        </section>

        <section className="ventas-panel" aria-labelledby="opp-timeline">
          <h2 id="opp-timeline" className="ventas-panel-title">
            Línea de tiempo
          </h2>
          {detail.activities.items.length === 0 ? (
            <p className="ventas-hint">Todavía no hay actividades registradas.</p>
          ) : (
            <ul className="ventas-timeline">
              {detail.activities.items.map((activity) => (
                <li key={activity.id}>
                  <span className="ventas-timeline-meta">
                    {formatDateTime(activity.at)} · {activity.kindLabel}
                    {activity.userName ? ` · ${activity.userName}` : ''}
                  </span>
                  <span className="ventas-timeline-summary">{activity.summary}</span>
                </li>
              ))}
            </ul>
          )}
          {detail.activities.total > detail.activities.items.length ? (
            <p className="ventas-hint">
              Mostrando {detail.activities.items.length} de {detail.activities.total} actividades.
            </p>
          ) : null}
        </section>

        {canManage ? (
          <section className="ventas-panel" aria-labelledby="opp-activity">
            <h2 id="opp-activity" className="ventas-panel-title">
              Registrar actividad
            </h2>
            <form className="ventas-form" onSubmit={onActivity} noValidate>
              <div className="ventas-form-row">
                <div>
                  <label className="form-label" htmlFor="activity-kind">
                    Tipo
                  </label>
                  <Select id="activity-kind" {...activityForm.register('kind')}>
                    {ACTIVITY_OPTIONS.map((kind) => (
                      <option key={kind} value={kind}>
                        {ACTIVITY_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="form-label" htmlFor="activity-next-at">
                    Siguiente acción (opcional)
                  </label>
                  <input
                    id="activity-next-at"
                    type="datetime-local"
                    {...activityForm.register('nextActionAt')}
                  />
                </div>
              </div>
              <div>
                <label className="form-label" htmlFor="activity-summary">
                  Qué pasó
                </label>
                <textarea
                  id="activity-summary"
                  rows={3}
                  aria-invalid={activityForm.formState.errors.summary ? 'true' : undefined}
                  {...activityForm.register('summary')}
                />
                {activityForm.formState.errors.summary ? (
                  <p className="ventas-form-error">
                    {activityForm.formState.errors.summary.message}
                  </p>
                ) : null}
              </div>
              <div>
                <label className="form-label" htmlFor="activity-next-text">
                  Qué sigue (opcional)
                </label>
                <input
                  id="activity-next-text"
                  maxLength={240}
                  {...activityForm.register('nextActionText')}
                />
              </div>
              <div className="ventas-form-actions">
                <Button type="submit" variant="primary" size="sm" disabled={busy}>
                  {busy ? 'Guardando…' : 'Registrar'}
                </Button>
              </div>
            </form>
          </section>
        ) : null}
      </div>

      <div className="ventas-detail-side">
        {canManage ? (
          <section className="ventas-panel" aria-labelledby="opp-stage">
            <h2 id="opp-stage" className="ventas-panel-title">
              Mover de etapa
            </h2>
            <div className="ventas-form">
              <div>
                <label className="form-label" htmlFor="opp-stage-select">
                  Etapa destino
                </label>
                <Select
                  id="opp-stage-select"
                  value={stageId}
                  onChange={(event) => setStageId(event.target.value)}
                >
                  <option value="">Elige una etapa…</option>
                  {targets.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.name}
                    </option>
                  ))}
                </Select>
              </div>
              {needsReason ? (
                <div>
                  <label className="form-label" htmlFor="opp-lost-reason">
                    Motivo de la pérdida
                  </label>
                  <textarea
                    id="opp-lost-reason"
                    rows={2}
                    maxLength={500}
                    value={lostReason}
                    onChange={(event) => setLostReason(event.target.value)}
                  />
                </div>
              ) : null}
              {stageError ? <p className="ventas-form-error">{stageError}</p> : null}
              <div className="ventas-form-actions">
                <Button
                  variant={needsReason ? 'danger' : 'primary'}
                  size="sm"
                  onClick={moveStage}
                  disabled={busy || !stageId}
                >
                  {busy ? 'Enviando…' : 'Mover'}
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        {canManage ? (
          <section className="ventas-panel" aria-labelledby="opp-next">
            <h2 id="opp-next" className="ventas-panel-title">
              Siguiente acción
            </h2>
            <div className="ventas-form">
              <div>
                <label className="form-label" htmlFor="opp-next-text">
                  Qué vas a hacer
                </label>
                <input
                  id="opp-next-text"
                  maxLength={240}
                  value={nextActionText}
                  onChange={(event) => setNextActionText(event.target.value)}
                />
              </div>
              <div>
                <label className="form-label" htmlFor="opp-next-at">
                  Cuándo
                </label>
                <input
                  id="opp-next-at"
                  type="datetime-local"
                  value={nextActionAt}
                  onChange={(event) => setNextActionAt(event.target.value)}
                />
              </div>
              {nextActionError ? <p className="ventas-form-error">{nextActionError}</p> : null}
              <div className="ventas-form-actions">
                <Button variant="secondary" size="sm" onClick={saveNextAction} disabled={busy}>
                  Guardar
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        <section className="ventas-panel" aria-labelledby="opp-quotes">
          <h2 id="opp-quotes" className="ventas-panel-title">
            Cotizaciones
          </h2>
          {detail.quotes.length === 0 ? (
            <p className="ventas-hint">Sin cotizaciones ligadas.</p>
          ) : (
            <ul className="ventas-list">
              {detail.quotes.map((quote) => (
                <QuoteRow
                  key={quote.id}
                  quoteId={quote.id}
                  folio={quote.estimateNumber ?? quote.zohoEstimateId}
                  statusLabel={quote.statusLabel}
                  total={formatMoney(quote.total, quote.currencyCode ?? 'MXN')}
                  convertible={quote.convertible}
                  opportunityId={opportunity.id}
                  canCreateSalesOrder={detail.permissions.canCreateSalesOrder}
                  onDone={() => router.refresh()}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="ventas-panel" aria-labelledby="opp-links">
          <h2 id="opp-links" className="ventas-panel-title">
            Órdenes, expedientes y conversaciones
          </h2>
          <ul className="ventas-list">
            {detail.salesOrders.map((order) => (
              <li key={order.id} className="ventas-list-item">
                <Link href={salesOrderHref(order.id)}>
                  <strong>{order.salesOrderNumber ?? order.zohoSalesOrderId}</strong>
                </Link>
                <span>{formatMoney(order.total, order.currencyCode ?? 'MXN')}</span>
                <span className="ventas-muted">{order.status ?? 'Sin estado'}</span>
              </li>
            ))}
            {detail.cases.map((operationalCase) => (
              <li key={operationalCase.id} className="ventas-list-item">
                <Link href={ventasWorkHref({ caso: operationalCase.id, scope: 'all' })}>
                  <strong>{operationalCase.caseNumber}</strong>
                </Link>
                <span className="ventas-muted">
                  {operationalCase.phase} · {operationalCase.status}
                </span>
              </li>
            ))}
            {detail.conversations.map((conversation) => (
              <li key={conversation.id} className="ventas-list-item">
                <Link href={INBOX_HREF}>
                  <strong>{conversation.contactName}</strong>
                </Link>
                <span className="ventas-muted">
                  {conversation.channel} · {conversation.accountLabel}
                </span>
              </li>
            ))}
            {detail.signals.map((signal) => (
              <li key={signal.id} className="ventas-list-item">
                <Link href={ventasRadarHref({ signal: signal.id })}>
                  <strong>{signal.kindLabel}</strong>
                </Link>
                <span className="ventas-muted">{signal.reason}</span>
              </li>
            ))}
            {detail.salesOrders.length === 0 &&
            detail.cases.length === 0 &&
            detail.conversations.length === 0 &&
            detail.signals.length === 0 ? (
              <li className="ventas-list-item">
                <span className="ventas-muted">
                  Todavía no hay órdenes, expedientes ni conversaciones ligadas.
                </span>
              </li>
            ) : null}
          </ul>
          {detail.hiddenConversations > 0 ? (
            <p className="ventas-hint">
              {detail.hiddenConversations} conversación(es) pertenecen a cuentas de la bandeja que
              no puedes abrir.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function QuoteRow({
  quoteId,
  folio,
  statusLabel,
  total,
  convertible,
  opportunityId,
  canCreateSalesOrder,
  onDone,
}: {
  quoteId: string;
  folio: string;
  statusLabel: string;
  total: string;
  convertible: boolean;
  opportunityId: string;
  canCreateSalesOrder: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function convert() {
    setBusy(true);
    try {
      const response = await fetch(VENTAS_API.quoteSalesOrder(quoteId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ opportunityId }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        result?: { salesOrderNumber: string | null; mock: boolean; replayed: boolean };
        error?: string;
      };
      if (!response.ok || !json.result) {
        throw new Error(json.error ?? 'No se pudo crear la orden de venta');
      }
      toast.success(
        json.result.replayed
          ? `Esta cotización ya tenía la orden ${json.result.salesOrderNumber ?? ''}`.trim()
          : `Orden ${json.result.salesOrderNumber ?? 'creada'} en Zoho${json.result.mock ? ' (modo simulado)' : ''}`
      );
      setConfirming(false);
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo crear la orden de venta');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="ventas-list-item">
      <Link href={quoteHref(quoteId)}>
        <strong>{folio}</strong>
      </Link>
      <span>{statusLabel}</span>
      <span>{total}</span>
      <div className="ventas-toolbar-spacer" />
      {convertible && canCreateSalesOrder ? (
        confirming ? (
          <>
            <Button variant="primary" size="sm" onClick={convert} disabled={busy}>
              {busy ? 'Creando…' : 'Sí, crear en Zoho'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancelar
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            Crear OV en Zoho
          </Button>
        )
      ) : null}
    </li>
  );
}

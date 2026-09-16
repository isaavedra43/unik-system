'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, MessageSquare, Paperclip, RefreshCw, Sparkles, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { CaseRoomCopilotPanel } from '@/components/operations/CaseRoomCopilotPanel';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import {
  describeSubmitOutcome,
  formatDateTime,
  formatDueLabel,
} from '@/components/operations/mywork-model';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import {
  CASE_ACTION_CONFIRM,
  CASE_ACTION_HINTS,
  CASE_ACTION_LABELS,
  CASE_ACTION_SUCCESS,
  CASE_MOBILE_OPEN_SECTIONS,
  CASE_REALTIME_TYPES,
  CASE_REASON_MAX,
  CASE_RISK_LABELS,
  CASE_RISK_TONES,
  buildCaseCommand,
  buildCaseCopilotContext,
  buildCaseReasonPayload,
  caseActions,
  groupStepsByArea,
  requestAnswerHref,
  stepTone,
  type CaseAction,
  type CaseSectionId,
  type CaseTone,
} from './case-model';
import type { CaseViewData } from './case-view';
import { CaseActionDialog, type CasePendingAction } from './CaseActionDialog';
import { CasePhaseProgress } from './CasePhaseProgress';
import { CaseSection } from './CaseSection';
import { CaseTimeline } from './CaseTimeline';
import { CaseWorkItems } from './CaseWorkItems';

export interface Case360Props {
  view: CaseViewData;
  user: { id: string; name: string };
  /** `operations.manage`: replan and cancel (the engine checks again). */
  canManage: boolean;
  /** `assistant.use`: without it there is no copilot panel. */
  canUseAssistant: boolean;
  /** Incident named by a notification (`?incident=<id>`): its section opens and it is highlighted. */
  focusIncidentId?: string | null;
  /** Server time of the render, so due labels match on hydration. */
  nowIso: string;
}

/** Width at which the copilot aside fits beside the case (same breakpoint as `case-360.css`). */
const ASIDE_MIN_WIDTH = 1280;

const BADGE_BY_TONE: Record<
  CaseTone,
  'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak'
> = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
};

const SEVERITY_TONE: Record<string, CaseTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
};

const REQUEST_TONE: Record<string, CaseTone> = {
  sent: 'info',
  acknowledged: 'info',
  accepted: 'info',
  blocked: 'danger',
  resolved: 'success',
  rejected: 'danger',
  cancelled: 'weak',
  expired: 'danger',
};

function openOf(id: CaseSectionId): boolean {
  return CASE_MOBILE_OPEN_SECTIONS.includes(id);
}

/**
 * Expediente 360 (plan 2.7): one page with the order, the promise, the phase,
 * what is next and who has it, the needs with their allocations, the steps by
 * area, the open work, the requests between areas, the incidents, the delivery,
 * the evidence and the full timeline — plus the case copilot beside it.
 *
 * No business logic lives here: every action is a command of the core sent
 * through the offline queue (`POST /app/operations/api/commands`), and the
 * engine decides what happens.
 */
export function Case360({
  view,
  user,
  canManage,
  canUseAssistant,
  focusIncidentId = null,
  nowIso,
}: Case360Props) {
  const router = useRouter();
  // The aside only fits from 1280 px up (`case-360.css`); below that the
  // copilot lives in a sheet, so it is reachable on a tablet too.
  const isNarrow = useIsMobile(ASIDE_MIN_WIDTH - 1);
  const { submit, online } = useOfflineCommandQueue(user.id);
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [pending, setPending] = useState<CasePendingAction | null>(null);
  const [news, setNews] = useState(0);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [timelineFilter, setTimelineFilter] = useState('all');

  const { header, progress, next } = view;

  useOperationsRealtime(
    [`case:${header.id}`],
    CASE_REALTIME_TYPES,
    useCallback(() => setNews((value) => value + 1), [])
  );

  const refresh = useCallback(() => {
    setNews(0);
    router.refresh();
  }, [router]);

  // A notification about an incident lands on the case: bring that row into view.
  const focusedIncidentRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!focusIncidentId) return;
    focusedIncidentRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusIncidentId]);

  const runCommand = useCallback(
    async (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => {
      const outcome = await submit<Record<string, unknown>>(input);
      const feedback = describeSubmitOutcome(outcome, successMessage);
      if (feedback.kind === 'success') toast.success(feedback.message);
      else if (feedback.kind === 'queued') toast.info(feedback.message);
      else if (feedback.kind === 'conflict') toast.warning(feedback.message);
      else toast.error(feedback.message);
      if (feedback.refresh) refresh();
      return feedback.kind === 'success' || feedback.kind === 'queued';
    },
    [submit, refresh]
  );

  function openCaseAction(action: CaseAction) {
    setPending({
      key: `case-${action}`,
      title: CASE_ACTION_LABELS[action],
      subject: `${header.caseNumber}${header.customerName ? ` · ${header.customerName}` : ''}`,
      form: 'reason',
      tone: action === 'cancel' ? 'danger' : 'primary',
      confirm: CASE_ACTION_CONFIRM[action],
      hint: CASE_ACTION_HINTS[action],
      required: action === 'cancel',
      maxLength: CASE_REASON_MAX,
      successMessage: CASE_ACTION_SUCCESS[action],
      build: ({ text }) => buildCaseReasonPayload(action, text),
      command: (payload) =>
        buildCaseCommand(action, { id: header.id, version: header.version }, payload),
    });
  }

  const copilotContext = useCallback(
    () =>
      buildCaseCopilotContext({
        caseId: header.id,
        caseNumber: header.caseNumber,
        status: header.status,
        phase: header.phase,
        promisedAt: header.promisedAt,
        risk: header.risk,
        progress,
        next,
        workItems: view.workItems,
        requests: view.requests,
        incidents: view.incidents.filter((incident) => incident.open).length,
        timelineFilter,
      }),
    [header, progress, next, view.workItems, view.requests, view.incidents, timelineFilter]
  );

  const stepGroups = useMemo(() => groupStepsByArea(view.steps), [view.steps]);
  const openRequests = view.requests.filter((request) => request.open);
  const openIncidents = view.incidents.filter((incident) => incident.open);
  const actions = caseActions(header.status, { canManage });
  const promised = header.promisedAt ? formatDueLabel(header.promisedAt, now) : null;
  // When the case is waiting on another area, the headline offers where to answer.
  const nextRequest = next.requestId
    ? (view.requests.find((request) => request.id === next.requestId) ?? null)
    : null;
  const nextAnswer = nextRequest ? requestAnswerHref(nextRequest, user.id) : null;

  const copilot = canUseAssistant ? (
    <CaseRoomCopilotPanel
      caseId={header.id}
      caseLabel={`${header.caseNumber}${header.customerName ? ` · ${header.customerName}` : ''}`}
      user={user}
      activityAt={view.activityAt}
      context={copilotContext}
      onAfterTurn={refresh}
      {...(isNarrow ? { onBack: () => setCopilotOpen(false) } : {})}
    />
  ) : null;

  return (
    <div className="case-page">
      <div className="case-main">
        {view.warnings.map((warning) => (
          <Alert key={warning} variant="warning">
            {warning}
          </Alert>
        ))}

        <header className="case-header">
          <div className="case-title-row">
            <h1 className="case-number">{header.caseNumber}</h1>
            <div className="case-badges">
              <Badge variant={header.status === 'blocked' ? 'danger' : 'info'}>
                {header.statusLabel}
              </Badge>
              <Badge variant={BADGE_BY_TONE[CASE_RISK_TONES[header.risk]]}>
                {CASE_RISK_LABELS[header.risk]}
              </Badge>
              {header.priority !== 'normal' ? (
                <Badge variant="warning">{header.priorityLabel}</Badge>
              ) : null}
            </div>
          </div>

          <div className="case-meta">
            <span className="case-meta-item">
              Cliente: <strong>{header.customerName ?? 'Sin cliente'}</strong>
            </span>
            <span className="case-meta-item">
              Orden:{' '}
              {header.salesOrderHref ? (
                <Link href={header.salesOrderHref}>
                  <strong>{header.salesOrderNumber ?? 'Ver orden'}</strong>
                </Link>
              ) : (
                <strong>{header.salesOrderNumber ?? 'Sin orden'}</strong>
              )}
              {header.salesOrderStatus ? ` · ${header.salesOrderStatus}` : ''}
            </span>
            <span className="case-meta-item">
              Promesa:{' '}
              <strong className={promised?.tone === 'danger' ? 'case-due-danger' : undefined}>
                {promised ? promised.label : 'Sin fecha'}
              </strong>
            </span>
            <span className="case-meta-item">
              Responsable: <strong>{header.ownerName ?? 'Sin asignar'}</strong>
            </span>
            {header.locationName ? (
              <span className="case-meta-item">
                Bodega: <strong>{header.locationName}</strong>
              </span>
            ) : null}
            {header.deliveryMethod ? (
              <span className="case-meta-item">
                Entrega: <strong>{header.deliveryMethod}</strong>
              </span>
            ) : null}
            <span className="case-meta-item">
              Proceso: <strong>{header.process}</strong>
            </span>
          </div>

          <CasePhaseProgress progress={progress} currentPhaseLabel={header.phaseLabel} />

          {header.closedAt || header.cancelledAt ? (
            <Alert variant={header.cancelledAt ? 'warning' : 'info'}>
              {header.cancelledAt
                ? `Expediente cancelado el ${formatDateTime(header.cancelledAt)}`
                : `Expediente cerrado el ${formatDateTime(header.closedAt)}`}
              {header.closeReason ? `: ${header.closeReason}` : '.'}
            </Alert>
          ) : null}

          <div className="case-header-actions">
            {header.chatHref ? (
              <Link className="btn btn-secondary btn-sm" href={header.chatHref}>
                <MessageSquare size={14} aria-hidden="true" />
                Sala del expediente
              </Link>
            ) : null}
            {actions.map((action) => (
              <Button
                key={action}
                variant="secondary"
                // Cancelar es destructiva pero NO es la acción esperada aquí
                // (esa es «Iniciar», en Siguiente paso): contorno de peligro,
                // nunca el relleno sólido con más contraste de la cabecera.
                className={action === 'cancel' ? 'btn-danger-outline' : undefined}
                size="sm"
                onClick={() => openCaseAction(action)}
              >
                {CASE_ACTION_LABELS[action]}
              </Button>
            ))}
            {canUseAssistant && isNarrow ? (
              <Button variant="secondary" size="sm" onClick={() => setCopilotOpen(true)}>
                <Sparkles size={14} aria-hidden="true" />
                IA del expediente
              </Button>
            ) : null}
          </div>

          {news > 0 ? (
            <div className="case-news">
              <Button variant="secondary" size="sm" onClick={refresh}>
                <RefreshCw size={14} aria-hidden="true" />
                {news === 1
                  ? 'Hay 1 movimiento nuevo · Actualizar'
                  : `Hay ${news} movimientos nuevos · Actualizar`}
              </Button>
            </div>
          ) : null}
        </header>

        <section className="case-next" aria-labelledby="case-next-title">
          <span className="case-next-label">Siguiente paso</span>
          <h2 id="case-next-title" className="case-next-title">
            {next.title}
          </h2>
          <p className="case-next-reason">{next.reason}</p>
          <div className="case-next-meta">
            <span>Responsable: {next.ownerName ?? next.areaLabel ?? 'Sin asignar'}</span>
            {next.dueAt ? (
              <span className={next.overdue ? 'case-due-danger' : undefined}>
                {formatDueLabel(next.dueAt, now).label}
              </span>
            ) : null}
            {next.areaLabel ? <span>Área: {next.areaLabel}</span> : null}
          </div>
          {next.workItem ? (
            <div className="case-next-actions">
              <CaseWorkItems
                caseId={header.id}
                items={[next.workItem]}
                now={now}
                onAction={setPending}
                onRun={runCommand}
              />
            </div>
          ) : nextAnswer ? (
            <div className="case-next-actions">
              <Link className="btn btn-primary btn-sm" href={nextAnswer.href}>
                {nextAnswer.label}
              </Link>
            </div>
          ) : null}
        </section>

        <CaseSection
          id="necesidades"
          title="Necesidades"
          count={`${view.demands.length}`}
          defaultOpen={openOf('necesidades')}
        >
          {view.demands.length === 0 ? (
            <div className="case-empty">
              <strong>Sin necesidades</strong>
              <p>La orden no tiene partidas de artículos que surtir.</p>
            </div>
          ) : (
            view.demands.map((demand) => (
              <div key={demand.id} className="case-demand">
                <div className="case-demand-head">
                  <span className="case-demand-name">
                    {demand.name}
                    {demand.sku ? ` · ${demand.sku}` : ''}
                  </span>
                  <Badge variant={demand.status === 'fulfilled' ? 'success' : 'info'}>
                    {demand.statusLabel}
                  </Badge>
                </div>
                <div className="case-item-meta">
                  <span>
                    {demand.quantity} {demand.unit} pedidos
                  </span>
                  <span>
                    {demand.fulfilledQuantity} {demand.baseUnit} surtidos
                  </span>
                  {demand.confidence ? (
                    <span>
                      Confianza de inventario: {demand.confidence.label}
                      {demand.confidence.lastCountAt
                        ? ` · último conteo ${formatDateTime(demand.confidence.lastCountAt)}`
                        : ''}
                    </span>
                  ) : null}
                </div>
                {demand.allocations.length === 0 ? (
                  <p className="case-item-meta">Todavía no se decide cómo se cubre.</p>
                ) : (
                  <ul className="case-allocations">
                    {demand.allocations.map((allocation) => (
                      <li key={allocation.id} className="case-allocation">
                        <span>{allocation.sourceLabel}</span>
                        <span>
                          {allocation.quantity} {demand.baseUnit}
                        </span>
                        <span>{allocation.statusLabel}</span>
                        {allocation.warehouseName ? <span>{allocation.warehouseName}</span> : null}
                        {allocation.linkedLabel ? <span>{allocation.linkedLabel}</span> : null}
                        {allocation.expectedAt ? (
                          <span>Llega {formatDateTime(allocation.expectedAt)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </CaseSection>

        <CaseSection
          id="pasos"
          title="Pasos por área"
          count={`${progress.done}/${progress.total}`}
          defaultOpen={openOf('pasos')}
        >
          {stepGroups.length === 0 ? (
            <div className="case-empty">
              <strong>Sin pasos</strong>
              <p>El expediente todavía no instancia los pasos de su proceso.</p>
            </div>
          ) : (
            stepGroups.map((group) => (
              <div key={group.areaKey} className="case-step-group">
                <div className="case-step-group-head">
                  <h3 className="case-step-group-title">{group.areaLabel}</h3>
                  <span className="case-step-meta">
                    {group.open} {group.open === 1 ? 'paso abierto' : 'pasos abiertos'}
                    {group.overdue > 0 ? ` · ${group.overdue} vencidos` : ''}
                  </span>
                </div>
                <ul className="case-steps">
                  {group.steps.map((step) => {
                    const due = step.dueAt ? formatDueLabel(step.dueAt, now) : null;
                    return (
                      <li key={step.id} className="case-step">
                        <span className="case-step-label">
                          <span>{step.label}</span>
                          <span className="case-step-scope">
                            {step.kindLabel}
                            {step.scopeLabel ? ` · ${step.scopeLabel}` : ''}
                            {step.slaMinutes > 0 ? ` · SLA ${step.slaMinutes} min` : ''}
                          </span>
                        </span>
                        <span className="case-item-actions">
                          {due ? (
                            <span
                              className={
                                due.tone === 'danger'
                                  ? 'case-due-danger'
                                  : due.tone === 'warning'
                                    ? 'case-due-warning'
                                    : 'case-step-meta'
                              }
                              title={due.title}
                            >
                              {due.label}
                            </span>
                          ) : null}
                          <Badge variant={BADGE_BY_TONE[stepTone(step)]}>{step.statusLabel}</Badge>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </CaseSection>

        <CaseSection
          id="trabajos"
          title="Trabajos abiertos"
          count={`${view.workItems.length}`}
          defaultOpen={openOf('trabajos')}
        >
          <CaseWorkItems
            caseId={header.id}
            items={view.workItems}
            now={now}
            onAction={setPending}
            onRun={runCommand}
          />
        </CaseSection>

        <CaseSection
          id="solicitudes"
          title="Solicitudes entre áreas"
          count={`${openRequests.length} abiertas`}
          defaultOpen={openOf('solicitudes')}
        >
          {view.requests.length === 0 ? (
            <div className="case-empty">
              <strong>Sin solicitudes</strong>
              <p>Ningún área le ha pedido algo a otra en este expediente.</p>
            </div>
          ) : (
            <ul className="case-list">
              {view.requests.map((request) => {
                const due = formatDueLabel(request.dueAt, now, { closed: !request.open });
                const answer = requestAnswerHref(request, user.id);
                return (
                  <li
                    key={request.id}
                    className={`case-item ${request.blocksDelivery && request.open ? 'case-item-alert' : ''}`.trim()}
                  >
                    <div className="case-item-main">
                      <span className="case-item-title">{request.title}</span>
                      <span className="case-item-meta">
                        <Badge variant={BADGE_BY_TONE[REQUEST_TONE[request.status] ?? 'default']}>
                          {request.statusLabel}
                        </Badge>
                        <span>
                          {request.fromAreaLabel} → {request.toAreaLabel}
                        </span>
                        <span>{request.kindLabel}</span>
                        <span>{request.ownerName ?? 'Sin responsable'}</span>
                        <span className={due.tone === 'danger' ? 'case-due-danger' : undefined}>
                          {due.label}
                        </span>
                        {request.blocksDelivery ? <span>Bloquea la entrega</span> : null}
                      </span>
                      {request.freeText ? (
                        <blockquote className="case-quote">{request.freeText}</blockquote>
                      ) : null}
                    </div>
                    {answer ? (
                      <div className="case-item-actions">
                        <Link className="btn btn-secondary btn-sm" href={answer.href}>
                          {answer.label}
                        </Link>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CaseSection>

        <CaseSection
          id="incidencias"
          title="Incidencias"
          count={`${openIncidents.length} abiertas`}
          defaultOpen={openOf('incidencias') || Boolean(focusIncidentId)}
        >
          {view.incidents.length === 0 ? (
            <div className="case-empty">
              <strong>Sin incidencias</strong>
              <p>El expediente no ha necesitado abrir ninguna.</p>
            </div>
          ) : (
            <ul className="case-list">
              {view.incidents.map((incident) => (
                <li
                  key={incident.id}
                  id={`incidencia-${incident.id}`}
                  ref={incident.id === focusIncidentId ? focusedIncidentRef : undefined}
                  aria-current={incident.id === focusIncidentId ? 'true' : undefined}
                  className={`case-item ${incident.open ? 'case-item-alert' : ''} ${
                    incident.id === focusIncidentId ? 'case-item-focus' : ''
                  }`.trim()}
                >
                  <div className="case-item-main">
                    <span className="case-item-title">{incident.title}</span>
                    <span className="case-item-meta">
                      <Badge variant={BADGE_BY_TONE[SEVERITY_TONE[incident.severity] ?? 'default']}>
                        {incident.severityLabel}
                      </Badge>
                      <span>{incident.statusLabel}</span>
                      <span>{incident.kindLabel}</span>
                      <span>{incident.areaLabel}</span>
                      <span>{formatDateTime(incident.openedAt)}</span>
                      {incident.ownerName ? <span>{incident.ownerName}</span> : null}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CaseSection>

        <CaseSection
          id="entrega"
          title="Entrega"
          count={`${view.delivery.length}`}
          defaultOpen={openOf('entrega')}
        >
          {view.delivery.length === 0 ? (
            <div className="case-empty">
              <strong>Sin órdenes de entrega</strong>
              <p>Logística todavía no planea cómo llega el material al cliente.</p>
            </div>
          ) : (
            <ul className="case-list">
              {view.delivery.map((order) => (
                <li
                  key={order.id}
                  className={`case-item ${order.zohoNeedsAttention ? 'case-item-alert' : ''}`.trim()}
                >
                  <div className="case-item-main">
                    <span className="case-item-title">
                      <Truck size={14} aria-hidden="true" /> {order.modeLabel}
                      {order.carrier ? ` · ${order.carrier}` : ''}
                    </span>
                    <span className="case-item-meta">
                      <Badge variant={order.status === 'delivered' ? 'success' : 'info'}>
                        {order.statusLabel}
                      </Badge>
                      <span>Zoho: {order.zohoSyncLabel}</span>
                      {order.plannedDate ? (
                        <span>Planeada {formatDateTime(order.plannedDate)}</span>
                      ) : null}
                      {order.deliveredAt ? (
                        <span>Entregada {formatDateTime(order.deliveredAt)}</span>
                      ) : null}
                      {order.trip ? (
                        <span>
                          Viaje {order.trip.number} · {order.trip.statusLabel}
                          {order.trip.driverName ? ` · ${order.trip.driverName}` : ''}
                          {order.trip.vehicleLabel ? ` · ${order.trip.vehicleLabel}` : ''}
                        </span>
                      ) : (
                        <span>Sin viaje asignado</span>
                      )}
                    </span>
                    {order.addressLine ? (
                      <span className="case-item-meta">
                        {order.addressLine}
                        {order.contactName ? ` · ${order.contactName}` : ''}
                      </span>
                    ) : null}
                  </div>
                  <div className="case-item-actions">
                    {order.packageHref ? (
                      <Link className="btn btn-secondary btn-sm" href={order.packageHref}>
                        <ExternalLink size={14} aria-hidden="true" />
                        Paquete {order.packageNumber ?? ''}
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CaseSection>

        <CaseSection
          id="evidencias"
          title="Evidencias"
          count={`${view.evidence.length}`}
          defaultOpen={openOf('evidencias')}
        >
          {view.evidence.length === 0 ? (
            <div className="case-empty">
              <strong>Sin evidencias</strong>
              <p>Se adjuntan al completar los trabajos, desde Mi trabajo o el centro de trabajo.</p>
            </div>
          ) : (
            <ul className="case-evidence-list">
              {view.evidence.map((item) => (
                <li key={item.id} className="case-evidence-item">
                  <Paperclip size={14} aria-hidden="true" />
                  <span>
                    {item.kindLabel}
                    {item.note ? ` · ${item.note}` : ''}
                    {item.createdByName ? ` · ${item.createdByName}` : ''} ·{' '}
                    {formatDateTime(item.createdAt)}
                  </span>
                  {item.fileUrl ? (
                    <a href={item.fileUrl} target="_blank" rel="noreferrer">
                      {item.fileName ?? 'Ver archivo'}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CaseSection>

        <CaseSection
          id="cronologia"
          title="Cronología"
          count={`${view.timeline.length}`}
          defaultOpen={openOf('cronologia')}
        >
          <CaseTimeline
            caseId={header.id}
            entries={view.timeline}
            olderCursor={view.timelineCursor}
            onFilterChange={setTimelineFilter}
          />
        </CaseSection>
      </div>

      {copilot && !isNarrow ? <aside className="case-aside">{copilot}</aside> : null}

      {copilot && isNarrow ? (
        <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
          <SheetContent side="right" className="w-full max-w-md p-0">
            <SheetTitle className="sr-only">IA del expediente</SheetTitle>
            <SheetDescription className="sr-only">
              Copiloto del expediente sobre lo que está en pantalla
            </SheetDescription>
            <div className="case-copilot-sheet">{copilot}</div>
          </SheetContent>
        </Sheet>
      ) : null}

      {pending ? (
        <CaseActionDialog
          key={pending.key}
          pending={pending}
          now={now}
          online={online}
          onClose={() => setPending(null)}
          onSubmit={runCommand}
        />
      ) : null}
    </div>
  );
}

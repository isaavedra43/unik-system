'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock, ListChecks, PauseCircle, Play, Sparkles, Timer } from 'lucide-react';
import { toast } from 'sonner';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { EmptyState, TabNav } from '@/components/ui/composite';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import { MyWorkActionDialog, type PendingWorkAction } from './MyWorkActionDialog';
import { MyWorkApprovals } from './MyWorkApprovals';
import { MyWorkCopilotPanel } from './MyWorkCopilotPanel';
import { operationsCaseHref } from './copilot-starters';
import {
  MYWORK_REALTIME_TYPES,
  NEXT_ACTION_REASON_LABELS,
  WORK_ITEM_ACTION_LABELS,
  WORK_ITEM_ACTION_SUCCESS,
  WORK_ITEM_STATUS_BADGE,
  availableActions,
  buildMyWorkCopilotContext,
  buildWorkItemCommand,
  completionRequirements,
  describeSubmitOutcome,
  formatDateTime,
  formatDueLabel,
  isApprovalWorkItem,
  myWorkItemAnchorId,
  myWorkViewHref,
  pickNextAction,
  summarizeMyWork,
  type MyWorkApproval,
  type MyWorkFocusNotice,
  type MyWorkItem,
  type MyWorkProposal,
  type MyWorkView,
  type NextAction,
  type SubmitFeedback,
  type WorkItemUiAction,
} from './mywork-model';
import { useOperationsRealtime } from './use-operations-realtime';

export interface MyWorkBoardProps {
  user: { id: string; name: string };
  view: MyWorkView;
  /** Open work of the user (owner or backup), most urgent first. */
  openItems: MyWorkItem[];
  /** Recently closed work; only loaded for the "Terminados" view. */
  closedItems: MyWorkItem[] | null;
  /** More open work than the page loads. */
  openTruncated: boolean;
  approvals: MyWorkApproval[];
  proposals: MyWorkProposal[];
  /** Parts of the page that could not load (shown as notices). */
  warnings: string[];
  /** Server time of the render, so due labels match on hydration. */
  nowIso: string;
  /** `assistant.use`: without it there is no copilot panel nor automatic analyses. */
  canUseAssistant: boolean;
  /** `inventory.count`: the copilot offers to register a count. */
  canCount: boolean;
  /** Latest change of the user's work made by someone else (drives the copilot re-analysis). */
  activityAt: string | null;
  /** Work item named by a notification: scrolled into view and highlighted. */
  focusWorkItemId: string | null;
  /** The notified work item is not among the open ones. */
  focusNotice: MyWorkFocusNotice | null;
}

const WIDE_QUERY = '(min-width: 1024px)';
const POLL_INTERVAL_MS = 120_000;
const CLOCK_INTERVAL_MS = 60_000;

const ACTION_ICONS: Record<WorkItemUiAction, React.ReactNode> = {
  start: <Play size={14} />,
  complete: <CheckCircle2 size={14} />,
  wait: <PauseCircle size={14} />,
  escalate: <ArrowUpRight size={14} />,
};

const DUE_TONE_CLASS = { danger: 'font-medium text-destructive', warning: 'font-medium text-warning', default: '' } as const;

const fmt = (n: number) => n.toLocaleString('es-MX');

/** `null` until the browser answers (server render and hydration), then the media query result. */
function useMediaMatch(query: string): boolean | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query]
  );
  return useSyncExternalStore<boolean | null>(
    subscribe,
    () => window.matchMedia(query).matches,
    () => null
  );
}

function notify(feedback: SubmitFeedback): void {
  if (feedback.kind === 'success') toast.success(feedback.message);
  else if (feedback.kind === 'queued') toast.info(feedback.message);
  else if (feedback.kind === 'conflict') toast.warning(feedback.message);
  else toast.error(feedback.message);
}

/** "Mi trabajo": KPIs, next action, the user's work (table ≥768 px, cards below), approvals and the copilot. */
export function MyWorkBoard({
  user,
  view,
  openItems,
  closedItems,
  openTruncated,
  approvals,
  proposals,
  warnings,
  nowIso,
  canUseAssistant,
  canCount,
  activityAt,
  focusWorkItemId,
  focusNotice,
}: MyWorkBoardProps) {
  const router = useRouter();
  const { submit, pending: pendingCommands, online, lastFlushAt } = useOfflineCommandQueue(user.id);
  const [now, setNow] = useState(() => new Date(nowIso));
  const [dialog, setDialog] = useState<PendingWorkAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const wide = useMediaMatch(WIDE_QUERY);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback(
    (delayMs = 600) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        router.refresh();
      }, delayMs);
    },
    [router]
  );

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    []
  );

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(new Date());
      scheduleRefresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(clock);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router, scheduleRefresh]);

  // Commands queued offline were just sent: show their effect.
  useEffect(() => {
    if (lastFlushAt) scheduleRefresh();
  }, [lastFlushAt, scheduleRefresh]);

  const onRealtime = useCallback(() => scheduleRefresh(1500), [scheduleRefresh]);
  useOperationsRealtime([`user:${user.id}`], MYWORK_REALTIME_TYPES, onRealtime);

  const runCommand = useCallback(
    async (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string): Promise<boolean> => {
      let feedback: SubmitFeedback;
      try {
        feedback = describeSubmitOutcome(await submit(input), successMessage);
      } catch (err) {
        feedback = {
          kind: 'error',
          message: err instanceof Error ? err.message : 'No se pudo enviar la acción',
          refresh: false,
        };
      }
      notify(feedback);
      if (feedback.refresh) scheduleRefresh(300);
      return feedback.kind === 'success' || feedback.kind === 'queued';
    },
    [submit, scheduleRefresh]
  );

  const handleAction = useCallback(
    async (action: WorkItemUiAction, item: MyWorkItem) => {
      if (action !== 'start') {
        setDialog({ action, item });
        return;
      }
      setBusyId(item.id);
      try {
        await runCommand(buildWorkItemCommand('start', item), WORK_ITEM_ACTION_SUCCESS.start);
      } finally {
        setBusyId(null);
      }
    },
    [runCommand]
  );

  const summary = useMemo(() => summarizeMyWork(openItems, user.id, now), [openItems, user.id, now]);
  const next = useMemo(() => pickNextAction(openItems, user.id, now), [openItems, user.id, now]);
  const rows = view === 'closed' ? (closedItems ?? []) : openItems;

  // A notification opened the page on one work item: bring its visible row (table or card) into view.
  useEffect(() => {
    if (!focusWorkItemId) return;
    const anchor = myWorkItemAnchorId(focusWorkItemId);
    const target = Array.from(document.querySelectorAll<HTMLElement>(`[data-anchor="${anchor}"]`)).find(
      (el) => el.offsetParent !== null
    );
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusWorkItemId, wide]);

  const contextSource = useRef({ items: openItems, view });
  useEffect(() => {
    contextSource.current = { items: openItems, view };
  }, [openItems, view]);
  const copilotContext = useCallback(
    () => buildMyWorkCopilotContext(contextSource.current.items, contextSource.current.view, new Date()),
    []
  );

  const renderCopilot = (onBack?: () => void) => (
    <MyWorkCopilotPanel
      user={user}
      activityAt={activityAt}
      canCount={canCount}
      context={copilotContext}
      onAfterTurn={() => scheduleRefresh(1000)}
      onBack={onBack}
    />
  );
  const mobileCopilot = canUseAssistant && wide === false;

  return (
    <>
      <div
        className={[
          'grid gap-4 lg:items-start',
          canUseAssistant ? 'lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]' : '',
          // Room under the last actions for the floating "IA" button on phones.
          mobileCopilot ? 'pb-20' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="grid min-w-0 gap-4">
          {!online || pendingCommands > 0 ? (
            <Alert variant={online ? 'info' : 'warning'}>
              {online
                ? `${pendingCommands} ${pendingCommands === 1 ? 'acción pendiente' : 'acciones pendientes'} de enviar.`
                : `Sin conexión${pendingCommands > 0 ? ` · ${pendingCommands} pendientes` : ''}. Tus acciones se enviarán al reconectar.`}
            </Alert>
          ) : null}
          {warnings.map((warning) => (
            <Alert key={warning} variant="warning">
              {warning}
            </Alert>
          ))}
          {focusNotice ? (
            <Alert variant="info">
              {focusNotice.kind === 'closed' ? (
                <>
                  Este trabajo ya fue terminado{focusNotice.title ? `: ${focusNotice.title}` : ''}.{' '}
                  <Link href={myWorkViewHref('closed')}>Ver terminados recientes</Link>
                </>
              ) : (
                'No encontramos ese trabajo entre tus pendientes: pudo reasignarse o ya no te corresponde.'
              )}
            </Alert>
          ) : null}

          <KpiGrid columns={4}>
            <StatCard
              label="Pendientes"
              value={fmt(summary.total)}
              hint={summary.asBackup > 0 ? `${fmt(summary.asBackup)} como suplente` : 'Todos a tu cargo'}
              icon={<ListChecks size={20} />}
            />
            <StatCard
              label="Vencidos"
              value={fmt(summary.overdue)}
              hint={summary.overdue > 0 ? 'Atiéndelos primero' : 'Nada vencido'}
              tone={summary.overdue > 0 ? 'danger' : 'success'}
              icon={<AlertTriangle size={20} />}
            />
            <StatCard
              label="Vencen hoy"
              value={fmt(summary.dueToday)}
              tone={summary.dueToday > 0 ? 'warning' : 'default'}
              icon={<Clock size={20} />}
            />
            <StatCard
              label="En curso"
              value={fmt(summary.inProgress)}
              hint={`${fmt(summary.waiting)} en espera`}
              icon={<Timer size={20} />}
            />
          </KpiGrid>

          <NextActionCard next={next} now={now} busy={busyId !== null && busyId === next?.item.id} onAction={handleAction} />

          <TabNav
            activeId={view}
            tabs={[
              { id: 'open', label: `Pendientes (${fmt(openItems.length)}${openTruncated ? '+' : ''})`, href: myWorkViewHref('open') },
              { id: 'closed', label: 'Terminados recientes', href: myWorkViewHref('closed') },
            ]}
          />
          {view === 'open' && openTruncated ? (
            <p className="text-muted text-sm">Mostramos tus 200 pendientes que vencen primero.</p>
          ) : null}

          {rows.length === 0 ? (
            <EmptyState
              icon={view === 'open' ? 'check' : 'layers'}
              title={view === 'open' ? 'No tienes pendientes' : 'Sin trabajos terminados recientes'}
              message={
                view === 'open'
                  ? 'Cuando te asignen un trabajo o cubras a alguien como suplente, aparecerá aquí.'
                  : 'Aquí verás los trabajos que terminaste o se cancelaron.'
              }
            />
          ) : (
            <>
              <WorkTable rows={rows} view={view} now={now} busyId={busyId} focusId={focusWorkItemId} onAction={handleAction} />
              <WorkCards rows={rows} view={view} now={now} busyId={busyId} focusId={focusWorkItemId} onAction={handleAction} />
            </>
          )}

          <MyWorkApprovals
            approvals={approvals}
            proposals={proposals}
            onSubmit={runCommand}
            onChanged={() => scheduleRefresh(500)}
          />
        </div>

        {wide && canUseAssistant ? (
          <aside
            aria-label="Copiloto de Mi trabajo"
            className="sticky top-4 flex h-[calc(100dvh-8rem)] min-h-[520px] flex-col overflow-hidden rounded-lg border border-border bg-card"
          >
            {renderCopilot()}
          </aside>
        ) : null}
      </div>

      {mobileCopilot ? (
        <>
          <Button
            type="button"
            className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 shadow-lg"
            icon={<Sparkles size={16} />}
            aria-haspopup="dialog"
            onClick={() => setCopilotOpen(true)}
          >
            IA
          </Button>
          <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
            <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md" showCloseButton={false}>
              <SheetTitle className="sr-only">Copiloto de Mi trabajo</SheetTitle>
              <SheetDescription className="sr-only">
                Pregúntale a la IA qué hacer primero o pídele registrar un avance.
              </SheetDescription>
              {copilotOpen ? (
                <div className="flex min-h-0 flex-1 flex-col">{renderCopilot(() => setCopilotOpen(false))}</div>
              ) : null}
            </SheetContent>
          </Sheet>
        </>
      ) : null}

      {dialog ? (
        <MyWorkActionDialog
          key={`${dialog.action}:${dialog.item.id}`}
          pending={dialog}
          now={now}
          online={online}
          onClose={() => setDialog(null)}
          onSubmit={runCommand}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

type ActionHandler = (action: WorkItemUiAction, item: MyWorkItem) => void | Promise<void>;

function NextActionCard({
  next,
  now,
  busy,
  onAction,
}: {
  next: NextAction<MyWorkItem> | null;
  now: Date;
  busy: boolean;
  onAction: ActionHandler;
}) {
  if (!next) {
    return (
      <section className="card grid gap-1" aria-labelledby="mywork-next-title">
        <p className="text-muted text-xs font-medium uppercase">Mi siguiente acción</p>
        <h2 id="mywork-next-title" className="card-title">
          Estás al día
        </h2>
        <p className="text-muted text-sm">No tienes trabajo pendiente a tu cargo. Cuando te asignen algo aparecerá aquí.</p>
      </section>
    );
  }
  const { item, reason } = next;
  const actions = availableActions(item);
  const primary: WorkItemUiAction | null =
    item.status !== 'in_progress' && actions.includes('start')
      ? 'start'
      : actions.includes('complete')
        ? 'complete'
        : null;
  const blocked = primary === 'complete' ? completionRequirements(item).blockedReason : null;
  const due = formatDueLabel(item.dueAt, now);
  const caseHref = operationsCaseHref(item.caseId);
  return (
    <section className="card grid gap-3 border-l-4 border-l-primary" aria-labelledby="mywork-next-title">
      <div className="grid min-w-0 gap-1">
        <p className="text-muted text-xs font-medium uppercase">Mi siguiente acción</p>
        <h2 id="mywork-next-title" className="card-title break-words">
          {item.title}
        </h2>
        <p className="text-muted text-sm">
          {NEXT_ACTION_REASON_LABELS[reason]} ·{' '}
          <time dateTime={item.dueAt} title={due.title} className={DUE_TONE_CLASS[due.tone]}>
            {due.label}
          </time>{' '}
          · {item.areaLabel}
          {item.customerName ? ` · ${item.customerName}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {isApprovalWorkItem(item) ? (
          <a href="#aprobaciones" className="btn btn-primary btn-sm">
            Decidir aprobación
          </a>
        ) : primary ? (
          <Button
            type="button"
            size="sm"
            icon={ACTION_ICONS[primary]}
            isLoading={busy}
            disabled={Boolean(blocked)}
            aria-describedby={blocked ? 'mywork-next-blocked' : undefined}
            onClick={() => void onAction(primary, item)}
          >
            {WORK_ITEM_ACTION_LABELS[primary]}
          </Button>
        ) : null}
        {caseHref ? (
          <Link href={caseHref} className="btn btn-secondary btn-sm">
            Ver expediente {item.caseNumber ?? ''}
          </Link>
        ) : item.caseNumber ? (
          <span className="text-muted self-center text-sm">Expediente {item.caseNumber}</span>
        ) : null}
      </div>
      {blocked ? (
        <p id="mywork-next-blocked" className="text-muted text-xs">
          {blocked}
        </p>
      ) : null}
    </section>
  );
}

function WorkTitle({ item }: { item: MyWorkItem }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="font-medium break-words">{item.title}</span>
      <span className="text-muted text-xs">
        {item.kindLabel}
        {item.role === 'backup' ? ` · Como suplente de ${item.ownerName ?? 'otra persona'}` : ''}
        {item.escalatedAt ? ' · Escalado' : ''}
      </span>
      {item.status === 'waiting' && item.waitReason ? (
        <span className="text-muted text-xs">En espera: {item.waitReason}</span>
      ) : null}
    </div>
  );
}

function StatusBadge({ item }: { item: MyWorkItem }) {
  return <Badge variant={WORK_ITEM_STATUS_BADGE[item.status] ?? 'default'}>{item.statusLabel}</Badge>;
}

function DueText({ item, now, view }: { item: MyWorkItem; now: Date; view: MyWorkView }) {
  if (view === 'closed') {
    const at = item.completedAt ?? item.updatedAt;
    return <time dateTime={at}>{formatDateTime(at)}</time>;
  }
  const due = formatDueLabel(item.dueAt, now);
  return (
    <time dateTime={item.dueAt} title={due.title} className={DUE_TONE_CLASS[due.tone]}>
      {due.label}
    </time>
  );
}

function CaseRef({ item }: { item: MyWorkItem }) {
  if (!item.caseId) return <span className="text-muted">Sin expediente</span>;
  const href = operationsCaseHref(item.caseId);
  return (
    <span className="grid gap-0.5">
      {href ? (
        <Link href={href} className="font-medium">
          {item.caseNumber ?? 'Ver expediente'}
        </Link>
      ) : (
        <span className="font-medium">{item.caseNumber ?? 'Expediente'}</span>
      )}
      {item.customerName ? <span className="text-muted text-xs">{item.customerName}</span> : null}
    </span>
  );
}

function RowActions({
  item,
  busy,
  stacked,
  onAction,
}: {
  item: MyWorkItem;
  busy: boolean;
  stacked?: boolean;
  onAction: ActionHandler;
}) {
  if (isApprovalWorkItem(item)) {
    return (
      <a href="#aprobaciones" className="btn btn-secondary btn-sm">
        Decidir
      </a>
    );
  }
  const actions = availableActions(item);
  if (actions.length === 0) return <span className="text-muted text-xs">Sin acciones</span>;
  // Structured evidence comes from another flow (count, reservation, receipt…): until it exists,
  // "Completar" is disabled and says what produces it instead of failing on the server.
  const blocked = actions.includes('complete') ? completionRequirements(item).blockedReason : null;
  const blockedId = `mywork-blocked-${item.id}${stacked ? '-card' : ''}`;
  return (
    <div className="grid gap-1">
      <div className={stacked ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap justify-end gap-1'}>
        {actions.map((action) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant={action === 'complete' ? 'primary' : action === 'escalate' ? 'ghost' : 'secondary'}
            icon={ACTION_ICONS[action]}
            isLoading={busy && action === 'start'}
            disabled={busy || (action === 'complete' && Boolean(blocked))}
            aria-describedby={action === 'complete' && blocked ? blockedId : undefined}
            aria-label={`${WORK_ITEM_ACTION_LABELS[action]}: ${item.title}`}
            onClick={() => void onAction(action, item)}
          >
            {WORK_ITEM_ACTION_LABELS[action]}
          </Button>
        ))}
      </div>
      {blocked ? (
        <p id={blockedId} className={`text-muted text-xs ${stacked ? '' : 'text-right'}`}>
          {blocked}
        </p>
      ) : null}
    </div>
  );
}

interface ListProps {
  rows: MyWorkItem[];
  view: MyWorkView;
  now: Date;
  busyId: string | null;
  /** Work item of the notification that opened the page. */
  focusId: string | null;
  onAction: ActionHandler;
}

function WorkTable({ rows, view, now, busyId, focusId, onAction }: ListProps) {
  return (
    <div className="table-wrap hidden md:block">
      <table className="table">
        <caption className="sr-only">
          {view === 'open' ? 'Mis trabajos pendientes' : 'Mis trabajos terminados recientemente'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Trabajo</th>
            <th scope="col">Estado</th>
            <th scope="col">{view === 'open' ? 'Vence' : 'Terminado'}</th>
            <th scope="col">Expediente</th>
            <th scope="col">Área</th>
            {view === 'open' ? (
              <th scope="col">
                <span className="sr-only">Acciones</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr
              key={item.id}
              data-anchor={myWorkItemAnchorId(item.id)}
              aria-current={focusId === item.id ? 'true' : undefined}
              className={focusId === item.id ? 'bg-[var(--unik-brand-subtle)] outline outline-2 outline-[var(--unik-brand)]' : undefined}
            >
              <td className="min-w-[220px]">
                <WorkTitle item={item} />
              </td>
              <td>
                <StatusBadge item={item} />
              </td>
              <td className="whitespace-nowrap">
                <DueText item={item} now={now} view={view} />
              </td>
              <td>
                <CaseRef item={item} />
              </td>
              <td className="whitespace-nowrap">{item.areaLabel}</td>
              {view === 'open' ? (
                <td>
                  <RowActions item={item} busy={busyId === item.id} onAction={onAction} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkCards({ rows, view, now, busyId, focusId, onAction }: ListProps) {
  return (
    <ul className="grid gap-3 md:hidden" aria-label={view === 'open' ? 'Mis trabajos pendientes' : 'Mis trabajos terminados'}>
      {rows.map((item) => (
        <li
          key={item.id}
          data-anchor={myWorkItemAnchorId(item.id)}
          aria-current={focusId === item.id ? 'true' : undefined}
          className={`card grid gap-2${focusId === item.id ? ' border-[var(--unik-brand)] ring-2 ring-[var(--unik-brand)]' : ''}`}
        >
          <div className="flex items-start justify-between gap-2">
            <WorkTitle item={item} />
            <StatusBadge item={item} />
          </div>
          <div className="flex flex-wrap items-start gap-x-4 gap-y-1 text-sm">
            <DueText item={item} now={now} view={view} />
            <span className="text-muted">{item.areaLabel}</span>
            <CaseRef item={item} />
          </div>
          {view === 'open' ? (
            <RowActions item={item} busy={busyId === item.id} stacked onAction={onAction} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

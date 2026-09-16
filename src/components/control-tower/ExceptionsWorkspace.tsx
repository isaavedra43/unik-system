'use client';

import React, { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import { describeSubmitOutcome, formatDueLabel } from '@/components/operations/mywork-model';
import { operationsCaseHref } from '@/components/operations/copilot-starters';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { Badge, Button } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AREA_WORK_REALTIME_TYPES } from '@/modules/areas/area-work-row';
import type { CtExceptionRow } from '@/modules/control-tower/exceptions-service';
import type {
  BulkWatchAction,
  CreateViewAction,
  EntityColumnDefinition,
  EntityListResult,
  ExportAction,
  ResetPreferenceAction,
  SavePreferenceAction,
  TablePreferenceConfig,
  TableViewRow,
  WatchAction,
} from '@/modules/shared/entity-workspace-types';
import { CONTROL_TOWER_AREA_CHANNELS } from './control-tower-views';
import {
  CT_EXCEPTIONS_BASE_PATH,
  CT_EXCEPTIONS_TABLE_KEY,
  CT_EXCEPTION_ACTIONS_COLUMN_ID,
  CT_EXCEPTION_COLUMNS,
  CT_EXCEPTION_COLUMN_MAP,
  CT_EXCEPTION_DEFAULT_COLUMN_ORDER,
} from './exceptions-columns';
import {
  exceptionExtraUrlParams,
  exceptionKindChips,
  exceptionSeverityChips,
  exceptionSeverityTone,
  type CtExceptionChipState,
  type CtExceptionQueryState,
} from './exceptions-model';
import {
  exceptionActions,
  noExceptionActionsReason,
  type ExceptionActor,
} from './exception-actions';
import {
  ExceptionActionDialog,
  type ExceptionAssignee,
  type PendingExceptionAction,
} from './ExceptionActionDialog';

/**
 * Exceptions of the operation (plan 7.7 `excepciones`): the shared
 * `EntityWorkspace` over the union of everything that went off the rails, with
 * filter chips in the URL and the real commands of the core behind each row.
 *
 * Nothing about the business lives here: rows come from `exceptions-service`,
 * the actions are decided by `exception-actions.ts` and executed by
 * `POST /app/operations/api/commands` (offline queue behind it), which checks
 * the permissions again.
 */

export interface ExceptionsWorkspaceProps {
  user: CurrentUser;
  initialData: EntityListResult<CtExceptionRow>;
  initialQuery: CtExceptionQueryState;
  chips: CtExceptionChipState;
  counts: ReadonlyArray<{ kind: string; label: string; count: number }>;
  preference: TablePreferenceConfig;
  views: { privateViews: TableViewRow[]; sharedViews: TableViewRow[] };
  defaultViewId: string | null;
  unreadNotifications: number;
  /**
   * Whoever operates the core (`OPERATIONS_OPERATOR_PERMISSIONS`:
   * `operations.manage` or `operations.admin`) — the keys the engine accepts.
   * Someone without them still acts on the rows they are responsible for.
   */
  canManage: boolean;
  canShareViews: boolean;
  assignees: ExceptionAssignee[];
  savePreferenceAction: SavePreferenceAction;
  resetPreferenceAction: ResetPreferenceAction;
  createViewAction: CreateViewAction;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
  bulkWatchAction: BulkWatchAction;
  exportAction: ExportAction;
  /** Server time of the render, so due labels match on hydration. */
  nowIso: string;
}

export function ExceptionsWorkspace(props: ExceptionsWorkspaceProps) {
  const { user, initialData, initialQuery, chips, counts, canManage, nowIso } = props;
  const router = useRouter();
  const { submit, online } = useOfflineCommandQueue(user.id);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [tableVersion, setTableVersion] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingExceptionAction | null>(null);
  const now = useMemo(() => new Date(Date.parse(nowIso) || Date.now()), [nowIso]);

  useOperationsRealtime(
    CONTROL_TOWER_AREA_CHANNELS,
    AREA_WORK_REALTIME_TYPES,
    useCallback(() => setPendingEvents((value) => value + 1), [])
  );

  const refresh = useCallback(() => {
    setPendingEvents(0);
    setTableVersion((value) => value + 1);
    router.refresh();
  }, [router]);

  const actor = useMemo<ExceptionActor>(
    () => ({
      id: user.id,
      permissionKeys: user.permissionKeys as string[],
      isSuperAdmin: user.isSuperAdmin,
    }),
    [user.id, user.permissionKeys, user.isSuperAdmin]
  );

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

  const renderCell = useCallback(
    (row: CtExceptionRow, column: EntityColumnDefinition): React.ReactNode => {
      if (column.id === CT_EXCEPTION_ACTIONS_COLUMN_ID) {
        const actions = exceptionActions(row, actor);
        if (actions.length === 0) {
          const reason = noExceptionActionsReason(row, actor);
          return (
            <span className="text-muted" title={reason ?? undefined}>
              —
            </span>
          );
        }
        return (
          <span
            className="ct-row-actions"
            onClick={(event) => event.stopPropagation()}
            role="presentation"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Acciones de ${row.title}`}
                  title="Acciones"
                >
                  <MoreHorizontal size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {actions.map((action) => (
                  <DropdownMenuItem
                    key={action.id}
                    variant={action.tone === 'danger' ? 'destructive' : 'default'}
                    onSelect={() => setPendingAction({ row, action })}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        );
      }

      switch (column.id) {
        case 'kindLabel':
          return <span className="ct-cell-strong">{row.kindLabel}</span>;
        case 'title':
          return (
            <span>
              <span className="ct-cell-strong">{row.title}</span>
              {row.detail ? <span className="ct-cell-sub">{row.detail}</span> : null}
            </span>
          );
        case 'severityLabel':
          return <Badge variant={exceptionSeverityTone(row.severity)}>{row.severityLabel}</Badge>;
        case 'areaLabel':
          return row.areaLabel;
        case 'ownerName':
          return row.ownerName ?? <span className="text-muted">Sin asignar</span>;
        case 'dueAt': {
          if (!row.dueAt) return <span className="text-muted">—</span>;
          const due = formatDueLabel(row.dueAt, now);
          return (
            <span
              className={
                due.tone === 'danger'
                  ? 'ct-tone-danger'
                  : due.tone === 'warning'
                    ? 'ct-tone-warning'
                    : undefined
              }
              title={due.title}
            >
              {due.label}
            </span>
          );
        }
        case 'since':
          return formatDueLabel(row.since, now, { closed: true }).label;
        case 'caseNumber': {
          if (!row.caseId || !row.caseNumber) {
            return <span className="text-muted">—</span>;
          }
          const href = operationsCaseHref(row.caseId);
          return href ? <Link href={href}>{row.caseNumber}</Link> : <span>{row.caseNumber}</span>;
        }
        case 'customerName':
          return row.customerName ?? <span className="text-muted">—</span>;
        case 'detail':
          return row.detail ?? <span className="text-muted">—</span>;
        case 'status':
          return row.status;
        default:
          return null;
      }
    },
    [actor, now]
  );

  const toolbarExtra = (
    <>
      <div className="ct-chips" role="group" aria-label="Filtros de excepciones">
        <div className="ct-chip-group">
          <span className="ct-chip-group-label" aria-hidden="true">
            Tipo
          </span>
          {exceptionKindChips(chips, counts).map((chip) => (
            <Link
              key={chip.id}
              href={chip.href}
              className={`ct-chip ${chip.active ? 'ct-chip-active' : ''}`}
              aria-current={chip.active ? 'true' : undefined}
              scroll={false}
            >
              {chip.label}
            </Link>
          ))}
        </div>
        <div className="ct-chip-group">
          <span className="ct-chip-group-label" aria-hidden="true">
            Severidad
          </span>
          {exceptionSeverityChips(chips).map((chip) => (
            <Link
              key={chip.id}
              href={chip.href}
              className={`ct-chip ${chip.active ? 'ct-chip-active' : ''}`}
              aria-current={chip.active ? 'true' : undefined}
              scroll={false}
            >
              {chip.label}
            </Link>
          ))}
        </div>
      </div>
      {pendingEvents > 0 ? (
        <div className="ct-chips" role="status">
          <Button variant="secondary" size="sm" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />
            {pendingEvents === 1
              ? 'Hay 1 movimiento nuevo · Actualizar'
              : `Hay ${pendingEvents} movimientos nuevos · Actualizar`}
          </Button>
        </div>
      ) : null}
      {!canManage ? (
        <p className="ct-view-description">
          Ves todas las excepciones, pero para actuar sobre cualquiera hace falta gestionar o
          administrar operaciones; sin eso sólo puedes actuar sobre los pendientes de los que eres
          la persona responsable.
        </p>
      ) : null}
    </>
  );

  return (
    <div className="ct-exceptions">
      <EntityWorkspace<CtExceptionRow>
        key={tableVersion}
        user={user}
        tableKey={CT_EXCEPTIONS_TABLE_KEY}
        entityLabel="Excepción"
        entityLabelPlural="Excepciones"
        entityGender="f"
        basePath={CT_EXCEPTIONS_BASE_PATH}
        permissionView="operations.admin"
        permissionExport="operations.admin"
        permissionWatch="operations.admin"
        permissionShareViews="operations.admin"
        initialData={initialData}
        initialQuery={initialQuery}
        preference={props.preference}
        views={props.views}
        defaultViewId={props.defaultViewId}
        watchedIds={new Set<string>()}
        unreadNotifications={props.unreadNotifications}
        canExport
        canWatch={false}
        canShareViews={props.canShareViews}
        columns={CT_EXCEPTION_COLUMNS}
        columnMap={CT_EXCEPTION_COLUMN_MAP}
        defaultColumnOrder={CT_EXCEPTION_DEFAULT_COLUMN_ORDER}
        renderCell={renderCell}
        nameField="title"
        searchPlaceholder="Buscar excepción, expediente o cliente…"
        savePreferenceAction={props.savePreferenceAction}
        resetPreferenceAction={props.resetPreferenceAction}
        createViewAction={props.createViewAction}
        watchAction={props.watchAction}
        unwatchAction={props.unwatchAction}
        bulkWatchAction={props.bulkWatchAction}
        exportAction={props.exportAction}
        toolbarExtra={toolbarExtra}
        extraUrlParams={exceptionExtraUrlParams(chips)}
      />

      {pendingAction ? (
        <ExceptionActionDialog
          pending={pendingAction}
          assignees={props.assignees}
          online={online}
          onClose={() => setPendingAction(null)}
          onSubmit={runCommand}
        />
      ) : null}
    </div>
  );
}

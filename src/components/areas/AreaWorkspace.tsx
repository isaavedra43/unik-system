'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { AreaCopilotPanel } from '@/components/operations/AreaCopilotPanel';
import { useOperationsRealtime } from '@/components/operations/use-operations-realtime';
import { describeSubmitOutcome, formatDueLabel } from '@/components/operations/mywork-model';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/shadcn/sheet';
import { Badge, Button } from '@/components/ui/primitives';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useWideScreen } from '@/hooks/use-wide-screen';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { AreaClientMeta } from '@/modules/areas/area-registry';
import {
  AREA_WORK_REALTIME_TYPES,
  rowKindLabel,
  type AreaWorkRow,
} from '@/modules/areas/area-work-row';
import { getRowActions } from '@/modules/areas/work-actions';
import { AREA_ACTIONS_COLUMN_ID, extraFieldKey } from '@/modules/areas/work-columns';
import type { AreaWorkQueryState, AreaWorkScope } from '@/modules/areas/work-filters';
import type {
  BulkWatchAction,
  CreateViewAction,
  EntityColumnDefinition,
  EntityListResult,
  EntityQueryState,
  ExportAction,
  ResetPreferenceAction,
  SavePreferenceAction,
  TablePreferenceConfig,
  TableViewRow,
  WatchAction,
} from '@/modules/shared/entity-workspace-types';
import { AreaActionDialog, type PendingRowAction } from './AreaActionDialog';
import { AreaRowPreviewDrawer } from './AreaRowPreviewDrawer';
import { AreaWorkChips } from './AreaWorkChips';
import { AreaWorkMobile } from './AreaWorkMobile';
import { getAreaClient } from './area-client-registry';
import { ensureAreaClientRegistrations } from './register-all-client';
import {
  areaActivityAt,
  buildAreaCopilotContext,
  rowKindChips,
  scopeChips,
} from './area-workspace-model';

/**
 * Work centre of an area (plan 7.4): the shared `EntityWorkspace` with the area
 * work rows, filter chips, an actions column that runs the engine's commands,
 * the row drawer and the area copilot watching the same table.
 *
 * Nothing about the business lives here: rows come from the area API, actions
 * are decided by `work-actions.ts` and executed by `POST /app/operations/api/commands`
 * (with the offline queue behind it), and the copilot is the shared panel.
 */

export interface AreaWorkspaceProps {
  user: CurrentUser;
  area: AreaClientMeta;
  /** Space being shown: the work centre or one of the area's subpages. */
  spaceSlug: string;
  basePath: string;
  /** Row kinds with a branch behind them right now. */
  rowKinds: string[];
  initialData: EntityListResult<AreaWorkRow>;
  areaQuery: AreaWorkQueryState;
  chipState: { kind: string | null; scope: AreaWorkScope; mine: boolean; overdue: boolean };
  preference: TablePreferenceConfig;
  views: { privateViews: TableViewRow[]; sharedViews: TableViewRow[] };
  defaultViewId: string | null;
  watchedIds: string[];
  unreadNotifications: number;
  canExport: boolean;
  /**
   * Keys that open the export of THIS area (`purchases.export` for Compras).
   * The server already decided `canExport` with them; they travel so the table
   * documents the real door instead of the area's view permission.
   */
  exportPermissions: readonly string[];
  canWatch: boolean;
  canShareViews: boolean;
  canUseAssistant: boolean;
  actPermissions: string[];
  columns: EntityColumnDefinition[];
  columnMap: Record<string, EntityColumnDefinition>;
  defaultColumnOrder: string[];
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

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

function formatAmount(value: string | null): string {
  if (value === null) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
}

function formatNumber(value: string | null): string {
  if (value === null) return '—';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('es-MX') : value;
}

export function AreaWorkspace(props: AreaWorkspaceProps) {
  const {
    user,
    area,
    spaceSlug,
    basePath,
    rowKinds,
    initialData,
    areaQuery,
    chipState,
    canUseAssistant,
    actPermissions,
    columns,
    columnMap,
    defaultColumnOrder,
    nowIso,
  } = props;

  const router = useRouter();
  const wide = useWideScreen();
  // ≤768 px: the phone gets the mobile surface instead of the table (plan 7.10).
  const isMobile = useIsMobile();
  const { submit, online } = useOfflineCommandQueue(user.id);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [tableVersion, setTableVersion] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingRowAction | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotVisible, setCopilotVisible] = useState(true);
  const [clientReady, setClientReady] = useState(0);
  const now = useMemo(() => new Date(nowIso), [nowIso]);

  useEffect(() => {
    if (wide !== true || !copilotVisible) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setCopilotVisible(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [wide, copilotVisible]);

  // The area may register its own cells; until then the shared renderer answers.
  useEffect(() => {
    let cancelled = false;
    void ensureAreaClientRegistrations(area.key).then((registered) => {
      if (registered && !cancelled) setClientReady((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [area.key]);

  useOperationsRealtime(
    [`area:${area.key}`],
    AREA_WORK_REALTIME_TYPES,
    useCallback(() => setPendingEvents((value) => value + 1), [])
  );

  const refresh = useCallback(() => {
    setPendingEvents(0);
    setTableVersion((value) => value + 1);
    router.refresh();
  }, [router]);

  const rows = initialData.data;
  const actor = useMemo(
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
    (row: AreaWorkRow, column: EntityColumnDefinition): React.ReactNode => {
      if (column.id === AREA_ACTIONS_COLUMN_ID) {
        const actions = getRowActions(row, actor, { actPermissions });
        if (actions.length === 0) return <span className="text-muted">—</span>;
        return (
          <span
            className="area-row-actions"
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

      const override = getAreaClient(area.key).renderCell?.(row, column);
      if (override !== undefined) return override;

      switch (column.id) {
        case 'rowKind':
          return <span className="area-row-kind">{rowKindLabel(row.rowKind)}</span>;
        case 'title':
          return (
            <span className="area-row-title">
              <span className="area-row-title-main">{row.title}</span>
              {row.customerName || row.caseNumber ? (
                <span className="area-row-sub">
                  {[row.caseNumber, row.customerName].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </span>
          );
        case 'status':
          return <Badge variant={BADGE_BY_TONE[row.statusTone]}>{row.statusLabel}</Badge>;
        case 'dueAt': {
          if (!row.dueAt) return <span className="text-muted">—</span>;
          const due = formatDueLabel(row.dueAt, now, { closed: !row.open });
          const tone =
            due.tone === 'danger'
              ? 'area-row-due-danger'
              : due.tone === 'warning'
                ? 'area-row-due-warning'
                : '';
          return (
            <span className={tone} title={due.title}>
              {due.label}
            </span>
          );
        }
        case 'ownerName':
          return row.ownerName ?? <span className="text-muted">Sin asignar</span>;
        case 'priority':
          return row.priority === 'normal' ? (
            <span className="text-muted">{row.priorityLabel}</span>
          ) : (
            <Badge variant="warning">{row.priorityLabel}</Badge>
          );
        case 'lastActivityAt':
          return formatDueLabel(row.lastActivityAt, now, { closed: true }).label;
        case 'amount':
          return formatAmount(row.amount);
        case 'quantity':
          return formatNumber(row.quantity);
        case 'escalationLevel':
          return row.escalationLevel > 0 ? `Nivel ${row.escalationLevel}` : '—';
        default:
          break;
      }

      const extraKey = extraFieldKey(column.field);
      const value = extraKey
        ? row.extra[extraKey]
        : (row as unknown as Record<string, unknown>)[column.id];
      if (value === null || value === undefined || value === '') {
        return <span className="text-muted">—</span>;
      }
      if (column.type === 'date') {
        return formatDueLabel(String(value), now, { closed: true }).label;
      }
      if (column.type === 'currency') return formatAmount(String(value));
      if (column.type === 'number') return formatNumber(String(value));
      return String(value);
      // `clientReady` re-runs this renderer once the area registers its own cells.
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actor, actPermissions, area.key, now, clientReady]
  );

  /**
   * The workspace keeps this object as its query state and posts it back on
   * every refetch, so the area fields (`kind`, `scope`, `ownerUserId`,
   * `overdueOnly`) survive a search, a sort or a page change.
   */
  const entityQuery: EntityQueryState = areaQuery;

  const extraUrlParams = useMemo(() => {
    const params: Record<string, string> = {};
    if (chipState.kind && chipState.kind !== 'all') params.kind = chipState.kind;
    if (chipState.scope !== 'open') params.scope = chipState.scope;
    if (chipState.mine) params.mios = '1';
    if (chipState.overdue) params.vencidos = '1';
    return params;
  }, [chipState]);

  const copilotContext = useCallback(
    () =>
      buildAreaCopilotContext({
        areaKey: area.key,
        rows,
        total: initialData.pagination.total,
        query: areaQuery,
        selectedIds,
        spaceSlug,
      }),
    [area.key, rows, initialData.pagination.total, areaQuery, selectedIds, spaceSlug]
  );

  const activityAt = useMemo(() => areaActivityAt(rows), [rows]);

  const copilot = canUseAssistant ? (
    <AreaCopilotPanel
      areaKey={area.key as Parameters<typeof AreaCopilotPanel>[0]['areaKey']}
      user={{ id: user.id, name: user.name }}
      activityAt={activityAt}
      context={copilotContext}
      starters={area.copilotStarters}
      onAfterTurn={refresh}
      {...(wide === false ? { onBack: () => setCopilotOpen(false) } : {})}
      {...(wide === true ? { onClose: () => setCopilotVisible(false) } : {})}
    />
  ) : null;

  const chips = (
    <AreaWorkChips
      groups={[
        {
          label: 'Tipo',
          chips: rowKindChips({ basePath, rowKinds, current: chipState }),
        },
        { label: 'Estado', chips: scopeChips({ basePath, rowKinds, current: chipState }) },
      ]}
      ariaLabel={`Filtros de ${area.label}`}
    />
  );

  const toolbarExtra = (
    <>
      {chips}
      {pendingEvents > 0 || (canUseAssistant && (wide === false || !copilotVisible)) ? (
        <div className="area-chips" role="group" aria-label="Novedades del área">
          {pendingEvents > 0 ? (
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw size={14} aria-hidden="true" />
              {pendingEvents === 1
                ? 'Hay 1 movimiento nuevo · Actualizar'
                : `Hay ${pendingEvents} movimientos nuevos · Actualizar`}
            </Button>
          ) : null}
          {canUseAssistant && (wide === false || !copilotVisible) ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (wide === false) setCopilotOpen(true);
                else setCopilotVisible(true);
              }}
            >
              <Sparkles size={14} aria-hidden="true" />
              IA del área
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  return (
    <div className="area-workspace">
      <div className="area-workspace-main">
        {isMobile ? (
          <AreaWorkMobile
            user={{ id: user.id, name: user.name }}
            area={area}
            rows={rows}
            total={initialData.pagination.total}
            now={now}
            actor={actor}
            actPermissions={actPermissions}
            canUseAssistant={canUseAssistant}
            online={online}
            pendingEvents={pendingEvents}
            onRefresh={refresh}
            onAction={(row, action) => setPendingAction({ row, action })}
            onRunCommand={runCommand}
            copilotContext={copilotContext}
            activityAt={activityAt}
            chips={chips}
            renderDetail={(rowId, onClose) => (
              <AreaRowPreviewDrawer
                areaKey={area.key}
                areaLabel={area.label}
                rowId={rowId}
                entityLabel={area.entityLabel}
                actor={actor}
                actPermissions={actPermissions}
                canWatch={props.canWatch}
                isWatched={props.watchedIds.includes(rowId)}
                online={online}
                onClose={onClose}
                onWatchChange={() => undefined}
                watchAction={props.watchAction}
                unwatchAction={props.unwatchAction}
                onAction={(row, action) => setPendingAction({ row, action })}
                refreshToken={tableVersion}
              />
            )}
          />
        ) : (
          <EntityWorkspace<AreaWorkRow>
            key={tableVersion}
            user={user}
            tableKey={area.tableKey}
            entityLabel={area.entityLabel}
            entityLabelPlural={area.entityLabelPlural}
            basePath={basePath}
            permissionView="operations.view"
            permissionExport={props.exportPermissions[0] ?? 'operations.view'}
            permissionWatch="operations.view"
            permissionShareViews="operations.view"
            initialData={initialData}
            initialQuery={entityQuery}
            preference={props.preference}
            views={props.views}
            defaultViewId={props.defaultViewId}
            watchedIds={new Set(props.watchedIds)}
            unreadNotifications={props.unreadNotifications}
            canExport={props.canExport}
            canWatch={props.canWatch}
            canShareViews={props.canShareViews}
            columns={columns}
            columnMap={columnMap}
            defaultColumnOrder={defaultColumnOrder}
            renderCell={renderCell}
            nameField="title"
            searchPlaceholder={`Buscar en ${area.label.toLowerCase()}…`}
            savePreferenceAction={props.savePreferenceAction}
            resetPreferenceAction={props.resetPreferenceAction}
            createViewAction={props.createViewAction}
            watchAction={props.watchAction}
            unwatchAction={props.unwatchAction}
            bulkWatchAction={props.bulkWatchAction}
            exportAction={props.exportAction}
            toolbarExtra={toolbarExtra}
            extraUrlParams={extraUrlParams}
            onSelectionChange={setSelectedIds}
            renderPreviewDrawer={({ entityId, onClose, isWatched, onWatchChange }) => (
              <AreaRowPreviewDrawer
                areaKey={area.key}
                areaLabel={area.label}
                rowId={entityId}
                entityLabel={area.entityLabel}
                actor={actor}
                actPermissions={actPermissions}
                canWatch={props.canWatch}
                isWatched={isWatched}
                online={online}
                onClose={onClose}
                onWatchChange={onWatchChange}
                watchAction={props.watchAction}
                unwatchAction={props.unwatchAction}
                onAction={(row, action) => setPendingAction({ row, action })}
                refreshToken={tableVersion}
              />
            )}
          />
        )}
      </div>

      {!isMobile && wide === true && copilotVisible && copilot ? (
        <aside className="area-workspace-aside">{copilot}</aside>
      ) : null}

      {!isMobile && copilot && wide === false ? (
        <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
          <SheetContent side="right" className="w-full max-w-md p-0">
            <SheetTitle className="sr-only">{`IA de ${area.label}`}</SheetTitle>
            <SheetDescription className="sr-only">
              Copiloto del área sobre el trabajo visible
            </SheetDescription>
            <div className="area-copilot-sheet">{copilot}</div>
          </SheetContent>
        </Sheet>
      ) : null}

      {pendingAction ? (
        <AreaActionDialog
          pending={pendingAction}
          now={now}
          online={online}
          onClose={() => setPendingAction(null)}
          onSubmit={runCommand}
        />
      ) : null}
    </div>
  );
}

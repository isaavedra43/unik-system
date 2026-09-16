'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { EntityWorkspace } from '@/components/common/EntityWorkspace';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Drawer } from '@/components/ui/composite';
import { Badge, Button } from '@/components/ui/primitives';
import { formatDateTime, formatDueLabel } from '@/components/operations/mywork-model';
import type { CurrentUser } from '@/modules/auth/authorization';
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
import { CASE_RISK_LABELS, CASE_RISK_TONES, caseHref, type CaseTone } from './case-model';
import {
  CASES_TABLE_KEY,
  CASE_COLUMNS,
  CASE_COLUMN_MAP,
  CASE_DEFAULT_COLUMN_ORDER,
  CASES_BASE_PATH,
  type CaseRow,
} from './cases-columns';
import {
  caseAreaChips,
  caseExtraUrlParams,
  caseMineChip,
  casePhaseChips,
  caseRiskChips,
  caseScopeChips,
  type CaseChip,
  type CaseChipsState,
  type CaseQueryState,
} from './cases-filters';

export interface CasesWorkspaceProps {
  user: CurrentUser;
  initialData: EntityListResult<CaseRow>;
  initialQuery: CaseQueryState;
  chipState: CaseChipsState;
  /** Areas that hold up at least one case right now (chips). */
  blockingAreaKeys: string[];
  preference: TablePreferenceConfig;
  views: { privateViews: TableViewRow[]; sharedViews: TableViewRow[] };
  defaultViewId: string | null;
  watchedIds: string[];
  unreadNotifications: number;
  canExport: boolean;
  canWatch: boolean;
  canShareViews: boolean;
  /** Server time of the render, so due labels match on hydration. */
  nowIso: string;
  savePreferenceAction: SavePreferenceAction;
  resetPreferenceAction: ResetPreferenceAction;
  createViewAction: CreateViewAction;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
  bulkWatchAction: BulkWatchAction;
  exportAction: ExportAction;
}

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

const STATUS_TONE: Record<string, CaseTone> = {
  open: 'info',
  waiting: 'weak',
  blocked: 'danger',
  ready_to_close: 'success',
  closed: 'default',
  cancelled: 'weak',
};

interface CaseSummary {
  id: string;
  caseNumber: string;
  customerName: string | null;
  salesOrderNumber: string | null;
  statusLabel: string;
  phaseLabel: string;
  ownerName: string | null;
  promisedAt: string | null;
  riskLabel: string;
  openWorkItems: number;
  overdueWorkItems: number;
  openRequests: number;
  openIncidents: number;
  next: { title: string; reason: string; ownerName: string | null; dueAt: string | null } | null;
  timeline: string[];
}

function ChipGroup({ label, chips }: { label: string; chips: CaseChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="case-chip-group" role="group" aria-label={label}>
      <span className="case-chip-group-label">{label}</span>
      {chips.map((chip) => (
        <Link
          key={chip.id}
          href={chip.href}
          className={`case-chip ${chip.active ? 'case-chip-active' : ''}`.trim()}
          aria-current={chip.active ? 'true' : undefined}
          title={chip.title}
        >
          {chip.label}
        </Link>
      ))}
    </div>
  );
}

/** Compact case preview: what it is, what is next and its last movements. */
function CasePreviewDrawer({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const [summary, setSummary] = useState<CaseSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const response = await fetch(`/app/operations/api/cases/${encodeURIComponent(caseId)}`);
        const json = (await response.json().catch(() => ({}))) as {
          summary?: CaseSummary;
          error?: string;
        };
        if (!response.ok || !json.summary) {
          throw new Error(json.error ?? 'No pudimos cargar el expediente');
        }
        if (!cancelled) setSummary(json.summary);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'No pudimos cargar el expediente');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, reload]);

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={summary?.caseNumber ?? 'Expediente'}
      subtitle={summary?.customerName ?? undefined}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cerrar
          </Button>
          <Link className="btn btn-primary btn-sm" href={caseHref(caseId)}>
            Abrir expediente
          </Link>
        </>
      }
    >
      {error ? (
        <ErrorState
          title="No pudimos cargar el expediente"
          message={error}
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : !summary ? (
        <LoadingState variant="list" rows={5} label="Cargando el expediente…" />
      ) : (
        <div className="grid gap-4">
          <dl className="case-kv">
            <div>
              <dt>Estado</dt>
              <dd>{summary.statusLabel}</dd>
            </div>
            <div>
              <dt>Fase</dt>
              <dd>{summary.phaseLabel}</dd>
            </div>
            <div>
              <dt>Responsable</dt>
              <dd>{summary.ownerName ?? 'Sin asignar'}</dd>
            </div>
            <div>
              <dt>Promesa</dt>
              <dd>{summary.promisedAt ? formatDateTime(summary.promisedAt) : 'Sin fecha'}</dd>
            </div>
            <div>
              <dt>Orden de venta</dt>
              <dd>{summary.salesOrderNumber ?? 'Sin orden'}</dd>
            </div>
            <div>
              <dt>Riesgo</dt>
              <dd>{summary.riskLabel}</dd>
            </div>
          </dl>

          {summary.next ? (
            <section className="case-next" aria-label="Siguiente paso">
              <span className="case-next-label">Siguiente paso</span>
              <p className="case-next-title">{summary.next.title}</p>
              <p className="case-next-reason">{summary.next.reason}</p>
              <div className="case-next-meta">
                <span>Responsable: {summary.next.ownerName ?? 'Sin asignar'}</span>
                {summary.next.dueAt ? <span>{formatDateTime(summary.next.dueAt)}</span> : null}
              </div>
            </section>
          ) : null}

          <p className="case-item-meta">
            {summary.openWorkItems} trabajos abiertos · {summary.overdueWorkItems} vencidos ·{' '}
            {summary.openRequests} solicitudes · {summary.openIncidents} incidencias
          </p>

          {summary.timeline.length > 0 ? (
            <section aria-label="Últimos movimientos">
              <ul className="case-timeline">
                {summary.timeline.map((line, index) => (
                  <li key={`${index}-${line}`} className="case-timeline-item">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

/**
 * Case list (plan 2.7): the shared `EntityWorkspace` over the operational
 * cases, with chips for scope, phase, risk and blocking area, the preview
 * drawer and a link to the Expediente 360.
 */
export function CasesWorkspace(props: CasesWorkspaceProps) {
  const { user, initialData, initialQuery, chipState, blockingAreaKeys, nowIso } = props;
  const now = useMemo(() => new Date(nowIso), [nowIso]);

  const renderCell = useCallback(
    (row: CaseRow, column: EntityColumnDefinition): React.ReactNode => {
      switch (column.id) {
        case 'caseNumber':
          return (
            <Link className="font-medium" href={caseHref(row.id)}>
              {row.caseNumber}
            </Link>
          );
        case 'customerName':
          return (
            <span className="grid">
              <span>{row.customerName ?? 'Sin cliente'}</span>
              {row.salesOrderNumber ? (
                <span className="text-muted text-xs">{row.salesOrderNumber}</span>
              ) : null}
            </span>
          );
        case 'salesOrderNumber':
          if (!row.salesOrderNumber) return <span className="text-muted">Sin orden</span>;
          // The id only travels when the person may open the Zoho order detail.
          return row.salesOrderId ? (
            <Link href={`/app/sales/orders/${row.salesOrderId}`}>{row.salesOrderNumber}</Link>
          ) : (
            row.salesOrderNumber
          );
        case 'phase':
          return <Badge variant="info">{row.phaseLabel}</Badge>;
        case 'status':
          return (
            <Badge variant={BADGE_BY_TONE[STATUS_TONE[row.status] ?? 'default']}>
              {row.statusLabel}
            </Badge>
          );
        case 'risk':
          return row.open ? (
            <Badge variant={BADGE_BY_TONE[CASE_RISK_TONES[row.risk]]}>
              {CASE_RISK_LABELS[row.risk]}
            </Badge>
          ) : (
            <span className="text-muted">—</span>
          );
        case 'priority':
          return row.priority === 'normal' ? (
            <span className="text-muted">{row.priorityLabel}</span>
          ) : (
            <Badge variant="warning">{row.priorityLabel}</Badge>
          );
        case 'ownerName':
          return row.ownerName ?? <span className="text-muted">Sin asignar</span>;
        case 'promisedAt': {
          if (!row.promisedAt) return <span className="text-muted">Sin fecha</span>;
          const due = formatDueLabel(row.promisedAt, now, { closed: !row.open });
          return (
            <span
              className={
                due.tone === 'danger'
                  ? 'case-due-danger'
                  : due.tone === 'warning'
                    ? 'case-due-warning'
                    : ''
              }
              title={due.title}
            >
              {due.label}
            </span>
          );
        }
        case 'blockingAreas':
          return row.blockingAreaLabels.length > 0 ? (
            row.blockingAreaLabels.join(', ')
          ) : (
            <span className="text-muted">—</span>
          );
        case 'openWorkItems':
          return row.openWorkItems.toLocaleString('es-MX');
        case 'overdueWorkItems':
          return row.overdueWorkItems > 0 ? (
            <span className="case-due-danger">{row.overdueWorkItems.toLocaleString('es-MX')}</span>
          ) : (
            <span className="text-muted">0</span>
          );
        case 'openIncidents':
          return row.openIncidents > 0 ? (
            <span className="case-due-danger">{row.openIncidents.toLocaleString('es-MX')}</span>
          ) : (
            <span className="text-muted">0</span>
          );
        case 'locationName':
          return row.locationName ?? <span className="text-muted">—</span>;
        case 'lastActivityAt':
          return formatDateTime(row.lastActivityAt);
        case 'openedAt':
          return formatDateTime(row.openedAt);
        default:
          return null;
      }
    },
    [now]
  );

  const toolbarExtra = (
    <div className="case-chips" role="group" aria-label="Filtros de expedientes">
      <ChipGroup label="Estado" chips={caseScopeChips(chipState)} />
      <ChipGroup label="Fase" chips={casePhaseChips(chipState)} />
      <ChipGroup label="Riesgo" chips={caseRiskChips(chipState)} />
      <ChipGroup label="Área" chips={caseAreaChips(chipState, blockingAreaKeys)} />
      <ChipGroup label="Míos" chips={[caseMineChip(chipState)]} />
    </div>
  );

  return (
    <div className="case-workspace">
      <EntityWorkspace<CaseRow>
        user={user}
        tableKey={CASES_TABLE_KEY}
        entityLabel="Expediente"
        entityLabelPlural="Expedientes"
        basePath={CASES_BASE_PATH}
        permissionView="operations.view"
        permissionExport="operations.view"
        permissionWatch="operations.view"
        permissionShareViews="operations.manage"
        initialData={initialData}
        initialQuery={initialQuery as unknown as EntityQueryState}
        preference={props.preference}
        views={props.views}
        defaultViewId={props.defaultViewId}
        watchedIds={new Set(props.watchedIds)}
        unreadNotifications={props.unreadNotifications}
        canExport={props.canExport}
        canWatch={props.canWatch}
        canShareViews={props.canShareViews}
        columns={CASE_COLUMNS}
        columnMap={CASE_COLUMN_MAP}
        defaultColumnOrder={CASE_DEFAULT_COLUMN_ORDER}
        renderCell={renderCell}
        nameField="caseNumber"
        searchPlaceholder="Buscar por expediente, cliente u orden…"
        savePreferenceAction={props.savePreferenceAction}
        resetPreferenceAction={props.resetPreferenceAction}
        createViewAction={props.createViewAction}
        watchAction={props.watchAction}
        unwatchAction={props.unwatchAction}
        bulkWatchAction={props.bulkWatchAction}
        exportAction={props.exportAction}
        toolbarExtra={toolbarExtra}
        extraUrlParams={caseExtraUrlParams(chipState)}
        renderPreviewDrawer={({ entityId, onClose }) => (
          <CasePreviewDrawer caseId={entityId} onClose={onClose} />
        )}
      />
    </div>
  );
}

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import '@/styles/operations/control-tower.css';
/*
 * NOTA (medido): mover estas seis vistas a `next/dynamic` NO baja el first-load
 * de la ruta (449 kB antes, 450 kB después): en un Server Component las seis
 * siguen entrando en la entrada de cliente del segmento. Partirlo de verdad
 * exige un segmento de ruta por vista, como el hueco que queda anotado para
 * `/app/areas/[areaKey]/[space]`.
 */
import { ApprovalPolicyEditor } from '@/components/control-tower/ApprovalPolicyEditor';
import { ApprovalsPanel } from '@/components/control-tower/ApprovalsPanel';
import { AuditPanel } from '@/components/control-tower/AuditPanel';
import { ControlTowerShell } from '@/components/control-tower/ControlTowerShell';
import { ExceptionsWorkspace } from '@/components/control-tower/ExceptionsWorkspace';
import { OverviewPanel } from '@/components/control-tower/OverviewPanel';
import { PeopleNowTable } from '@/components/control-tower/PeopleNowTable';
import { auditFiltersFromParams } from '@/components/control-tower/audit-model';
import {
  NEURAL_PAGES_ENABLED,
  isControlTowerView,
  type ControlTowerView,
} from '@/components/control-tower/control-tower-views';
import { exceptionChipsFromParams } from '@/components/control-tower/exceptions-model';
import { Alert } from '@/components/ui/primitives';
import {
  hasAnyPermission,
  hasPermission,
  requirePermission,
  type CurrentUser,
} from '@/modules/auth/authorization';
import { CONTROL_TOWER_PERMISSION } from '@/modules/control-tower/control-tower-service';
import { OPERATIONS_OPERATOR_PERMISSIONS } from '@/components/control-tower/exception-actions';
import {
  loadApprovalsView,
  loadAuditView,
  loadExceptionsView,
  loadOverviewView,
  loadPeopleView,
  loadSettingsView,
} from './_data';
import {
  bulkWatchExceptionsAction,
  createExceptionsViewAction,
  deletePolicyAction,
  exportExceptionsAction,
  previewPolicyAction,
  rebuildRelationsAction,
  resetExceptionsPreferenceAction,
  saveExceptionsPreferenceAction,
  saveOperationsConfigAction,
  savePolicyAction,
  saveSourcingConfigAction,
  watchExceptionAction,
} from './actions';
import { RelationsRebuildPanel } from '@/components/control-tower/RelationsRebuildPanel';
import { SettingsPanel } from '@/components/control-tower/SettingsPanel';
import { SourcingConfigPanel } from '@/components/control-tower/SourcingConfigPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One view of the Control Tower (plan 7.7): `resumen`, `personas`,
 * `excepciones`, `aprobaciones`, `auditoria` or `configuracion`.
 *
 * Nested routes (never `?tab=`), one gate for the whole surface
 * (`operations.admin`) and every view is a Server Component with its own load,
 * `loading.tsx` and `error.tsx`. The services check the permission again, so a
 * view added here without the gate still returns nothing.
 */

type SearchParams = Record<string, string | string[] | undefined>;

function flatten(params: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') out[key] = first;
  }
  return out;
}

async function renderView(
  view: ControlTowerView,
  user: CurrentUser,
  params: Record<string, string>,
  nowIso: string
): Promise<ReactNode> {
  const now = new Date(nowIso);
  const canUseAssistant = hasPermission(user, 'assistant.use');

  if (view === 'resumen') {
    const data = await loadOverviewView(user, { now });
    return (
      <OverviewPanel
        user={{ id: user.id, name: user.name }}
        overview={data.overview}
        source={data.source}
        note={data.note}
        canUseAssistant={canUseAssistant}
        activityAt={data.activityAt}
        nowIso={nowIso}
      />
    );
  }

  if (view === 'personas') {
    const data = await loadPeopleView(user, { now });
    return (
      <>
        {data.warning ? <Alert variant="warning">{data.warning}</Alert> : null}
        <PeopleNowTable initial={data.people} nowIso={nowIso} />
      </>
    );
  }

  if (view === 'excepciones') {
    const chips = exceptionChipsFromParams(params);
    const data = await loadExceptionsView(user, chips, { now, searchParams: params });
    return (
      <>
        {data.warning ? <Alert variant="warning">{data.warning}</Alert> : null}
        <ExceptionsWorkspace
          user={user}
          initialData={{ data: data.page.data, pagination: data.page.pagination }}
          initialQuery={data.query}
          chips={chips}
          counts={data.page.counts}
          preference={data.preference}
          views={data.views}
          defaultViewId={data.defaultViewId}
          unreadNotifications={data.unreadNotifications}
          canManage={hasAnyPermission(user, [...OPERATIONS_OPERATOR_PERMISSIONS])}
          canShareViews
          assignees={data.assignees}
          savePreferenceAction={saveExceptionsPreferenceAction}
          resetPreferenceAction={resetExceptionsPreferenceAction}
          createViewAction={createExceptionsViewAction}
          watchAction={watchExceptionAction}
          unwatchAction={watchExceptionAction}
          bulkWatchAction={bulkWatchExceptionsAction}
          exportAction={exportExceptionsAction}
          nowIso={nowIso}
        />
      </>
    );
  }

  if (view === 'aprobaciones') {
    const data = await loadApprovalsView(user, { now });
    return (
      <ApprovalsPanel
        user={{ id: user.id, name: user.name }}
        approvals={data.approvals}
        proposals={data.proposals}
        workItems={data.workItems}
        warnings={data.warnings}
        nowIso={nowIso}
      />
    );
  }

  if (view === 'auditoria') {
    const filters = auditFiltersFromParams(params);
    const data = await loadAuditView(filters);
    return (
      <>
        {data.warning ? <Alert variant="warning">{data.warning}</Alert> : null}
        <AuditPanel
          initial={data.page}
          initialFilters={filters}
          actors={data.actors}
          nowIso={nowIso}
        />
      </>
    );
  }

  const settings = await loadSettingsView();
  return (
    <>
      {settings.warnings.map((warning) => (
        <Alert key={warning} variant="warning">
          {warning}
        </Alert>
      ))}
      <SettingsPanel
        config={settings.config}
        saveAction={saveOperationsConfigAction}
        nowIso={nowIso}
      />
      <SourcingConfigPanel
        config={settings.sourcing}
        accounts={settings.sourcingAccounts}
        connections={settings.sourcingConnections}
        saveAction={saveSourcingConfigAction}
        nowIso={nowIso}
      />
      <ApprovalPolicyEditor
        policies={settings.policies}
        roles={settings.roles}
        categories={settings.categories}
        savePolicyAction={savePolicyAction}
        deletePolicyAction={deletePolicyAction}
        previewPolicyAction={previewPolicyAction}
        thresholds={settings.config.approvalThresholds}
      />
      <RelationsRebuildPanel
        sources={settings.relationSources}
        last={settings.lastRelationsRebuild}
        rebuildAction={rebuildRelationsAction}
        nowIso={nowIso}
      />
    </>
  );
}

export default async function ControlTowerViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ view: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { view } = await params;
  if (!isControlTowerView(view)) notFound();

  const user = await requirePermission(CONTROL_TOWER_PERMISSION);
  const flat = flatten(await searchParams);
  const nowIso = new Date().toISOString();

  return (
    <ControlTowerShell view={view} userName={user.name} neuralEnabled={NEURAL_PAGES_ENABLED}>
      {await renderView(view, user, flat, nowIso)}
    </ControlTowerShell>
  );
}

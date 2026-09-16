import { PageHeader } from '@/components/ui/composite';
import { Alert, Button, FormField, Input } from '@/components/ui/primitives';
import { CasesWorkspace } from '@/components/operations/case/CasesWorkspace';
import {
  CASE_COLUMNS,
  CASE_DEFAULT_COLUMN_ORDER,
  CASE_ENTITY_TYPE,
  CASES_TABLE_KEY,
} from '@/components/operations/case/cases-columns';
import {
  CasesQueryError,
  caseChipsStateFromParams,
  casesQueryFromSearchParams,
} from '@/components/operations/case/cases-filters';
import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import { getWatchedEntityIds } from '@/modules/sales/entity-watch-service';
import { getUnreadNotificationCount } from '@/modules/sales/notifications-service';
import { getUserTablePreference } from '@/modules/sales/table-preferences-service';
import { getDefaultTableView, listTableViews } from '@/modules/sales/table-views-service';
import type { TablePreferenceConfig } from '@/modules/shared/entity-workspace-types';
import { blockingAreaKeys, listCaseRows } from './_cases-data';
import {
  bulkWatchCasesAction,
  createCaseViewAction,
  exportCasesAction,
  resetCasePreferenceAction,
  saveCasePreferenceAction,
  startTrackingAction,
  unwatchCaseAction,
  watchCaseAction,
} from './actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Case list (plan 2.7): the shared `EntityWorkspace` over `OperationalCase`
 * with the operational chips (scope, phase, risk, blocking area, mine), the
 * preview drawer and the link to the Expediente 360.
 *
 * "Iniciar seguimiento" stays here for orders created before the cutover or
 * outside the pilot locations; new orders open their case on their own.
 */

const NOTICES: Record<string, { variant: 'error' | 'success' | 'warning' | 'info'; text: string }> =
  {
    started: { variant: 'success', text: 'Seguimiento iniciado.' },
    queued: {
      variant: 'success',
      text: 'Seguimiento solicitado. El expediente aparecerá en la lista en unos segundos.',
    },
    already_started: { variant: 'info', text: 'Esa orden ya tenía expediente.' },
    no_lines: {
      variant: 'warning',
      text: 'La orden no tiene partidas de artículos que surtir, así que no abre expediente.',
    },
    not_found: {
      variant: 'error',
      text: 'No encontramos esa orden de venta entre las sincronizadas desde Zoho. Revisa el número o espera la siguiente sincronización.',
    },
    not_eligible: {
      variant: 'warning',
      text: 'La orden no puede iniciar seguimiento: está en borrador, anulada, cerrada o ya se entregó.',
    },
    forbidden: { variant: 'error', text: 'No tienes permiso para iniciar seguimientos.' },
    invalid: {
      variant: 'error',
      text: 'Escribe el número de la orden de venta (por ejemplo SO-00123).',
    },
    unavailable: {
      variant: 'warning',
      text: 'El arranque de expedientes está apagado en la configuración de Operaciones.',
    },
    failed: {
      variant: 'error',
      text: 'No se pudo iniciar el seguimiento. Intenta de nuevo en unos minutos.',
    },
  };

type SearchParams = Record<string, string | string[] | undefined>;

function flatten(params: SearchParams): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') flat[key] = first;
  }
  return flat;
}

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePermission('operations.view');
  const params = flatten(await searchParams);
  const nowIso = new Date().toISOString();

  let query;
  let queryError: string | null = null;
  try {
    query = casesQueryFromSearchParams(params, { userId: user.id });
  } catch (error) {
    queryError =
      error instanceof CasesQueryError
        ? error.message
        : 'El enlace tiene filtros que no reconocemos; te mostramos la lista sin ellos.';
    query = casesQueryFromSearchParams({}, { userId: user.id });
  }

  const [result, preference, views, defaultView, unread, areaKeys] = await Promise.all([
    listCaseRows(user, query),
    getUserTablePreference(user.id, CASES_TABLE_KEY),
    listTableViews(user.id, CASES_TABLE_KEY),
    getDefaultTableView(user.id, CASES_TABLE_KEY),
    getUnreadNotificationCount(user.id),
    blockingAreaKeys(),
  ]);
  const watchedIds = await getWatchedEntityIds(
    user.id,
    CASE_ENTITY_TYPE,
    result.data.map((row) => row.id)
  );

  const canManage = hasPermission(user, 'operations.manage');
  const notice = params.notice ? NOTICES[params.notice] : undefined;
  const caseNumber = params.case && /^EXP-\d{1,12}$/.test(params.case) ? params.case : null;

  const defaultPreference: TablePreferenceConfig = {
    version: 1,
    columnOrder: CASE_DEFAULT_COLUMN_ORDER,
    columnVisibility: Object.fromEntries(
      CASE_COLUMNS.map((column) => [column.id, column.defaultVisible])
    ),
    columnWidths: Object.fromEntries(
      CASE_COLUMNS.map((column) => [column.id, column.defaultWidth])
    ),
    columnPinning: { left: [], right: [] },
    density: 'normal',
    pageSize: query.page_size,
  };

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Expedientes"
        description="Seguimiento operativo de las órdenes de venta: fase, estado, riesgo, responsable y qué área las detiene."
      />

      {queryError ? <Alert variant="warning">{queryError}</Alert> : null}

      {notice ? (
        <Alert variant={notice.variant}>
          {notice.text}
          {caseNumber ? ` Expediente ${caseNumber}.` : null}
        </Alert>
      ) : null}

      {canManage ? (
        <section className="card" aria-labelledby="start-tracking-title">
          <div className="card-header">
            <h2 id="start-tracking-title" className="card-title">
              Iniciar seguimiento
            </h2>
            <p className="card-subtitle">
              Las órdenes nuevas abren su expediente solas. Usa esto para órdenes anteriores a la
              fecha de corte o de una bodega fuera del piloto.
            </p>
          </div>
          <form action={startTrackingAction} className="case-start-form">
            <FormField label="Número de orden de venta" htmlFor="salesOrder">
              <Input
                id="salesOrder"
                name="salesOrder"
                required
                maxLength={60}
                placeholder="SO-00123"
                autoComplete="off"
              />
            </FormField>
            <Button type="submit">Iniciar seguimiento</Button>
          </form>
        </section>
      ) : null}

      <CasesWorkspace
        user={user}
        initialData={result}
        initialQuery={query}
        chipState={caseChipsStateFromParams(params)}
        blockingAreaKeys={areaKeys}
        preference={preference ?? defaultPreference}
        views={views}
        defaultViewId={defaultView?.id ?? null}
        watchedIds={[...watchedIds]}
        unreadNotifications={unread}
        canExport
        // Seguir un expediente todavía no avisa de nada: ningún productor llama a
        // `recordEntityChange('operational_case')`. Se ofrecerá cuando lo haga.
        canWatch={false}
        canShareViews={canManage}
        nowIso={nowIso}
        savePreferenceAction={saveCasePreferenceAction}
        resetPreferenceAction={resetCasePreferenceAction}
        createViewAction={createCaseViewAction}
        watchAction={watchCaseAction}
        unwatchAction={unwatchCaseAction}
        bulkWatchAction={bulkWatchCasesAction}
        exportAction={exportCasesAction}
      />
    </div>
  );
}

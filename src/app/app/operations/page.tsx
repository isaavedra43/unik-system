import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { EmptyState, PageHeader, TabNav } from '@/components/ui/composite';
import {
  Alert,
  Badge,
  Button,
  FormField,
  Input,
  type BadgeVariant,
} from '@/components/ui/primitives';
import { prisma } from '@/lib/prisma';
import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import {
  CASE_OPEN_STATUSES,
  CASE_PHASE_LABELS,
  CASE_STATUS_LABELS,
  type CasePhase,
  type CaseStatus,
} from '@/modules/operations/types';
import { formatOperationsDate } from '@/modules/operations/work-items-service';
import { startTrackingAction } from './actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Temporary minimal view of the operational cases (plan section 2.7): paginated
 * list with number, customer, phase, status, owner and last activity, plus
 * "Iniciar seguimiento" by sales order number for people with
 * `operations.manage`. The full per-area experience comes in a later phase.
 */

const PAGE_SIZE = 25;
const BASE_PATH = '/app/operations';

const STATUS_FILTERS = {
  open: [...CASE_OPEN_STATUSES] as string[],
  closed: ['closed', 'cancelled'],
  all: null,
} satisfies Record<string, string[] | null>;
type StatusFilter = keyof typeof STATUS_FILTERS;

const STATUS_VARIANTS: Record<CaseStatus, BadgeVariant> = {
  open: 'info',
  waiting: 'weak',
  blocked: 'danger',
  ready_to_close: 'success',
  closed: 'default',
  cancelled: 'weak',
};

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

interface SearchParams {
  page?: string;
  status?: string;
  notice?: string;
  case?: string;
}

function statusFilterOf(value: string | undefined): StatusFilter {
  return value === 'closed' || value === 'all' ? value : 'open';
}

function listHref(status: StatusFilter, page = 1): string {
  const query = new URLSearchParams();
  if (status !== 'open') query.set('status', status);
  if (page > 1) query.set('page', String(page));
  const text = query.toString();
  return text ? `${BASE_PATH}?${text}` : BASE_PATH;
}

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePermission('operations.view');
  const params = await searchParams;
  const status = statusFilterOf(params.status);
  const requestedPage = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const statuses = STATUS_FILTERS[status];
  const where: Prisma.OperationalCaseWhereInput = statuses ? { status: { in: statuses } } : {};

  const total = await prisma.operationalCase.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const cases = await prisma.operationalCase.findMany({
    where,
    orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true,
      caseNumber: true,
      customerName: true,
      salesOrderNumber: true,
      phase: true,
      status: true,
      ownerUserId: true,
      lastActivityAt: true,
    },
  });
  const ownerIds = [...new Set(cases.map((c) => c.ownerUserId))];
  const owners =
    ownerIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, name: true, isActive: true },
        })
      : [];
  const ownerBy = new Map(owners.map((o) => [o.id, o]));

  const canManage = hasPermission(user, 'operations.manage');
  const notice = params.notice ? NOTICES[params.notice] : undefined;
  const caseNumber = params.case && /^EXP-\d{1,12}$/.test(params.case) ? params.case : null;

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Expedientes"
        description="Seguimiento operativo de las órdenes de venta: fase, estado, responsable y última actividad."
        breadcrumbs={[{ label: 'Inicio', href: '/app' }, { label: 'Operaciones' }]}
      />

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
          <form action={startTrackingAction} className="flex flex-wrap items-end gap-3">
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

      <TabNav
        activeId={status}
        tabs={[
          { id: 'open', label: 'Abiertos', href: listHref('open') },
          { id: 'closed', label: 'Cerrados', href: listHref('closed') },
          { id: 'all', label: 'Todos', href: listHref('all') },
        ]}
      />

      {cases.length === 0 ? (
        <EmptyState
          icon="layers"
          title={status === 'open' ? 'Sin expedientes abiertos' : 'Sin expedientes'}
          message="Aquí aparecerán las órdenes de venta con seguimiento operativo."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Expedientes operativos</caption>
            <thead>
              <tr>
                <th scope="col">Expediente</th>
                <th scope="col">Cliente</th>
                <th scope="col">Fase</th>
                <th scope="col">Estado</th>
                <th scope="col">Responsable</th>
                <th scope="col">Última actividad</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const owner = ownerBy.get(c.ownerUserId);
                const statusLabel = CASE_STATUS_LABELS[c.status as CaseStatus] ?? c.status;
                return (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap font-medium">{c.caseNumber}</td>
                    <td>
                      <div>{c.customerName ?? 'Sin cliente'}</div>
                      {c.salesOrderNumber ? (
                        <div className="text-muted text-xs">{c.salesOrderNumber}</div>
                      ) : null}
                    </td>
                    <td>{CASE_PHASE_LABELS[c.phase as CasePhase] ?? c.phase}</td>
                    <td>
                      <Badge variant={STATUS_VARIANTS[c.status as CaseStatus] ?? 'default'}>
                        {statusLabel}
                      </Badge>
                    </td>
                    <td>
                      {owner ? owner.name : 'Sin asignar'}
                      {owner && !owner.isActive ? (
                        <div className="text-muted text-xs">Inactivo</div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap">
                      <time dateTime={c.lastActivityAt.toISOString()}>
                        {formatOperationsDate(c.lastActivityAt)}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 ? (
        <nav aria-label="Paginación" className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-muted text-sm">
            Página {page} de {pageCount} · {total} {total === 1 ? 'expediente' : 'expedientes'}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link className="btn btn-secondary btn-sm" href={listHref(status, page - 1)}>
                Anterior
              </Link>
            ) : null}
            {page < pageCount ? (
              <Link className="btn btn-secondary btn-sm" href={listHref(status, page + 1)}>
                Siguiente
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

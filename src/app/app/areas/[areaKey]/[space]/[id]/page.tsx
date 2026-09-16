import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AreaDetailExtras } from '@/components/areas/AreaDetailExtras';
import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { requireAnyPermission } from '@/modules/auth/authorization';
import {
  areaActPermissions,
  areaHref,
  areaViewPermissions,
  findAreaSpace,
  getArea,
  holdsAny,
  knownAreaPermissions,
  rowKindsForSpace,
} from '@/modules/areas/area-registry';
import { rowKindLabel, workRowId, type AreaRowDetail } from '@/modules/areas/area-work-row';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';
import { getRowActions, noActionsReason } from '@/modules/areas/work-actions';
import { getWorkRowDetail } from '@/modules/areas/work-rows-service';
import { runRowCommandAction } from '../../actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Detail page of one row of an area (plan 7.1: `/app/areas/compras/ordenes/[id]`).
 * It is the stable deep link notifications and chat cards point at: the facts,
 * the case timeline when the case rule allows it, the evidence and the actions
 * that need no extra input (the rest are done from the work centre, where the
 * dialog collects the note, the reason or the answer).
 */

const NOTICES: Record<string, { variant: 'success' | 'warning' | 'error' | 'info'; text: string }> =
  {
    done: { variant: 'success', text: 'Acción registrada.' },
    queued: { variant: 'info', text: 'Acción enviada; se está sincronizando.' },
    invalid: { variant: 'error', text: 'Faltaron datos para ejecutar la acción.' },
    not_found: { variant: 'error', text: 'Ya no encontramos esta fila.' },
    forbidden: { variant: 'error', text: 'No puedes ejecutar esa acción sobre esta fila.' },
    rejected: { variant: 'warning', text: 'El motor rechazó la acción en este estado.' },
    version_conflict: {
      variant: 'warning',
      text: 'Alguien actualizó este registro antes que tú; revisa los datos y vuelve a intentarlo.',
    },
    failed: { variant: 'error', text: 'No se pudo ejecutar la acción. Intenta de nuevo.' },
  };

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

export default async function AreaRowDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ areaKey: string; space: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { areaKey, space: spaceSlug, id } = await params;
  const area = getArea(areaKey);
  if (!area) notFound();
  const user = await requireAnyPermission(areaViewPermissions(area));
  const space = findAreaSpace(area, spaceSlug);
  if (!space || (space.kind !== 'subpage' && space.kind !== 'work')) notFound();
  if (!holdsAny(user, knownAreaPermissions([...space.permissions, 'operations.admin']))) {
    notFound();
  }
  await ensureAreaRegistrations();

  const entityId = decodeURIComponent(id);
  // In the work centre the id is already `<rowKind>:<sourceId>`; in a subpage it
  // is the entity id, so the row kinds of that subpage resolve it.
  const candidates =
    space.kind === 'work'
      ? [entityId]
      : rowKindsForSpace(area, space).map((kind) => workRowId(kind, entityId));

  let detail: AreaRowDetail | null = null;
  for (const candidate of candidates) {
    detail = await getWorkRowDetail(user, area, candidate);
    if (detail) break;
  }
  if (!detail) notFound();

  const { row } = detail;
  const query = await searchParams;
  const noticeKey = Array.isArray(query.notice) ? query.notice[0] : query.notice;
  const notice = noticeKey ? NOTICES[noticeKey] : undefined;
  const actor = {
    id: user.id,
    permissionKeys: user.permissionKeys as string[],
    isSuperAdmin: user.isSuperAdmin,
  };
  const actions = getRowActions(row, actor, { actPermissions: areaActPermissions(area) });
  const simple = actions.filter((action) => action.form === 'none');
  const guided = actions.filter((action) => action.form !== 'none');
  const workPath = areaHref(area.key, 'trabajo');
  const returnTo = `${areaHref(area.key, space.slug)}/${encodeURIComponent(entityId)}`;
  const runAction = runRowCommandAction.bind(null, area.key);

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug={space.slug}>
      <div className="area-space">
        {notice ? <Alert variant={notice.variant}>{notice.text}</Alert> : null}

        <div className="area-shell-heading">
          <div className="area-row-title">
            <h2 className="page-title">{row.title}</h2>
            <span className="area-row-sub">
              {rowKindLabel(row.rowKind)}
              {row.caseNumber ? ` · ${row.caseNumber}` : ''}
              {row.customerName ? ` · ${row.customerName}` : ''}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={BADGE_BY_TONE[row.statusTone]}>{row.statusLabel}</Badge>
          {row.overdue ? <Badge variant="danger">Vencido</Badge> : null}
          {row.ownerName ? (
            <span className="area-row-sub">Responsable: {row.ownerName}</span>
          ) : null}
        </div>

        <section className="area-drawer-section" aria-labelledby="row-facts">
          <h3 id="row-facts" className="area-drawer-section-title">
            Datos
          </h3>
          <dl className="area-drawer-fields">
            {detail.fields.map((fact) => (
              <div key={`${fact.label}-${fact.value}`} className="area-drawer-field">
                <dt>{fact.label}</dt>
                <dd>
                  {fact.value}
                  {fact.hint ? <div className="area-row-sub">{fact.hint}</div> : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {detail.freeText ? (
          <section className="area-drawer-section" aria-labelledby="row-free">
            <h3 id="row-free" className="area-drawer-section-title">
              Texto de quien la escribió
            </h3>
            <blockquote className="area-drawer-quote">{detail.freeText}</blockquote>
          </section>
        ) : null}

        {detail.caseSummary ? (
          <section className="area-drawer-section" aria-labelledby="row-case">
            <h3 id="row-case" className="area-drawer-section-title">
              Expediente {detail.caseSummary.caseNumber}
            </h3>
            <p className="text-sm">
              {detail.caseSummary.customerName ?? 'Sin cliente'} · {detail.caseSummary.phaseLabel} ·{' '}
              {detail.caseSummary.statusLabel}
            </p>
            <p className="area-row-sub">
              {detail.caseSummary.openWorkItems} trabajos abiertos ·{' '}
              {detail.caseSummary.openRequests} solicitudes · {detail.caseSummary.openIncidents}{' '}
              incidencias
            </p>
          </section>
        ) : detail.caseRestricted ? (
          <Alert variant="info">
            Este registro pertenece a un expediente al que no tienes acceso, así que no mostramos su
            resumen ni su cronología.
          </Alert>
        ) : null}

        {detail.timeline.length > 0 ? (
          <section className="area-drawer-section" aria-labelledby="row-timeline">
            <h3 id="row-timeline" className="area-drawer-section-title">
              Cronología
            </h3>
            <ul className="area-timeline">
              {detail.timeline.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="area-drawer-section" aria-labelledby="row-evidence">
          <h3 id="row-evidence" className="area-drawer-section-title">
            Evidencias
          </h3>
          {detail.evidence.length === 0 ? (
            <p className="area-row-sub">
              Todavía no hay evidencias adjuntas. Se adjuntan desde el centro de trabajo.
            </p>
          ) : (
            <ul className="area-evidence-list">
              {detail.evidence.map((item) => (
                <li key={item.id} className="area-evidence-item">
                  {item.label}
                  {item.note ? ` · ${item.note}` : ''}
                  {item.createdByName ? ` · ${item.createdByName}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>

        <AreaDetailExtras
          areaKey={area.key}
          slug={space.slug}
          rowKind={row.rowKind}
          entityId={row.sourceId}
          version={row.version}
          status={row.status}
          user={{ id: user.id, name: user.name }}
          canAct={holdsAny(user, knownAreaPermissions(areaActPermissions(area)))}
        />

        <section className="area-drawer-section" aria-labelledby="row-actions">
          <h3 id="row-actions" className="area-drawer-section-title">
            Acciones
          </h3>
          {actions.length === 0 ? (
            <p className="area-row-sub">{noActionsReason(row, actor)}</p>
          ) : (
            <div className="area-drawer-actions">
              {simple.map((action) => (
                <form key={action.id} action={runAction}>
                  <input type="hidden" name="rowId" value={row.id} />
                  <input type="hidden" name="actionId" value={action.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <Button
                    type="submit"
                    variant={action.tone === 'danger' ? 'danger' : 'primary'}
                    size="sm"
                  >
                    {action.label}
                  </Button>
                </form>
              ))}
              {guided.length > 0 ? (
                <Link className="btn btn-secondary btn-sm" href={`${workPath}?kind=${row.rowKind}`}>
                  {guided.length === 1
                    ? `${guided[0].label} en el centro de trabajo`
                    : 'Más acciones en el centro de trabajo'}
                </Link>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </AreaWorkspaceShell>
  );
}

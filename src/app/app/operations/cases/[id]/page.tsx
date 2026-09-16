import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Case360 } from '@/components/operations/case/Case360';
import { EmptyState } from '@/components/ui/composite';
import { hasPermission, requireAuthenticatedUser } from '@/modules/auth/authorization';
import { loadCaseView } from '../../_case-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Expediente 360 (plan 2.7): the order, the promise, the phase with its
 * progress, what is next and who has it, the needs with their allocations, the
 * steps by area, the open work, the requests between areas, the incidents, the
 * delivery, the evidence and the whole timeline — with the case copilot beside
 * it.
 *
 * ACCESS: `authorizeOperationsChannel('case')` (`operations.admin`, the case
 * owner, an owner/backup of one of its work items or a member of its room),
 * NOT `operations.view`. A person who may see the list does not automatically
 * open every case, and the page says so instead of showing an empty shell.
 */
export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ incident?: string | string[] }>;
}) {
  const user = await requireAuthenticatedUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const loaded = await loadCaseView(user, id);

  if (!loaded.ok && loaded.reason === 'not_found') notFound();

  if (!loaded.ok) {
    return (
      <div className="grid gap-4">
        <EmptyState
          icon="lock"
          title="No tienes acceso a este expediente"
          message="Los expedientes se abren para su responsable, para quien tiene trabajo en ellos y para los miembros de su sala. Pide que te asignen el trabajo o que te agreguen a la sala."
          action={
            <Link className="btn btn-secondary btn-sm" href="/app/mywork">
              Ir a Mi trabajo
            </Link>
          }
        />
      </div>
    );
  }

  const { view } = loaded;
  // `incidents-service` links notifications as `…/cases/<id>?incident=<id>`.
  const requestedIncident = Array.isArray(query.incident) ? query.incident[0] : query.incident;
  const focusIncidentId =
    requestedIncident && view.incidents.some((incident) => incident.id === requestedIncident)
      ? requestedIncident
      : null;

  return (
    <div className="grid gap-3">
      <Case360
        view={view}
        user={{ id: user.id, name: user.name }}
        canManage={hasPermission(user, 'operations.manage')}
        canUseAssistant={hasPermission(user, 'assistant.use')}
        focusIncidentId={focusIncidentId}
        nowIso={new Date().toISOString()}
      />
    </div>
  );
}

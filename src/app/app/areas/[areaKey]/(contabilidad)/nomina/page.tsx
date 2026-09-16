import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { ContabilidadSectionNav } from '@/components/areas/contabilidad/ContabilidadSectionNav';
import { PayrollPanel } from '@/components/areas/contabilidad/PayrollPanel';
import { visibleContabilidadSections } from '@/modules/areas/contabilidad/contabilidad-model';
import { loadPayrollView } from '@/modules/areas/contabilidad/queries';
import { requireContabilidadPage } from '../_guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Corridas de nómina y sus líneas (plan 6.4). `?corrida=<id>` abre una corrida
 * con el detalle por empleado y su siguiente paso.
 */
export default async function NominaPage({
  params,
  searchParams,
}: {
  params: Promise<{ areaKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { areaKey } = await params;
  const { user, area } = await requireContabilidadPage(areaKey, [
    'finance.view',
    'finance.payroll',
  ]);

  const query = await searchParams;
  const raw = Array.isArray(query.corrida) ? query.corrida[0] : query.corrida;
  const runId = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;

  const view = await loadPayrollView(user, { ...(runId ? { runId } : {}) });

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="nomina" parentSlug="libro">
      <div className="area-space fin-page">
        <ContabilidadSectionNav sections={visibleContabilidadSections(user)} activeId="nomina" />
        <PayrollPanel user={{ id: user.id, name: user.name }} view={view} />
      </div>
    </AreaWorkspaceShell>
  );
}

import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { BudgetsPanel } from '@/components/areas/contabilidad/BudgetsPanel';
import { ContabilidadSectionNav } from '@/components/areas/contabilidad/ContabilidadSectionNav';
import { visibleContabilidadSections } from '@/modules/areas/contabilidad/contabilidad-model';
import { loadBudgetsView } from '@/modules/areas/contabilidad/queries';
import { requireContabilidadPage } from '../_guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Presupuesto del periodo contra el real por centro y categoría (plan 6.4). */
export default async function PresupuestosPage({
  params,
  searchParams,
}: {
  params: Promise<{ areaKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { areaKey } = await params;
  const { user, area } = await requireContabilidadPage(areaKey, [
    'finance.view',
    'finance.manage_catalog',
  ]);

  const query = await searchParams;
  const raw = Array.isArray(query.periodo) ? query.periodo[0] : query.periodo;
  const periodKey =
    typeof raw === 'string' && /^\d{4}-\d{2}$/.test(raw.trim()) ? raw.trim() : undefined;

  const view = await loadBudgetsView(user, { ...(periodKey ? { periodKey } : {}) });

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="presupuestos" parentSlug="libro">
      <div className="area-space fin-page">
        <ContabilidadSectionNav
          sections={visibleContabilidadSections(user)}
          activeId="presupuestos"
        />
        <BudgetsPanel user={{ id: user.id, name: user.name }} view={view} />
      </div>
    </AreaWorkspaceShell>
  );
}

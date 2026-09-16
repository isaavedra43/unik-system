import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { ClosePanel } from '@/components/areas/contabilidad/ClosePanel';
import { ContabilidadSectionNav } from '@/components/areas/contabilidad/ContabilidadSectionNav';
import { visibleContabilidadSections } from '@/modules/areas/contabilidad/contabilidad-model';
import { loadCloseView } from '@/modules/areas/contabilidad/queries';
import { requireContabilidadPage } from '../_guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cierre diario y mensual (plan 6.4): arqueo de cajas, checklist con los
 * bloqueos resaltados y reapertura con motivo.
 */
export default async function CierrePage({ params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const { user, area } = await requireContabilidadPage(areaKey, ['finance.view', 'finance.close']);
  const view = await loadCloseView(user);

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="cierre" parentSlug="libro">
      <div className="area-space fin-page">
        <ContabilidadSectionNav sections={visibleContabilidadSections(user)} activeId="cierre" />
        <ClosePanel user={{ id: user.id, name: user.name }} view={view} />
      </div>
    </AreaWorkspaceShell>
  );
}

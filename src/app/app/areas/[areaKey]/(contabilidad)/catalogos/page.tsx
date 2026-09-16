import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { CatalogPanel } from '@/components/areas/contabilidad/CatalogPanel';
import { ContabilidadSectionNav } from '@/components/areas/contabilidad/ContabilidadSectionNav';
import { FinanceSettingsPanel } from '@/components/areas/contabilidad/FinanceSettingsPanel';
import { visibleContabilidadSections } from '@/modules/areas/contabilidad/contabilidad-model';
import { loadCatalogView } from '@/modules/areas/contabilidad/queries';
import { saveFinanceSettingsAction } from '../actions';
import { requireContabilidadPage } from '../_guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cuentas, categorías, centros de costo y empleados (plan 6.4). */
export default async function CatalogosPage({ params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const { user, area } = await requireContabilidadPage(areaKey, [
    'finance.view',
    'finance.manage_catalog',
  ]);
  const view = await loadCatalogView(user);

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="catalogos" parentSlug="libro">
      <div className="area-space fin-page">
        <ContabilidadSectionNav sections={visibleContabilidadSections(user)} activeId="catalogos" />
        <FinanceSettingsPanel
          settings={view.settings}
          accounts={view.accounts}
          canManage={view.capabilities.manageCatalog}
          saveAction={saveFinanceSettingsAction}
        />
        <CatalogPanel user={{ id: user.id, name: user.name }} view={view} />
      </div>
    </AreaWorkspaceShell>
  );
}

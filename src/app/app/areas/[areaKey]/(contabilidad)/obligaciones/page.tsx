import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { ContabilidadSectionNav } from '@/components/areas/contabilidad/ContabilidadSectionNav';
import { ObligationsBoard } from '@/components/areas/contabilidad/ObligationsBoard';
import { visibleContabilidadSections } from '@/modules/areas/contabilidad/contabilidad-model';
import { loadCollectionsView, loadObligationsView } from '@/modules/areas/contabilidad/queries';
import { requireContabilidadPage } from '../_guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text ? text : undefined;
}

/**
 * Obligaciones por pagar y por cobrar con su antigüedad, sus pagos y los cobros
 * que todavía no encuentran su cuenta (plan 6.4 / 7.6).
 */
export default async function ObligacionesPage({
  params,
  searchParams,
}: {
  params: Promise<{ areaKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { areaKey } = await params;
  const { user, area } = await requireContabilidadPage(areaKey, [
    'finance.view',
    'finance.manage_obligations',
  ]);

  const query = await searchParams;
  const kind = first(query.tipo);
  const [view, collections] = await Promise.all([
    loadObligationsView(user, {
      ...(kind === 'payable' || kind === 'receivable' ? { kind } : {}),
      ...(first(query.estado) ? { status: first(query.estado) as string } : {}),
      ...(first(query.bucket) ? { agingBucket: first(query.bucket) as string } : {}),
      ...(first(query.vencidas) === '1' ? { overdueOnly: true } : {}),
      ...(first(query.buscar) ? { search: first(query.buscar) as string } : {}),
      ...(first(query.pagina) ? { page: Number(first(query.pagina)) } : {}),
    }),
    loadCollectionsView(user),
  ]);

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="obligaciones" parentSlug="libro">
      <div className="area-space fin-page">
        <ContabilidadSectionNav
          sections={visibleContabilidadSections(user)}
          activeId="obligaciones"
        />
        <ObligationsBoard
          user={{ id: user.id, name: user.name }}
          view={view}
          collections={collections}
          focusObligationId={first(query.obligacion) ?? null}
        />
      </div>
    </AreaWorkspaceShell>
  );
}

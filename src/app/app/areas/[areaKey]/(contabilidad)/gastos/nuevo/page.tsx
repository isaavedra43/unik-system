import { AreaWorkspaceShell } from '@/components/areas/AreaWorkspaceShell';
import { ContabilidadSectionNav } from '@/components/areas/contabilidad/ContabilidadSectionNav';
import { ExpenseQuickCapture } from '@/components/areas/contabilidad/ExpenseQuickCapture';
import {
  dateKeyOfInstant,
  visibleContabilidadSections,
} from '@/modules/areas/contabilidad/contabilidad-model';
import { loadExpenseCaptureView } from '@/modules/areas/contabilidad/queries';
import { requireContabilidadPage } from '../../_guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Capturar un gasto (plan 6.4): un botón, tres formas de hacerlo (texto, voz o
 * foto) y la propuesta de la IA lista para corregir. `?gasto=<id>` abre un
 * borrador ya capturado para terminarlo.
 */
export default async function CapturarGastoPage({
  params,
  searchParams,
}: {
  params: Promise<{ areaKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { areaKey } = await params;
  const { user, area } = await requireContabilidadPage(areaKey, [
    'finance.capture_expense',
    'finance.view',
  ]);

  const query = await searchParams;
  const raw = Array.isArray(query.gasto) ? query.gasto[0] : query.gasto;
  const focusExpenseId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;

  const view = await loadExpenseCaptureView(user, {
    ...(focusExpenseId ? { expenseId: focusExpenseId } : {}),
  });

  return (
    <AreaWorkspaceShell area={area} user={user} activeSlug="gastos">
      <div className="area-space fin-page">
        <ContabilidadSectionNav
          sections={visibleContabilidadSections(user)}
          activeId="gastos-nuevo"
        />
        <ExpenseQuickCapture
          user={{ id: user.id, name: user.name }}
          view={view}
          focusExpenseId={focusExpenseId}
          todayKey={dateKeyOfInstant(new Date())}
        />
      </div>
    </AreaWorkspaceShell>
  );
}

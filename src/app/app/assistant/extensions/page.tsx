import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { ExtensionsUserPanel } from '@/components/extensions/ExtensionsUserPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AssistantExtensionsPage({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string }>;
}) {
  const user = await requirePermission('assistant.use');
  const { oauth } = await searchParams;
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Extensiones y skills"
        description="Explora el catálogo aprobado, conecta tus cuentas cuando esté permitido y crea tus propias recetas (skills) con las herramientas ya autorizadas."
      />
      <ExtensionsUserPanel
        canConnect={hasPermission(user, 'extensions.connect')}
        oauthOutcome={oauth ?? null}
      />
    </div>
  );
}

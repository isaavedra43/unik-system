import { requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { StudioWorkspace } from '@/components/studio/StudioWorkspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /app/studio — Visual studio: block documents, versions, templates,
 * AI edits by selection and verified exports. Permission: studio.use.
 */
export default async function StudioPage() {
  const user = await requirePermission('studio.use');
  const canApprove = user.isSuperAdmin || user.permissionKeys.includes('studio.approve' as never);

  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Estudio visual"
        description="Documentos editables por bloques con versiones, plantillas, cambios por selección con IA y exportaciones verificadas (PDF, Word, Excel, CSV, PowerPoint, HTML, Markdown, SVG)."
      />
      <StudioWorkspace canApprove={canApprove} currentUserId={user.id} />
    </div>
  );
}

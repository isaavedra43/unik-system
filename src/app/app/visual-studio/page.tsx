import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { listProjects } from '@/modules/visual-studio/visual-service';
import { isSamConfigured } from '@/modules/visual-studio/sam-client';
import { VisualStudioHome } from '@/components/visual-studio/VisualStudioHome';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function VisualStudioPage() {
  const user = await requirePermission('visual_studio.view');
  const projects = await listProjects(user);
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Visual Studio"
        description="Propuestas fotorrealistas sobre fotografías reales del cliente con materiales del catálogo UNIK."
      />
      <VisualStudioHome
        initialProjects={projects}
        canEdit={hasPermission(user, 'visual_studio.edit')}
        canGenerate={hasPermission(user, 'visual_studio.generate')}
        samConfigured={isSamConfigured()}
      />
    </div>
  );
}

import { hasPermission, requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import {
  getProject,
  listAssets,
  listProposals,
  listSurfaces,
} from '@/modules/visual-studio/visual-service';
import { isSamConfigured } from '@/modules/visual-studio/sam-client';
import { VisualStudioEditor } from '@/components/visual-studio/VisualStudioEditor';
import { notFound } from 'next/navigation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function VisualStudioProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission('visual_studio.view');
  const { id } = await params;
  let data;
  try {
    const [project, assets, surfaces, proposals] = await Promise.all([
      getProject(user, id),
      listAssets(user, id),
      listSurfaces(user, id),
      listProposals(user, id),
    ]);
    data = { project, assets, surfaces, proposals };
  } catch {
    notFound();
  }
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title={data.project.name}
        description={data.project.contact?.companyName ?? data.project.contact?.contactName ?? 'Visual Studio'}
      />
      <VisualStudioEditor
        projectId={id}
        initialAssets={data.assets}
        initialSurfaces={data.surfaces}
        initialProposals={data.proposals}
        canEdit={hasPermission(user, 'visual_studio.edit')}
        canGenerate={hasPermission(user, 'visual_studio.generate')}
        canSelect={hasPermission(user, 'visual_studio.select')}
        samConfigured={isSamConfigured()}
      />
    </div>
  );
}

import { requireAnyPermission, hasPermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { ExtensionsAdminPanel } from '@/components/extensions/ExtensionsAdminPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ExtensionsAdminPage() {
  const actor = await requireAnyPermission(['extensions.view', 'extensions.manage']);
  const canManage = hasPermission(actor, 'extensions.manage');
  const canPublishSkills = hasPermission(actor, 'skills.manage');
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Extensiones del asistente"
        description="Catálogo, conexiones, servidores MCP, APIs, skills, plugins, ejecuciones y consumo. Las capacidades externas empiezan deshabilitadas y solo corren tras revisión y aprobación."
      />
      <ExtensionsAdminPanel canManage={canManage} canPublishSkills={canPublishSkills} />
    </div>
  );
}

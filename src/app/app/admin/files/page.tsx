import { requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { FilesAdminPanel } from '@/components/files/FilesAdminPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function FilesAdminPage() {
  await requirePermission('files.admin');

  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Archivos — Almacenamiento"
        description="Estado del almacenamiento de objetos (Cloudflare R2), migración de archivos heredados, respaldos, reconciliación y cuotas."
      />
      <FilesAdminPanel />
    </div>
  );
}

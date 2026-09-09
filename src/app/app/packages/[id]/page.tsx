import { notFound } from 'next/navigation';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getPackageById } from '@/modules/packages/packages-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { PACKAGE_ENTITY_TYPE } from '@/modules/packages/permissions';
import { PackageDetailPage } from '@/components/packages/PackageDetailPage';
import { getContactByZohoId } from '@/modules/cross-module/relationships-service';
import { watchAction, unwatchAction } from '../actions';

export const runtime = 'nodejs';

export default async function PackageDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) notFound();
  const { id } = await params;
  const pkg = await getPackageById(id);
  if (!pkg) notFound();
  const isWatched = await isEntityWatched(session!.user.id, PACKAGE_ENTITY_TYPE, id);
  const canWatch = session!.user.isSuperAdmin || session!.user.permissionKeys.includes('packages.watch');
  const relatedContact = pkg!.zohoCustomerId ? await getContactByZohoId(pkg!.zohoCustomerId) : null;
  return (
    <PackageDetailPage pkg={pkg!} entityLabel="Paquete" entityLabelPlural="Paquetes"
      basePath="/app/packages" isWatched={isWatched} canWatch={canWatch}
      watchAction={watchAction} unwatchAction={unwatchAction} relatedContact={relatedContact} />
  );
}

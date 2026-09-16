import { notFound, redirect } from 'next/navigation';
import { getCurrentSession, type CurrentUser } from '@/modules/auth/authorization';
import {
  areaViewPermissions,
  getArea,
  holdsAny,
  knownAreaPermissions,
  type AreaMeta,
} from '@/modules/areas/area-registry';
import { CONTABILIDAD_AREA_KEY } from '@/modules/areas/contabilidad/contabilidad-model';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';

/**
 * Gate of the Contabilidad management pages (`/app/areas/contabilidad/<sección>`).
 *
 * These routes sit next to the dynamic `[space]` segment, so they answer for
 * every area key: anything that is not Contabilidad is a 404, exactly like an
 * unknown space. Then the person must be able to open the area (`finance.view`
 * or `operations.admin`) and hold one of the permissions of the section; the
 * services and the commands check it again on the server.
 */
export async function requireContabilidadPage(
  areaKeyParam: string,
  permissions: readonly string[]
): Promise<{ user: CurrentUser; area: AreaMeta }> {
  if (areaKeyParam !== CONTABILIDAD_AREA_KEY) notFound();
  const area = getArea(areaKeyParam);
  if (!area) notFound();

  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!holdsAny(session.user, areaViewPermissions(area))) notFound();
  if (!holdsAny(session.user, knownAreaPermissions([...permissions, 'operations.admin']))) {
    notFound();
  }

  await ensureAreaRegistrations();
  return { user: session.user, area };
}

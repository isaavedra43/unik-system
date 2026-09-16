import { notFound, redirect } from 'next/navigation';
import { AREA_SPACE_SLUGS, areaHref, getArea } from '@/modules/areas/area-registry';

export const runtime = 'nodejs';

/** `/app/areas/<key>` always lands on the panel of the area. */
export default async function AreaIndexPage({ params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const area = getArea(areaKey);
  if (!area) notFound();
  redirect(areaHref(area.key, AREA_SPACE_SLUGS.dashboard));
}

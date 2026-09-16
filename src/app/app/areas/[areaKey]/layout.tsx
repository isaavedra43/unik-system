import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
// Hoja del área (sólo tokens). Next permite CSS global desde un layout.
import '@/styles/operations/area-shell.css';
import { requireAnyPermission } from '@/modules/auth/authorization';
import { areaEntryPermissions, getArea } from '@/modules/areas/area-registry';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';

export const runtime = 'nodejs';

/**
 * Coarse gate of everything under `/app/areas/<key>` (plan 7.2): the area must
 * exist and the person must be able to open at least one of its pages.
 *
 * This is deliberately NOT the authorization. Every space re-checks
 * `areaViewPermissions`, the pages with a narrower audience check their own
 * rule (the driver PWA asks for `logistics.drive | logistics.dispatch`), and
 * every action and API route checks again on the server. The layout only
 * decides whether the URL exists for this person.
 */
export default async function AreaLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ areaKey: string }>;
}) {
  const { areaKey } = await params;
  const area = getArea(areaKey);
  if (!area) notFound();
  await requireAnyPermission(areaEntryPermissions(area));
  // Domain areas register their branches, dashboards and details here.
  await ensureAreaRegistrations();
  return children;
}

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
// Hojas del área (sólo tokens). Next permite CSS global desde un layout.
import '@/styles/operations/area-shell.css';
import '@/styles/operations/inventario.css';
import { requireAnyPermission } from '@/modules/auth/authorization';
import { getArea } from '@/modules/areas/area-registry';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';

export const runtime = 'nodejs';

/**
 * Gate of the Inventario management pages (existencias, ubicaciones y
 * perfiles). They live in their own route branch because they are not a
 * filtered view of the work centre; `/app/areas/inventario/<espacio>` keeps
 * matching the generic area route for the panel, el centro de trabajo, las
 * comunicaciones, el mapa, los conteos y los movimientos.
 *
 * The permission asked here is `inventory.view`, the same key the module's own
 * reads require: somebody with `operations.admin` but without it would see an
 * empty page, so it is better to say it out loud.
 */
export default async function InventoryPagesLayout({ children }: { children: ReactNode }) {
  if (!getArea('inventario')) notFound();
  await requireAnyPermission(['inventory.view']);
  await ensureAreaRegistrations();
  return children;
}

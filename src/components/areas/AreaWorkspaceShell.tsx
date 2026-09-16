import type { ReactNode } from 'react';
import { prisma } from '@/lib/prisma';
import { PageHeader, TabNav } from '@/components/ui/composite';
import type { CurrentUser } from '@/modules/auth/authorization';
import { areaHref, visibleAreaSpaces, type AreaMeta } from '@/modules/areas/area-registry';
import { AreaRealtimeBadge } from './AreaRealtimeBadge';
import { OfflineBadge } from './OfflineBadge';

export interface AreaWorkspaceShellProps {
  area: AreaMeta;
  user: CurrentUser;
  /** Slug of the space being shown (drives the active tab). */
  activeSlug: string;
  /**
   * Tab to underline when `activeSlug` is a management page that is NOT a space
   * of the registry (Obligaciones, Nómina, Flotilla…). Without it the person
   * lands on a page the area's own navigation does not recognize.
   */
  parentSlug?: string;
  children: ReactNode;
}

/**
 * Shell of an area (plan 7.2): who leads it, whether it is moving right now and
 * the four spaces (panel, centro de trabajo, comunicaciones, vista especial)
 * plus the area's own detail pages. Server Component: the only client part is
 * the realtime chip.
 *
 * Tabs are hidden when the person lacks their permission; every page and action
 * checks again on the server.
 */
export async function AreaWorkspaceShell({
  area,
  user,
  activeSlug,
  parentSlug,
  children,
}: AreaWorkspaceShellProps) {
  const record = await prisma.area.findUnique({
    where: { key: area.key },
    select: { label: true, leadUserId: true, responsibleArea: true },
  });
  const responsible = record?.responsibleArea
    ? await prisma.responsible.findUnique({
        where: { area: record.responsibleArea },
        select: { userId: true, backupUserId: true, active: true },
      })
    : null;

  const userIds = [record?.leadUserId, responsible?.userId, responsible?.backupUserId].filter(
    (id): id is string => Boolean(id)
  );
  const people =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: [...new Set(userIds)] } },
          select: { id: true, name: true },
        })
      : [];
  const nameOf = (id: string | null | undefined) =>
    id ? (people.find((person) => person.id === id)?.name ?? null) : null;

  const lead = nameOf(record?.leadUserId);
  const owner = responsible?.active ? nameOf(responsible.userId) : null;
  const backup = responsible?.active ? nameOf(responsible.backupUserId) : null;
  const spaces = visibleAreaSpaces(area, user);
  const peopleLine = [
    `Responsable: ${owner ?? 'sin asignar'}`,
    ...(backup ? [`suplente: ${backup}`] : []),
    ...(lead ? [`líder: ${lead}`] : []),
    ...(owner ? [] : ['configúralo en Canales y responsables']),
  ].join(' · ');
  // A management page outside the registry underlines the space it hangs from.
  const activeTab = spaces.some((space) => space.slug === activeSlug)
    ? activeSlug
    : (parentSlug ?? activeSlug);

  return (
    <div className="area-shell">
      {/*
        Una sola línea de contexto: quién responde por el área viaja en la
        descripción del encabezado. Antes gastaba una franja propia de ~60 px
        con su icono en caja para un solo dato, justo lo contrario de la regla
        de densidad del sistema.
      */}
      <PageHeader
        title={record?.label || area.label}
        description={`${area.description} · ${peopleLine}`}
        actions={
          <>
            <OfflineBadge userId={user.id} />
            <AreaRealtimeBadge areaKey={area.key} areaLabel={area.label} />
          </>
        }
      />

      {spaces.length > 1 ? (
        <TabNav
          activeId={activeTab}
          tabs={spaces.map((space) => ({
            id: space.slug,
            label: space.label,
            href: areaHref(area.key, space.slug),
          }))}
        />
      ) : null}

      {children}
    </div>
  );
}

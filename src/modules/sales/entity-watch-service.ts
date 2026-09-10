import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { AuthorizationError, CurrentUser } from '@/modules/auth/authorization';

/**
 * Generic entity watch service.
 * Allows users to follow entities and receive notifications on change.
 */

export const SALES_ORDER_ENTITY_TYPE = 'sales_order';

interface EntityWatchRow {
  id: string;
  userId: string;
  entityType: string;
  entityId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function formatRow(row: {
  id: string;
  userId: string;
  entityType: string;
  entityId: string;
  config: Prisma.JsonValue | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): EntityWatchRow {
  return {
    id: row.id,
    userId: row.userId,
    entityType: row.entityType,
    entityId: row.entityId,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function watchEntity(
  user: CurrentUser,
  entityType: string,
  entityId: string
): Promise<EntityWatchRow> {
  const existing = await prisma.entityWatch.findUnique({
    where: {
      userId_entityType_entityId: { userId: user.id, entityType, entityId },
    },
  });

  if (existing) {
    if (existing.isActive) return formatRow(existing);
    const row = await prisma.entityWatch.update({
      where: { id: existing.id },
      data: { isActive: true },
    });
    return formatRow(row);
  }

  const row = await prisma.entityWatch.create({
    data: { userId: user.id, entityType, entityId },
  });

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'sales_orders.watch_started',
    targetType: entityType,
    targetId: entityId,
  });

  return formatRow(row);
}

export async function unwatchEntity(
  user: CurrentUser,
  entityType: string,
  entityId: string
): Promise<void> {
  await prisma.entityWatch.updateMany({
    where: { userId: user.id, entityType, entityId },
    data: { isActive: false },
  });

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'sales_orders.watch_stopped',
    targetType: entityType,
    targetId: entityId,
  });
}

export async function bulkWatchEntities(
  user: CurrentUser,
  entityType: string,
  entityIds: string[]
): Promise<void> {
  if (entityIds.length === 0) return;

  await prisma.$transaction(
    entityIds.map((entityId) =>
      prisma.entityWatch.upsert({
        where: {
          userId_entityType_entityId: { userId: user.id, entityType, entityId },
        },
        create: { userId: user.id, entityType, entityId },
        update: { isActive: true },
      })
    )
  );

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'sales_orders.watch_started',
    targetType: entityType,
    metadata: { count: entityIds.length },
  });
}

export async function bulkUnwatchEntities(
  user: CurrentUser,
  entityType: string,
  entityIds: string[]
): Promise<void> {
  if (entityIds.length === 0) return;

  await prisma.entityWatch.updateMany({
    where: {
      userId: user.id,
      entityType,
      entityId: { in: entityIds },
    },
    data: { isActive: false },
  });

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'sales_orders.watch_stopped',
    targetType: entityType,
    metadata: { count: entityIds.length },
  });
}

export async function getWatchedEntityIds(
  userId: string,
  entityType: string,
  entityIds: string[]
): Promise<Set<string>> {
  if (entityIds.length === 0) return new Set();
  const watches = await prisma.entityWatch.findMany({
    where: {
      userId,
      entityType,
      entityId: { in: entityIds },
      isActive: true,
    },
    select: { entityId: true },
  });
  return new Set(watches.map((w) => w.entityId));
}

export async function isEntityWatched(
  userId: string,
  entityType: string,
  entityId: string
): Promise<boolean> {
  const watch = await prisma.entityWatch.findUnique({
    where: {
      userId_entityType_entityId: { userId, entityType, entityId },
    },
    select: { isActive: true },
  });
  return watch?.isActive ?? false;
}

export async function getActiveWatchers(
  entityType: string,
  entityId: string
): Promise<{ userId: string }[]> {
  const watches = await prisma.entityWatch.findMany({
    where: { entityType, entityId, isActive: true },
    select: { userId: true },
  });
  return watches;
}

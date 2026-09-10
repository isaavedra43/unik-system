import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
  salesOrderViewConfigSchema,
  tableViewVisibilitySchema,
  TablePreferenceConfig,
  SalesOrderQueryState,
} from './sales-orders-filters';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { AuthorizationError, CurrentUser } from '@/modules/auth/authorization';

/**
 * Generic saved table views service.
 * Reusable across modules via `tableKey`.
 */

export interface TableViewRow {
  id: string;
  ownerUserId: string;
  tableKey: string;
  name: string;
  visibility: 'private' | 'shared';
  config: unknown;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  isOwner: boolean;
}

function formatRow(
  row: {
    id: string;
    ownerUserId: string;
    tableKey: string;
    name: string;
    visibility: string;
    config: Prisma.JsonValue;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  userId: string
): TableViewRow {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    tableKey: row.tableKey,
    name: row.name,
    visibility: tableViewVisibilitySchema.parse(row.visibility),
    config: row.config,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    isOwner: row.ownerUserId === userId,
  };
}

export async function listTableViews(
  userId: string,
  tableKey: string
): Promise<{ privateViews: TableViewRow[]; sharedViews: TableViewRow[] }> {
  const rows = await prisma.tableView.findMany({
    where: {
      tableKey,
      OR: [{ ownerUserId: userId }, { visibility: 'shared' }],
    },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });

  const formatted = rows.map((r) => formatRow(r, userId));
  return {
    privateViews: formatted.filter((r) => r.ownerUserId === userId && r.visibility === 'private'),
    sharedViews: formatted.filter((r) => r.visibility === 'shared'),
  };
}

export async function getTableView(userId: string, viewId: string): Promise<TableViewRow | null> {
  const row = await prisma.tableView.findUnique({ where: { id: viewId } });
  if (!row) return null;
  // Private views: only owner. Shared views: any authenticated user (caller
  // must already have the module's view permission at the page level).
  if (row.visibility === 'private' && row.ownerUserId !== userId) return null;
  return formatRow(row, userId);
}

interface CreateTableViewInput {
  tableKey: string;
  name: string;
  visibility: 'private' | 'shared';
  config: unknown;
  isDefault?: boolean;
}

export async function createTableView(
  user: CurrentUser,
  input: CreateTableViewInput
): Promise<TableViewRow> {
  if (input.visibility === 'shared') {
    // Caller must have sales_orders.share_views — checked at action layer.
    // Double-check here for defense in depth.
    if (!user.isSuperAdmin && !user.permissionKeys.includes('sales_orders.share_views')) {
      throw new AuthorizationError('No puedes compartir vistas');
    }
  }

  const validatedConfig = salesOrderViewConfigSchema.parse(input.config);

  const row = await prisma.tableView.create({
    data: {
      ownerUserId: user.id,
      tableKey: input.tableKey,
      name: input.name.trim(),
      visibility: input.visibility,
      config: validatedConfig as unknown as Prisma.InputJsonValue,
      isDefault: input.isDefault ?? false,
    },
  });

  if (input.isDefault) {
    await setDefaultTableView(user.id, input.tableKey, row.id);
  }

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'sales_orders.view_created',
    targetType: 'TableView',
    targetId: row.id,
    metadata: { name: input.name, visibility: input.visibility, tableKey: input.tableKey },
  });

  return formatRow(row, user.id);
}

export async function updateTableView(
  user: CurrentUser,
  viewId: string,
  updates: { name?: string; config?: unknown; isDefault?: boolean }
): Promise<TableViewRow> {
  const existing = await prisma.tableView.findUnique({ where: { id: viewId } });
  if (!existing) throw new Error('Vista no encontrada');
  if (existing.ownerUserId !== user.id && !user.isSuperAdmin) {
    throw new AuthorizationError('No puedes editar esta vista');
  }

  const data: Prisma.TableViewUpdateInput = {};
  if (updates.name !== undefined) data.name = updates.name.trim();
  if (updates.config !== undefined) {
    const validated = salesOrderViewConfigSchema.parse(updates.config);
    data.config = validated as unknown as Prisma.InputJsonValue;
  }
  if (updates.isDefault !== undefined) data.isDefault = updates.isDefault;

  const row = await prisma.tableView.update({ where: { id: viewId }, data });
  if (updates.isDefault === true) {
    await setDefaultTableView(user.id, existing.tableKey, viewId);
  }

  return formatRow(row, user.id);
}

export async function deleteTableView(user: CurrentUser, viewId: string): Promise<void> {
  const existing = await prisma.tableView.findUnique({ where: { id: viewId } });
  if (!existing) return;
  if (existing.ownerUserId !== user.id && !user.isSuperAdmin) {
    throw new AuthorizationError('No puedes eliminar esta vista');
  }

  await prisma.tableView.delete({ where: { id: viewId } });

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'sales_orders.view_deleted',
    targetType: 'TableView',
    targetId: viewId,
    metadata: { tableKey: existing.tableKey },
  });
}

export async function shareTableView(user: CurrentUser, viewId: string): Promise<TableViewRow> {
  const existing = await prisma.tableView.findUnique({ where: { id: viewId } });
  if (!existing) throw new Error('Vista no encontrada');
  if (existing.ownerUserId !== user.id && !user.isSuperAdmin) {
    throw new AuthorizationError('No puedes compartir esta vista');
  }
  if (!user.isSuperAdmin && !user.permissionKeys.includes('sales_orders.share_views')) {
    throw new AuthorizationError('No tienes permiso para compartir vistas');
  }

  const row = await prisma.tableView.update({
    where: { id: viewId },
    data: { visibility: 'shared' },
  });

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'sales_orders.view_shared',
    targetType: 'TableView',
    targetId: viewId,
    metadata: { tableKey: existing.tableKey },
  });

  return formatRow(row, user.id);
}

export async function unshareTableView(user: CurrentUser, viewId: string): Promise<TableViewRow> {
  const existing = await prisma.tableView.findUnique({ where: { id: viewId } });
  if (!existing) throw new Error('Vista no encontrada');
  if (existing.ownerUserId !== user.id && !user.isSuperAdmin) {
    throw new AuthorizationError('No puedes dejar de compartir esta vista');
  }

  const row = await prisma.tableView.update({
    where: { id: viewId },
    data: { visibility: 'private' },
  });

  await recordAuditEvent({
    actorUserId: user.id,
    action: 'sales_orders.view_unshared',
    targetType: 'TableView',
    targetId: viewId,
    metadata: { tableKey: existing.tableKey },
  });

  return formatRow(row, user.id);
}

async function setDefaultTableView(
  userId: string,
  tableKey: string,
  viewId: string
): Promise<void> {
  await prisma.$transaction([
    prisma.tableView.updateMany({
      where: { ownerUserId: userId, tableKey, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.tableView.update({ where: { id: viewId }, data: { isDefault: true } }),
  ]);
}

export async function getDefaultTableView(
  userId: string,
  tableKey: string
): Promise<TableViewRow | null> {
  const row = await prisma.tableView.findFirst({
    where: { ownerUserId: userId, tableKey, isDefault: true },
  });
  return row ? formatRow(row, userId) : null;
}

export async function duplicateTableView(
  user: CurrentUser,
  viewId: string,
  newName: string
): Promise<TableViewRow> {
  const existing = await prisma.tableView.findUnique({ where: { id: viewId } });
  if (!existing) throw new Error('Vista no encontrada');
  // Can duplicate private (own) or shared views.
  if (existing.visibility === 'private' && existing.ownerUserId !== user.id) {
    throw new AuthorizationError('No puedes duplicar esta vista');
  }

  const row = await prisma.tableView.create({
    data: {
      ownerUserId: user.id,
      tableKey: existing.tableKey,
      name: newName.trim(),
      visibility: 'private',
      config: existing.config as Prisma.InputJsonValue,
      isDefault: false,
    },
  });

  return formatRow(row, user.id);
}

export type { TablePreferenceConfig, SalesOrderQueryState };

import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { tablePreferenceConfigSchema, TablePreferenceConfig } from './sales-orders-filters';

/**
 * Generic per-user table preferences service.
 * Reusable across modules via `tableKey`.
 * Source of persistence: PostgreSQL.
 */

export async function getUserTablePreference(
  userId: string,
  tableKey: string
): Promise<TablePreferenceConfig | null> {
  const row = await prisma.userTablePreference.findUnique({
    where: { userId_tableKey: { userId, tableKey } },
  });
  if (!row) return null;
  const parsed = tablePreferenceConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : null;
}

export async function upsertUserTablePreference(
  userId: string,
  tableKey: string,
  config: TablePreferenceConfig
): Promise<TablePreferenceConfig> {
  const validated = tablePreferenceConfigSchema.parse(config);
  await prisma.userTablePreference.upsert({
    where: { userId_tableKey: { userId, tableKey } },
    create: { userId, tableKey, config: validated as unknown as Prisma.InputJsonValue },
    update: { config: validated as unknown as Prisma.InputJsonValue },
  });
  return validated;
}

export async function deleteUserTablePreference(userId: string, tableKey: string): Promise<void> {
  await prisma.userTablePreference.deleteMany({
    where: { userId, tableKey },
  });
}

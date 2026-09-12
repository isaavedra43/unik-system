import { prisma } from '@/lib/prisma';

/**
 * Consumption meters per dimension (storage, operation, user, team, provider,
 * extension, job) aggregated per day. Cheap upserts; read by the admin
 * "Consumo" tab and by capacity planning.
 */
export type UsageDimension =
  'extension' | 'provider' | 'user' | 'team' | 'storage' | 'job' | 'campaign' | 'calls';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function recordUsage(
  dimension: UsageDimension,
  key: string,
  unit: string,
  amount: number,
  period: string = today()
): Promise<void> {
  await prisma.usageMeter.upsert({
    where: { dimension_key_period_unit: { dimension, key, period, unit } },
    create: { dimension, key, period, unit, count: 1, amount },
    update: { count: { increment: 1 }, amount: { increment: amount } },
  });
}

export async function getUsage(
  dimension: UsageDimension,
  options: { key?: string; from?: string; to?: string; limit?: number } = {}
) {
  const rows = await prisma.usageMeter.findMany({
    where: {
      dimension,
      ...(options.key ? { key: options.key } : {}),
      ...(options.from || options.to
        ? {
            period: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ period: 'desc' }, { key: 'asc' }],
    take: Math.min(options.limit ?? 500, 5000),
  });
  return rows.map((r) => ({
    dimension: r.dimension,
    key: r.key,
    period: r.period,
    unit: r.unit,
    count: r.count,
    amount: r.amount.toString(),
  }));
}

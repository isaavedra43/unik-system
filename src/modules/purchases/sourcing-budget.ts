import type { Prisma } from '@prisma/client';
import { recordUsage } from '@/modules/extensions/usage-meter';

/**
 * Daily budget of the Sourcing Lab in `UsageMeter` (plan 6.1).
 *
 * The estimated units of a search are RESERVED atomically when it is queued
 * (a conditional increment that never lets the day exceed the budget, even
 * with concurrent searches or an AI in a loop) and the unused part is released
 * when the provider finishes. A job that times out keeps its reservation
 * charged (what it spent is never lost) and a retry reserves again before it
 * spends anything.
 */

export const SOURCING_USAGE_KEY = 'sourcing';

type MeterDb = Pick<Prisma.TransactionClient, 'usageMeter'>;

/** UTC day of the usage period (same period as `recordUsage`). */
export function sourcingDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function unitsKey(day: string) {
  return { dimension: 'extension', key: SOURCING_USAGE_KEY, period: day, unit: 'units' };
}

export async function sourcingUnitsUsed(db: MeterDb, at: Date): Promise<number> {
  const row = await db.usageMeter.findUnique({
    where: { dimension_key_period_unit: unitsKey(sourcingDay(at)) },
    select: { amount: true },
  });
  return row ? Number(row.amount.toString()) : 0;
}

/** Reserves `units` of the day when they fit in `dailyBudget` (atomic: one conditional UPDATE). */
export async function reserveSourcingUnits(
  db: MeterDb,
  input: { units: number; dailyBudget: number; at: Date }
): Promise<boolean> {
  if (input.units <= 0) return true;
  if (input.units > input.dailyBudget) return false;
  const key = unitsKey(sourcingDay(input.at));
  await db.usageMeter.upsert({
    where: { dimension_key_period_unit: key },
    create: { ...key, count: 0, amount: 0 },
    update: {},
  });
  const updated = await db.usageMeter.updateMany({
    where: { ...key, amount: { lte: input.dailyBudget - input.units } },
    data: { amount: { increment: input.units }, count: { increment: 1 } },
  });
  return updated.count === 1;
}

/** Gives back the part of a reservation the provider did not spend (never below zero). */
export async function releaseSourcingUnits(
  db: MeterDb,
  input: { units: number; day: string }
): Promise<void> {
  if (input.units <= 0) return;
  const key = unitsKey(input.day);
  await db.usageMeter.updateMany({
    where: { ...key, amount: { gte: input.units } },
    data: { amount: { increment: -input.units } },
  });
}

/**
 * Units spent beyond the reservation (the estimate is the maximum a provider can spend, so normally none).
 *
 * `day` is the day the units were RESERVED, not the day the provider finished:
 * a search queued just before UTC midnight whose job runs after it must charge
 * and release against the same period it reserved, or the reservation is never
 * given back and that day's budget shrinks for good.
 */
export async function chargeSourcingUnits(units: number, day: string): Promise<void> {
  if (units <= 0) return;
  await recordUsage('extension', SOURCING_USAGE_KEY, 'units', units, day);
}

/** Counts one finished search on the day its units were reserved (same period as the spend). */
export async function countSourcingSearch(providerKey: string, day: string): Promise<void> {
  await recordUsage('extension', `${SOURCING_USAGE_KEY}:${providerKey}`, 'searches', 1, day);
}

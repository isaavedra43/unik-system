import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';

/**
 * Settings of the internal accounting: one `IntegrationConfig` row with
 * `source = 'finance'` (same table as the operations config, own file). A
 * missing row means the defaults; the row is created on the first update.
 *
 * Inside a command transaction read with `readFinanceSettings(tx)` (never the
 * cached global reader, which would ask the pool for a second connection).
 */

export const FINANCE_CONFIG_SOURCE = 'finance' as const;
export const FINANCE_CONFIG_DISPLAY_NAME = 'Contabilidad interna';
const CACHE_TTL_MS = 10_000;

export interface FinanceSettings {
  /** CashAccount.key that receives the synced Zoho customer payments ("Banco (Zoho)"). */
  collectionsCashAccountKey: string;
  /** Obligations due within these days raise a `finance_alert`. */
  obligationsDueAlertDays: number;
  /** Customer payments older than these days are not reconciled any more. */
  reconcileLookbackDays: number;
  /** Months of expense history used to suggest classification. */
  expenseHistoryMonths: number;
  /** Remind the close owners when yesterday was not closed. */
  dailyCloseReminder: boolean;
}

export function defaultFinanceSettings(): FinanceSettings {
  return {
    collectionsCashAccountKey: 'banco_zoho',
    obligationsDueAlertDays: 3,
    reconcileLookbackDays: 120,
    expenseHistoryMonths: 6,
    dailyCloseReminder: true,
  };
}

const FIELD_SCHEMAS = {
  collectionsCashAccountKey: z.string().trim().regex(/^[a-z][a-z0-9_]{1,59}$/),
  obligationsDueAlertDays: z.number().int().min(0).max(60),
  reconcileLookbackDays: z.number().int().min(1).max(730),
  expenseHistoryMonths: z.number().int().min(1).max(24),
  dailyCloseReminder: z.boolean(),
} as const;

export function normalizeFinanceSettings(stored: unknown): FinanceSettings {
  const defaults = defaultFinanceSettings();
  const source =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const pick = <K extends keyof FinanceSettings>(key: K): FinanceSettings[K] => {
    const parsed = FIELD_SCHEMAS[key].safeParse(source[key]);
    return (parsed.success ? parsed.data : defaults[key]) as FinanceSettings[K];
  };
  return {
    collectionsCashAccountKey: pick('collectionsCashAccountKey'),
    obligationsDueAlertDays: pick('obligationsDueAlertDays'),
    reconcileLookbackDays: pick('reconcileLookbackDays'),
    expenseHistoryMonths: pick('expenseHistoryMonths'),
    dailyCloseReminder: pick('dailyCloseReminder'),
  };
}

export const financeSettingsPatchSchema = z
  .object({
    collectionsCashAccountKey: FIELD_SCHEMAS.collectionsCashAccountKey.optional(),
    obligationsDueAlertDays: FIELD_SCHEMAS.obligationsDueAlertDays.optional(),
    reconcileLookbackDays: FIELD_SCHEMAS.reconcileLookbackDays.optional(),
    expenseHistoryMonths: FIELD_SCHEMAS.expenseHistoryMonths.optional(),
    dailyCloseReminder: FIELD_SCHEMAS.dailyCloseReminder.optional(),
  })
  .strict();

export type FinanceSettingsPatch = z.input<typeof financeSettingsPatchSchema>;

type Db = Pick<Prisma.TransactionClient, 'integrationConfig'>;

/** Uncached read (use inside transactions with `tx`). */
export async function readFinanceSettings(db: Db = prisma): Promise<FinanceSettings> {
  const row = await db.integrationConfig.findUnique({ where: { source: FINANCE_CONFIG_SOURCE } });
  return normalizeFinanceSettings(row?.settings ?? null);
}

let cached: { settings: FinanceSettings; at: number } | null = null;

export async function getFinanceSettings(): Promise<FinanceSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.settings;
  const settings = await readFinanceSettings(prisma);
  cached = { settings, at: Date.now() };
  return settings;
}

export function invalidateFinanceSettingsCache(): void {
  cached = null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Validated partial update (`finance.manage_catalog`). */
export async function updateFinanceSettings(
  actor: CurrentUser,
  patch: FinanceSettingsPatch
): Promise<FinanceSettings> {
  if (!hasPermission(actor, 'finance.manage_catalog')) {
    throw new OperationsError('forbidden', 'No tienes permisos para configurar la contabilidad');
  }
  const parsed = financeSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_config',
      `Configuración inválida: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  }
  const current = await readFinanceSettings(prisma);
  const next: FinanceSettings = {
    ...current,
    ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)),
  };
  const settings = next as unknown as Prisma.InputJsonValue;
  const updated = await prisma.integrationConfig.updateMany({
    where: { source: FINANCE_CONFIG_SOURCE },
    data: { settings },
  });
  if (updated.count === 0) {
    try {
      await prisma.integrationConfig.create({
        data: {
          source: FINANCE_CONFIG_SOURCE,
          displayName: FINANCE_CONFIG_DISPLAY_NAME,
          isEnabled: true,
          settings,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await prisma.integrationConfig.updateMany({ where: { source: FINANCE_CONFIG_SOURCE }, data: { settings } });
    }
  }
  invalidateFinanceSettingsCache();
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'finance.config.updated',
    targetType: 'integration_config',
    targetId: FINANCE_CONFIG_SOURCE,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return next;
}

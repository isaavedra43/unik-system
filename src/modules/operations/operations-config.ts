import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { OperationsError } from './errors';
import { ESCALATION_RUNGS, WORK_ITEM_KINDS, type EscalationRung, type WorkItemKind } from './types';

/**
 * Runtime configuration of the operations core: one `IntegrationConfig` row
 * with `source = 'operations'` (same table and cache pattern as
 * `integration-config-service.ts`, kept in its own file).
 *
 * Settings are nested (flags, SLAs, escalation, thresholds), so every field is
 * normalized on its own: a missing or invalid stored value falls back to its
 * default without discarding the valid ones. The flat merge helper of the
 * integrations service is private and only handles flat primitive bags, so it
 * is not reused here.
 *
 * Decision of the owner (2026-09-15): everything works from minute one, so
 * every flag is seeded `true`. The safety brakes are `cutoverDate` (seeded to
 * the seeding instant: only orders created afterwards start a case on their
 * own), permissions, budgets and the AI schedule. `isEnabled = false` on the
 * row is the kill switch that turns every flag off at once.
 *
 * Seeding tolerates concurrent boots: the row is created with a plain INSERT
 * outside any transaction and a unique violation just re-reads the winner.
 */

export const OPERATIONS_CONFIG_SOURCE = 'operations' as const;
export const OPERATIONS_CONFIG_DISPLAY_NAME = 'Operaciones';
const CACHE_TTL_MS = 10_000;

export const OPS_FLAGS = [
  'salesToCase',
  'inventory',
  'logistics',
  'purchases',
  'manufacturing',
  'finance',
  'crm',
  'agents',
  'supervisor',
  /**
   * Real POST of sales orders from CRM (plan 6.5): off until the exact field set was validated against
   * the real Zoho organization. The mock (ZOHO_BOOKS_MOCK) is never gated.
   */
  'crmSalesOrderWrite',
] as const;
export type OpsFlag = (typeof OPS_FLAGS)[number];

export const OPS_FLAG_LABELS: Record<OpsFlag, string> = {
  salesToCase: 'Expediente automático al llegar una venta',
  inventory: 'Inventario progresivo',
  logistics: 'Logística',
  purchases: 'Compras y sourcing',
  manufacturing: 'Manufactura',
  finance: 'Contabilidad interna',
  crm: 'CRM y radar de cierre',
  agents: 'IA coordinadora por área',
  supervisor: 'Supervisor automático',
  crmSalesOrderWrite: 'Crear órdenes de venta en Zoho desde el CRM (validar primero con la organización real)',
};

export interface OperationsSettings {
  /** ISO instant: sales orders created in Zoho before it never start a case on their own. */
  cutoverDate: string;
  flags: Record<OpsFlag, boolean>;
  /** When non-empty, only orders of these Zoho locations start automatically. */
  pilotLocationIds: string[];
  /** Default SLA in minutes per work item / step kind. */
  slaDefaults: Record<WorkItemKind, number>;
  escalation: { afterMinutes: number[]; ladder: EscalationRung[] };
  externalSyncStaleMinutes: number;
  legacyClaimTtlDays: number;
  reservationAlertDays: number;
  provisionalVerificationMaxHours: number;
  approvalThresholds: { procurementDoubleApprovalMxn: number; expenseAutoApproveMxn: number };
}

export interface OperationsConfig extends OperationsSettings {
  /** Kill switch of the whole core (IntegrationConfig.isEnabled). */
  isEnabled: boolean;
  updatedAt: string;
}

/** Defaults; `cutoverDate` is the seeding instant. */
export function defaultOperationsSettings(now: Date = new Date()): OperationsSettings {
  return {
    cutoverDate: now.toISOString(),
    flags: {
      salesToCase: true,
      inventory: true,
      logistics: true,
      purchases: true,
      manufacturing: true,
      finance: true,
      crm: true,
      agents: true,
      supervisor: true,
      crmSalesOrderWrite: false,
    },
    pilotLocationIds: [],
    slaDefaults: {
      action: 240,
      wait: 1440,
      approval: 240,
      verification: 120,
      external_sync: 60,
      incident_followup: 240,
    },
    escalation: { afterMinutes: [0, 120, 480], ladder: ['backup', 'area_lead', 'administracion'] },
    externalSyncStaleMinutes: 15,
    legacyClaimTtlDays: 14,
    reservationAlertDays: 7,
    provisionalVerificationMaxHours: 72,
    approvalThresholds: { procurementDoubleApprovalMxn: 50_000, expenseAutoApproveMxn: 2_000 },
  };
}

// ---------------------------------------------------------------------------
// Field schemas (shared by normalization and patch validation)
// ---------------------------------------------------------------------------

const MAX_MINUTES = 525_600; // one year
const intIn = (min: number, max: number) => z.number().int().min(min).max(max);

const cutoverDateSchema = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value)), {
    message: 'Fecha de corte inválida (usa formato ISO)',
  })
  .transform((value) => new Date(value).toISOString());

const flagSchema = z.boolean();
const pilotLocationIdsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(500)
  .transform((ids) => [...new Set(ids)]);
const slaMinutesSchema = intIn(0, MAX_MINUTES);
const afterMinutesSchema = z
  .array(intIn(0, MAX_MINUTES))
  .min(1)
  .max(10)
  .refine((list) => list.every((value, i) => i === 0 || value >= list[i - 1]), {
    message: 'Los minutos de escalación deben ir de menor a mayor',
  });
const ladderSchema = z.array(z.enum(ESCALATION_RUNGS)).min(1).max(10);
const moneySchema = z.number().finite().min(0).max(1e12);

const SCALAR_FIELDS = {
  externalSyncStaleMinutes: intIn(1, 1440),
  legacyClaimTtlDays: intIn(1, 365),
  reservationAlertDays: intIn(1, 365),
  provisionalVerificationMaxHours: intIn(1, 8760),
} as const;

function pick<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Pure: stored JSON → complete settings. `cutoverRepaired` is true when the
 * stored cutover was missing or invalid and had to take `now` (the caller
 * persists it once so it does not move on every read).
 */
export function normalizeOperationsSettings(
  stored: unknown,
  now: Date = new Date()
): { settings: OperationsSettings; cutoverRepaired: boolean } {
  const defaults = defaultOperationsSettings(now);
  const s = asRecord(stored);
  const flags = asRecord(s.flags);
  const sla = asRecord(s.slaDefaults);
  const escalation = asRecord(s.escalation);
  const thresholds = asRecord(s.approvalThresholds);

  const cutover = cutoverDateSchema.safeParse(s.cutoverDate);
  const settings: OperationsSettings = {
    cutoverDate: cutover.success ? cutover.data : defaults.cutoverDate,
    flags: Object.fromEntries(
      OPS_FLAGS.map((flag) => [flag, pick(flagSchema, flags[flag], defaults.flags[flag])])
    ) as Record<OpsFlag, boolean>,
    pilotLocationIds: pick(pilotLocationIdsSchema, s.pilotLocationIds, defaults.pilotLocationIds),
    slaDefaults: Object.fromEntries(
      WORK_ITEM_KINDS.map((kind) => [
        kind,
        pick(slaMinutesSchema, sla[kind], defaults.slaDefaults[kind]),
      ])
    ) as Record<WorkItemKind, number>,
    escalation: {
      afterMinutes: pick(
        afterMinutesSchema,
        escalation.afterMinutes,
        defaults.escalation.afterMinutes
      ),
      ladder: pick(ladderSchema, escalation.ladder, defaults.escalation.ladder),
    },
    externalSyncStaleMinutes: pick(
      SCALAR_FIELDS.externalSyncStaleMinutes,
      s.externalSyncStaleMinutes,
      defaults.externalSyncStaleMinutes
    ),
    legacyClaimTtlDays: pick(
      SCALAR_FIELDS.legacyClaimTtlDays,
      s.legacyClaimTtlDays,
      defaults.legacyClaimTtlDays
    ),
    reservationAlertDays: pick(
      SCALAR_FIELDS.reservationAlertDays,
      s.reservationAlertDays,
      defaults.reservationAlertDays
    ),
    provisionalVerificationMaxHours: pick(
      SCALAR_FIELDS.provisionalVerificationMaxHours,
      s.provisionalVerificationMaxHours,
      defaults.provisionalVerificationMaxHours
    ),
    approvalThresholds: {
      procurementDoubleApprovalMxn: pick(
        moneySchema,
        thresholds.procurementDoubleApprovalMxn,
        defaults.approvalThresholds.procurementDoubleApprovalMxn
      ),
      expenseAutoApproveMxn: pick(
        moneySchema,
        thresholds.expenseAutoApproveMxn,
        defaults.approvalThresholds.expenseAutoApproveMxn
      ),
    },
  };
  return { settings, cutoverRepaired: !cutover.success };
}

const optionalShape = <K extends string, S extends z.ZodTypeAny>(keys: readonly K[], schema: S) =>
  z
    .object(
      Object.fromEntries(keys.map((key) => [key, schema.optional()])) as Record<K, z.ZodOptional<S>>
    )
    .strict();

export const operationsConfigPatchSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    cutoverDate: cutoverDateSchema.optional(),
    flags: optionalShape(OPS_FLAGS, flagSchema).optional(),
    pilotLocationIds: pilotLocationIdsSchema.optional(),
    slaDefaults: optionalShape(WORK_ITEM_KINDS, slaMinutesSchema).optional(),
    escalation: z
      .object({ afterMinutes: afterMinutesSchema.optional(), ladder: ladderSchema.optional() })
      .strict()
      .optional(),
    externalSyncStaleMinutes: SCALAR_FIELDS.externalSyncStaleMinutes.optional(),
    legacyClaimTtlDays: SCALAR_FIELDS.legacyClaimTtlDays.optional(),
    reservationAlertDays: SCALAR_FIELDS.reservationAlertDays.optional(),
    provisionalVerificationMaxHours: SCALAR_FIELDS.provisionalVerificationMaxHours.optional(),
    approvalThresholds: z
      .object({
        procurementDoubleApprovalMxn: moneySchema.optional(),
        expenseAutoApproveMxn: moneySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OperationsConfigPatch = z.input<typeof operationsConfigPatchSchema>;
type ParsedPatch = z.output<typeof operationsConfigPatchSchema>;

/** Pure deep merge of a validated patch over complete settings. */
export function applyOperationsPatch(
  current: OperationsSettings,
  patch: ParsedPatch
): OperationsSettings {
  const defined = <T extends object>(obj: T | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
  return {
    cutoverDate: patch.cutoverDate ?? current.cutoverDate,
    flags: { ...current.flags, ...defined(patch.flags) },
    pilotLocationIds: patch.pilotLocationIds ?? current.pilotLocationIds,
    slaDefaults: { ...current.slaDefaults, ...defined(patch.slaDefaults) },
    escalation: { ...current.escalation, ...defined(patch.escalation) },
    externalSyncStaleMinutes: patch.externalSyncStaleMinutes ?? current.externalSyncStaleMinutes,
    legacyClaimTtlDays: patch.legacyClaimTtlDays ?? current.legacyClaimTtlDays,
    reservationAlertDays: patch.reservationAlertDays ?? current.reservationAlertDays,
    provisionalVerificationMaxHours:
      patch.provisionalVerificationMaxHours ?? current.provisionalVerificationMaxHours,
    approvalThresholds: { ...current.approvalThresholds, ...defined(patch.approvalThresholds) },
  };
}

// ---------------------------------------------------------------------------
// Persistence + cache
// ---------------------------------------------------------------------------

type ConfigRow = {
  source: string;
  isEnabled: boolean;
  settings: Prisma.JsonValue;
  updatedAt: Date;
};

let cached: { config: OperationsConfig; fetchedAt: number } | null = null;
let inFlight: Promise<OperationsConfig> | null = null;
const pinnedConfig = new AsyncLocalStorage<OperationsConfig>();

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-config', event, ...extra }));

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function readRow(): Promise<ConfigRow | null> {
  return prisma.integrationConfig.findUnique({ where: { source: OPERATIONS_CONFIG_SOURCE } });
}

/** Returns the row, creating it with the defaults when missing (safe under concurrent boots). */
async function loadOrSeedRow(now: Date): Promise<ConfigRow> {
  const existing = await readRow();
  if (existing) return existing;
  try {
    const created = await prisma.integrationConfig.create({
      data: {
        source: OPERATIONS_CONFIG_SOURCE,
        displayName: OPERATIONS_CONFIG_DISPLAY_NAME,
        isEnabled: true,
        settings: defaultOperationsSettings(now) as unknown as Prisma.InputJsonValue,
      },
    });
    log('seeded', { cutoverDate: now.toISOString() });
    return created;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await readRow();
    if (!winner) throw err;
    return winner;
  }
}

function toConfig(row: ConfigRow, settings: OperationsSettings): OperationsConfig {
  return { ...settings, isEnabled: row.isEnabled, updatedAt: row.updatedAt.toISOString() };
}

async function loadConfig(): Promise<OperationsConfig> {
  const now = new Date();
  const row = await loadOrSeedRow(now);
  const { settings, cutoverRepaired } = normalizeOperationsSettings(row.settings, now);
  if (!cutoverRepaired) return toConfig(row, settings);

  // Persist the repaired cutover once, only if nobody changed the row meanwhile.
  const repaired = await prisma.integrationConfig.updateMany({
    where: { source: OPERATIONS_CONFIG_SOURCE, updatedAt: row.updatedAt },
    data: { settings: settings as unknown as Prisma.InputJsonValue },
  });
  if (repaired.count === 1) {
    log('cutover_repaired', { cutoverDate: settings.cutoverDate });
    const fresh = await readRow();
    return toConfig(fresh ?? row, settings);
  }
  const winner = await readRow();
  if (!winner) return toConfig(row, settings);
  return toConfig(winner, normalizeOperationsSettings(winner.settings, now).settings);
}

/**
 * Runs `fn` with a fixed configuration: every `getOperationsConfig()` inside
 * answers it without touching the database. The command engine pins the
 * configuration loaded before opening its transaction, so a cache refresh never
 * asks the pool for a second connection while the transaction holds one.
 */
export function withPinnedOperationsConfig<T>(
  config: OperationsConfig,
  fn: () => Promise<T>
): Promise<T> {
  return pinnedConfig.run(config, fn);
}

/** Effective configuration (10 s in-memory cache; the first read seeds the row). */
export async function getOperationsConfig(): Promise<OperationsConfig> {
  const pinned = pinnedConfig.getStore();
  if (pinned) return pinned;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.config;
  if (!inFlight) {
    inFlight = loadConfig()
      .then((config) => {
        cached = { config, fetchedAt: Date.now() };
        return config;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** True when the core is enabled and the module flag is on. */
export async function isOpsFlagEnabled(flag: OpsFlag): Promise<boolean> {
  const config = await getOperationsConfig();
  return config.isEnabled && config.flags[flag] === true;
}

export function invalidateOperationsConfigCache(): void {
  cached = null;
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'configuración'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validates and applies a partial update (deep merge for flags, SLAs,
 * escalation and thresholds). Uses the row's `updatedAt` as an optimistic
 * guard with one retry, so two admins never overwrite each other silently.
 * Permission checks (`operations.admin`) belong to the calling action/route.
 */
export async function updateOperationsConfig(
  patch: OperationsConfigPatch,
  options: { actorUserId?: string | null } = {}
): Promise<OperationsConfig> {
  const parsed = operationsConfigPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_config',
      `Configuración inválida: ${describeZodError(parsed.error)}`
    );
  }
  const now = new Date();
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await loadOrSeedRow(now);
    const current = normalizeOperationsSettings(row.settings, now).settings;
    const next = applyOperationsPatch(current, parsed.data);
    const isEnabled = parsed.data.isEnabled ?? row.isEnabled;
    const updated = await prisma.integrationConfig.updateMany({
      where: { source: OPERATIONS_CONFIG_SOURCE, updatedAt: row.updatedAt },
      data: { isEnabled, settings: next as unknown as Prisma.InputJsonValue },
    });
    if (updated.count !== 1) continue;
    invalidateOperationsConfigCache();
    await recordAuditEvent({
      actorUserId: options.actorUserId ?? null,
      action: 'operations.config.updated',
      targetType: 'integration_config',
      targetId: OPERATIONS_CONFIG_SOURCE,
      metadata: { fields: Object.keys(parsed.data) },
    });
    log('updated', { fields: Object.keys(parsed.data), actorUserId: options.actorUserId ?? null });
    return getOperationsConfig();
  }
  throw new OperationsError(
    'config_conflict',
    'Otra persona cambió la configuración al mismo tiempo; recarga e intenta de nuevo'
  );
}

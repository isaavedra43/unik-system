import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import { DEFAULT_ORDER_MESSAGE_TEMPLATE, DEFAULT_RFQ_MESSAGE_TEMPLATE } from './rfq-rules';

/**
 * Configuration of the Sourcing Lab and of the messages to suppliers: one
 * `IntegrationConfig` row with `source = 'sourcing'` (plan 6.1) with the same
 * seed/cache pattern as `operations-config.ts`.
 *
 * - `allowedHosts`: the only hosts the catalog pages are fetched from (exact or
 *   `*.dominio`); empty = no catalog fetching.
 * - `braveConnectionId`: `ExtensionConnection` holding the Brave Search API key
 *   (used only when no Brave Search MCP tool is connected).
 * - `dailyBudgetUnits`: search units per day (one web query, two per page).
 * - `rfqAccountId`/`rfqTemplateKey`/`orderTemplateKey`: inbox account and the
 *   approved WhatsApp templates (Content SID) used to write first to a supplier
 *   with a quotation request and with a purchase order. Their parameters are
 *   fixed (`RFQ_TEMPLATE_VARIABLES_GUIDE`, `ORDER_TEMPLATE_VARIABLES_GUIDE`).
 *   Without a template, WhatsApp is only used inside an open 24-hour window.
 *   `rfqMessageTemplate` and `orderMessageTemplate` are the editable texts
 *   (SMS/Telegram and the conversation record).
 * - `cacheTtlDays`: a repeated search is answered from cache without spending.
 *
 * Changes need `operations.admin` (egress hosts and credentials are sensitive).
 */

export const SOURCING_CONFIG_SOURCE = 'sourcing' as const;
export const SOURCING_CONFIG_DISPLAY_NAME = 'Laboratorio de Sourcing';
const CACHE_TTL_MS = 30_000;

export interface SourcingSettings {
  allowedHosts: string[];
  braveConnectionId: string | null;
  dailyBudgetUnits: number;
  rfqAccountId: string | null;
  rfqTemplateKey: string | null;
  orderTemplateKey: string | null;
  rfqMessageTemplate: string;
  orderMessageTemplate: string;
  companyName: string;
  cacheTtlDays: number;
  rfqDefaultDueDays: number;
  maxPagesPerSearch: number;
}

export interface SourcingConfig extends SourcingSettings {
  isEnabled: boolean;
  updatedAt: string | null;
}

export function defaultSourcingSettings(): SourcingSettings {
  return {
    allowedHosts: [],
    braveConnectionId: null,
    dailyBudgetUnits: 200,
    rfqAccountId: null,
    rfqTemplateKey: null,
    orderTemplateKey: null,
    rfqMessageTemplate: DEFAULT_RFQ_MESSAGE_TEMPLATE,
    orderMessageTemplate: DEFAULT_ORDER_MESSAGE_TEMPLATE,
    companyName: 'UNIK',
    cacheTtlDays: 30,
    rfqDefaultDueDays: 3,
    maxPagesPerSearch: 5,
  };
}

const HOST_PATTERN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const hostsSchema = z
  .array(z.string())
  .max(200)
  .transform((hosts) =>
    [...new Set(hosts.map((host) => host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')))].filter(
      (host) => HOST_PATTERN.test(host)
    )
  );
const idOrNull = z.string().trim().min(1).max(120).nullable();
const templateSchema = z.string().trim().min(10).max(2000);

const FIELDS = {
  allowedHosts: hostsSchema,
  braveConnectionId: idOrNull,
  dailyBudgetUnits: z.number().int().min(0).max(100_000),
  rfqAccountId: idOrNull,
  rfqTemplateKey: z.string().trim().min(1).max(120).nullable(),
  orderTemplateKey: z.string().trim().min(1).max(120).nullable(),
  rfqMessageTemplate: templateSchema,
  orderMessageTemplate: templateSchema,
  companyName: z.string().trim().min(1).max(120),
  cacheTtlDays: z.number().int().min(1).max(365),
  rfqDefaultDueDays: z.number().int().min(1).max(60),
  maxPagesPerSearch: z.number().int().min(1).max(5),
} as const;

function pick<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** Pure: stored JSON → complete settings (each invalid field falls back to its default). */
export function normalizeSourcingSettings(stored: unknown): SourcingSettings {
  const defaults = defaultSourcingSettings();
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  return {
    allowedHosts: pick(FIELDS.allowedHosts, s.allowedHosts, defaults.allowedHosts),
    braveConnectionId: pick(FIELDS.braveConnectionId, s.braveConnectionId, defaults.braveConnectionId),
    dailyBudgetUnits: pick(FIELDS.dailyBudgetUnits, s.dailyBudgetUnits, defaults.dailyBudgetUnits),
    rfqAccountId: pick(FIELDS.rfqAccountId, s.rfqAccountId, defaults.rfqAccountId),
    rfqTemplateKey: pick(FIELDS.rfqTemplateKey, s.rfqTemplateKey, defaults.rfqTemplateKey),
    orderTemplateKey: pick(FIELDS.orderTemplateKey, s.orderTemplateKey, defaults.orderTemplateKey),
    rfqMessageTemplate: pick(FIELDS.rfqMessageTemplate, s.rfqMessageTemplate, defaults.rfqMessageTemplate),
    orderMessageTemplate: pick(FIELDS.orderMessageTemplate, s.orderMessageTemplate, defaults.orderMessageTemplate),
    companyName: pick(FIELDS.companyName, s.companyName, defaults.companyName),
    cacheTtlDays: pick(FIELDS.cacheTtlDays, s.cacheTtlDays, defaults.cacheTtlDays),
    rfqDefaultDueDays: pick(FIELDS.rfqDefaultDueDays, s.rfqDefaultDueDays, defaults.rfqDefaultDueDays),
    maxPagesPerSearch: pick(FIELDS.maxPagesPerSearch, s.maxPagesPerSearch, defaults.maxPagesPerSearch),
  };
}

export const sourcingConfigPatchSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    allowedHosts: FIELDS.allowedHosts.optional(),
    braveConnectionId: FIELDS.braveConnectionId.optional(),
    dailyBudgetUnits: FIELDS.dailyBudgetUnits.optional(),
    rfqAccountId: FIELDS.rfqAccountId.optional(),
    rfqTemplateKey: FIELDS.rfqTemplateKey.optional(),
    orderTemplateKey: FIELDS.orderTemplateKey.optional(),
    rfqMessageTemplate: FIELDS.rfqMessageTemplate.optional(),
    orderMessageTemplate: FIELDS.orderMessageTemplate.optional(),
    companyName: FIELDS.companyName.optional(),
    cacheTtlDays: FIELDS.cacheTtlDays.optional(),
    rfqDefaultDueDays: FIELDS.rfqDefaultDueDays.optional(),
    maxPagesPerSearch: FIELDS.maxPagesPerSearch.optional(),
  })
  .strict();

export type SourcingConfigPatch = z.input<typeof sourcingConfigPatchSchema>;

type ConfigRow = { isEnabled: boolean; settings: Prisma.JsonValue; updatedAt: Date };

function toConfig(row: ConfigRow | null): SourcingConfig {
  return {
    ...normalizeSourcingSettings(row?.settings),
    isEnabled: row?.isEnabled ?? true,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Reads the configuration with the given client without seeding (defaults
 * when the row does not exist). Commands use it with their `tx`.
 */
export async function loadSourcingConfig(db: Prisma.TransactionClient = prisma): Promise<SourcingConfig> {
  const row = await db.integrationConfig.findUnique({
    where: { source: SOURCING_CONFIG_SOURCE },
    select: { isEnabled: true, settings: true, updatedAt: true },
  });
  return toConfig(row);
}

let cached: { config: SourcingConfig; fetchedAt: number } | null = null;

/** Cached configuration for code outside commands (30 s). */
export async function getSourcingConfig(): Promise<SourcingConfig> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.config;
  const config = await loadSourcingConfig();
  cached = { config, fetchedAt: Date.now() };
  return config;
}

export function invalidateSourcingConfigCache(): void {
  cached = null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Validates and applies a partial update; creates the row the first time. Requires `operations.admin`. */
export async function updateSourcingConfig(actor: CurrentUser, patch: SourcingConfigPatch): Promise<SourcingConfig> {
  if (!hasPermission(actor, 'operations.admin')) {
    throw new OperationsError('forbidden', 'Sólo un administrador de operaciones cambia la configuración del laboratorio');
  }
  const parsed = sourcingConfigPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new OperationsError(
      'invalid_config',
      `Configuración inválida: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'configuración'}: ${issue.message}`)
        .join('; ')}`
    );
  }
  const { isEnabled, ...fields } = parsed.data;
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await prisma.integrationConfig.findUnique({ where: { source: SOURCING_CONFIG_SOURCE } });
    const current = normalizeSourcingSettings(row?.settings);
    const next: SourcingSettings = {
      ...current,
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    };
    if (!row) {
      try {
        await prisma.integrationConfig.create({
          data: {
            source: SOURCING_CONFIG_SOURCE,
            displayName: SOURCING_CONFIG_DISPLAY_NAME,
            isEnabled: isEnabled ?? true,
            settings: next as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    } else {
      const updated = await prisma.integrationConfig.updateMany({
        where: { source: SOURCING_CONFIG_SOURCE, updatedAt: row.updatedAt },
        data: { isEnabled: isEnabled ?? row.isEnabled, settings: next as unknown as Prisma.InputJsonValue },
      });
      if (updated.count !== 1) continue;
    }
    invalidateSourcingConfigCache();
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'purchases.sourcing_config.updated',
      targetType: 'integration_config',
      targetId: SOURCING_CONFIG_SOURCE,
      metadata: { fields: Object.keys(parsed.data) },
    });
    return getSourcingConfig();
  }
  throw new OperationsError(
    'config_conflict',
    'Otra persona cambió la configuración al mismo tiempo; recarga e intenta de nuevo'
  );
}

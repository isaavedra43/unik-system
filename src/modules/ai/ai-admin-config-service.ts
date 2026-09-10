import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * AI Assistant configuration service.
 *
 * Follows the exact pattern of integration-config-service.ts:
 * - Single AiConfig row with key = "global" (future: per-tenant).
 * - settings JSON bag holds runtime parameters.
 * - In-memory cache with 10s TTL so admin changes apply immediately.
 * - Lazy seeding on first read.
 */

const AI_CONFIG_KEY = 'global' as const;

export interface ProviderConfigEntry {
  apiKey: string; // stored in DB, NEVER sent to client
  endpoint: string; // custom endpoint, empty = provider default
  enabled: boolean; // whether this provider is available for selection
}

export interface AiSettings {
  // Global enable/disable
  isEnabled: boolean;
  // Default provider (used when no model is selected in chat)
  provider: string; // 'openai' | 'anthropic' | 'gemini' | 'local'
  // Legacy single-provider fields (kept for backwards compat, used as fallback)
  apiKey: string; // stored in DB, NEVER sent to client
  endpoint: string; // custom endpoint, empty = provider default
  // Multi-provider configs: store API keys for ALL providers at once
  providerConfigs: Record<string, ProviderConfigEntry>;
  // Modelo
  deployment: string;
  fallbackDeployment: string;
  temperature: number;
  maxTokens: number;
  // Cuotas
  maxMessagesPerMinute: number;
  maxTokensPerDay: number;
  maxConversationMessages: number;
  maxToolIterations: number;
  // System prompt
  systemPromptOverride: string;
  // Tools
  enabledTools: string[];
  // Attachments
  maxAttachmentSizeMb: number;
  allowedMimeTypes: string[];
  // Artifacts
  artifactTtlHours: number;
  // Voz
  voiceEnabled: boolean;
  sttModel: string;
  ttsVoice: string;
  // Guardrails
  inputMaxLength: number;
  promptInjectionDetection: boolean;
  // Autonomía (Nivel 4, Fase 5+)
  autonomousModeEnabled: boolean;
  autonomousTasks: string[];
  dailyReportHour: number;
  dailyReportRoles: string[];
  anomalyThreshold: number;
  anomalyCheckIntervalMinutes: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  isEnabled: true,
  provider: 'openai',
  apiKey: '', // empty = fall back to env var
  endpoint: '', // empty = use provider default endpoint
  providerConfigs: {
    openai: { apiKey: '', endpoint: '', enabled: true },
    anthropic: { apiKey: '', endpoint: '', enabled: false },
    gemini: { apiKey: '', endpoint: '', enabled: false },
    local: { apiKey: 'ollama', endpoint: '', enabled: false },
  },
  deployment: 'gpt-4o',
  fallbackDeployment: 'gpt-4o-mini',
  temperature: 0.4,
  maxTokens: 6000,
  maxMessagesPerMinute: 60,
  maxTokensPerDay: 500_000,
  maxConversationMessages: 20,
  maxToolIterations: 10,
  systemPromptOverride: '',
  enabledTools: [
    // Sales — Universal tools (primary, cover 90% of queries)
    'querySalesOrders',
    'universalSearch',
    'getDatabaseOverview',
    // Sales — Specialized tools (unique functionality not in querySalesOrders)
    'getSalesOrderDetail',
    'getTopProducts',
    'getSalesTrend',
    'getSalesRanking',
    'getHourlySalesPattern',
    'getWeekdaySalesPattern',
    'getOrdersWithBalance',
    // Inventory
    'getProductCatalog',
    'getStockMovement',
    'getLowStockAlerts',
    'getProductDetails',
    'getProductSearch',
    // Customers
    'getTopCustomers',
    'getCustomerDetails',
    'getCustomerSegments',
    'getCustomerRetention',
    // Finance
    'getAccountsReceivable',
    'getRevenueAnalysis',
    'getDailyRevenue',
    'getBalanceAging',
    // Analytics
    'comparePeriods',
    'getSalesKPIs',
    'getDashboardSummary',
    'getCrossTabAnalysis',
    'compareEntities',
    'getTeamPerformance',
    'getSalesForecast',
    'getSalesAlerts',
    'getSalesVelocity',
    'getProductBundles',
    // Operations
    'getNotifications',
    'getIntegrationStatus',
    // Artifacts
    'generatePdfReport',
    'generateExcelReport',
    'generateCsvExport',
    'generateChart',
    'generateTable',
    'listArtifacts',
    'cleanupArtifacts',
    // System
    'getCurrentUserContext',
    'getModuleList',
    'getSystemTime',
  ],
  maxAttachmentSizeMb: 10,
  allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'],
  artifactTtlHours: 168, // 7 días
  voiceEnabled: false,
  sttModel: 'whisper-1',
  ttsVoice: 'coral',
  inputMaxLength: 10_000,
  promptInjectionDetection: true,
  autonomousModeEnabled: false,
  autonomousTasks: ['daily_report', 'anomaly_detection', 'artifact_cleanup'],
  dailyReportHour: 18,
  dailyReportRoles: ['super_admin'],
  anomalyThreshold: 0.3,
  anomalyCheckIntervalMinutes: 60,
};

interface CachedConfig {
  settings: AiSettings;
  isEnabled: boolean;
  fetchedAt: number;
}

const cache = new Map<string, CachedConfig>();
const CACHE_TTL_MS = 10_000;

function mergeWithDefaults(stored: unknown): AiSettings {
  const defaults = DEFAULT_AI_SETTINGS;
  if (!stored || typeof stored !== 'object') return { ...defaults };
  const s = stored as Record<string, unknown>;
  const merged = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof AiSettings)[]) {
    const value = s[key as string];
    if (value !== undefined && typeof value === typeof defaults[key]) {
      merged[key as string] = value;
    }
  }
  // Special case: always merge enabledTools so new tools are auto-enabled
  // even when the stored config has an older list.
  const storedTools = s.enabledTools;
  if (Array.isArray(storedTools)) {
    const defaultTools = defaults.enabledTools;
    const mergedTools = [...new Set([...storedTools, ...defaultTools])];
    // Remove renamed/obsolete tools that no longer exist or were consolidated
    const obsoleteTools = new Set([
      'getCashSalesToday',
      'getCashSales',
      'getSalesOrdersSummary',
      'searchSalesOrders',
      'getSalesBySalesperson',
      'getSalesByLocation',
      'getSalesByStatus',
      'getSalesByPaymentMethod',
      'getSalesByDeliveryMethod',
      'getOrderItems',
    ]);
    merged.enabledTools = mergedTools.filter((t) => !obsoleteTools.has(t));
  }
  return merged as unknown as AiSettings;
}

/**
 * Returns the effective AI settings, merging stored DB values with defaults.
 * Uses a short-lived in-memory cache to avoid a DB round-trip on every call.
 */
export async function getAiSettings(): Promise<AiSettings> {
  const cached = cache.get(AI_CONFIG_KEY);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.settings;
  }

  let row = await prisma.aiConfig.findUnique({ where: { key: AI_CONFIG_KEY } });

  if (!row) {
    // Seed the row with defaults so the admin UI can edit it.
    row = await prisma.aiConfig.create({
      data: {
        key: AI_CONFIG_KEY,
        isEnabled: true,
        settings: DEFAULT_AI_SETTINGS as unknown as Prisma.InputJsonValue,
      },
    });
  }

  const settings = mergeWithDefaults(row.settings);
  cache.set(AI_CONFIG_KEY, { settings, isEnabled: row.isEnabled, fetchedAt: Date.now() });
  return settings;
}

/** Returns whether the assistant is globally enabled. */
export async function isAiEnabled(): Promise<boolean> {
  const cached = cache.get(AI_CONFIG_KEY);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.isEnabled;
  }
  const row = await prisma.aiConfig.findUnique({ where: { key: AI_CONFIG_KEY } });
  return row?.isEnabled ?? true;
}

/** Invalidates the in-memory cache so the next read hits the DB. */
function invalidateAiConfigCache(): void {
  cache.clear();
}

/** Returns the AI config row for the admin UI, seeding defaults if missing. */
export async function listAiConfig() {
  let row = await prisma.aiConfig.findUnique({ where: { key: AI_CONFIG_KEY } });
  if (!row) {
    row = await prisma.aiConfig.create({
      data: {
        key: AI_CONFIG_KEY,
        isEnabled: true,
        settings: DEFAULT_AI_SETTINGS as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return row;
}

/** Updates the settings bag and/or enabled flag. */
export async function updateAiConfig(patch: {
  isEnabled?: boolean;
  settings?: Record<string, unknown>;
}): Promise<void> {
  const current = await prisma.aiConfig.findUnique({ where: { key: AI_CONFIG_KEY } });
  if (!current) {
    throw new Error('AI config not found');
  }

  const currentSettings =
    current.settings && typeof current.settings === 'object'
      ? (current.settings as Record<string, unknown>)
      : {};

  // Merge incoming settings, but preserve API keys that are sent empty.
  // Password inputs don't retain their value in the browser, so when the
  // user saves other settings, the API key field comes back empty.
  // We detect this and keep the previously stored value.
  let incomingSettings = patch.settings ?? {};
  if (incomingSettings.providerConfigs && currentSettings.providerConfigs) {
    const currentProviders = currentSettings.providerConfigs as Record<string, { apiKey?: string; endpoint?: string; enabled?: boolean }>;
    const incomingProviders = incomingSettings.providerConfigs as Record<string, { apiKey?: string; endpoint?: string; enabled?: boolean }>;
    const mergedProviders: Record<string, { apiKey?: string; endpoint?: string; enabled?: boolean }> = {};
    for (const [providerId, incoming] of Object.entries(incomingProviders)) {
      const existing = currentProviders[providerId] ?? {};
      mergedProviders[providerId] = {
        ...existing,
        ...incoming,
        // If apiKey is empty/undefined in incoming, keep the existing one
        apiKey: (incoming.apiKey && incoming.apiKey.length > 0)
          ? incoming.apiKey
          : existing.apiKey ?? '',
      };
    }
    incomingSettings = { ...incomingSettings, providerConfigs: mergedProviders };
  }

  const mergedSettings =
    patch.settings !== undefined
      ? mergeWithDefaults({ ...currentSettings, ...incomingSettings })
      : mergeWithDefaults(current.settings);

  await prisma.aiConfig.update({
    where: { key: AI_CONFIG_KEY },
    data: {
      isEnabled: patch.isEnabled ?? current.isEnabled,
      settings: mergedSettings as unknown as Prisma.InputJsonValue,
    },
  });

  invalidateAiConfigCache();
}

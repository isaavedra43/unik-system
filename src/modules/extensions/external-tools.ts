import { prisma } from '@/lib/prisma';
import {
  clearExternalTools,
  registerExternalTool,
  type ToolDefinition,
  type ToolEffect,
} from '@/modules/ai/tools/registry';
import { jsonSchemaToZod, type JsonSchema } from './json-schema-to-zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import { isMcpServerHealthy } from './mcp-health';

/**
 * Loads enabled, approved external capabilities from the database into the
 * common registry. Refreshed with a short TTL (and on demand after admin
 * changes) so suspensions apply within seconds on every instance.
 */

const REFRESH_TTL_MS = 30_000;
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;

type CapabilityRow = Awaited<ReturnType<typeof loadRows>>[number];

async function loadRows() {
  return prisma.extensionCapability.findMany({
    where: {
      enabled: true,
      reviewStatus: 'approved',
      remoteChanged: false,
      extension: { status: 'enabled' },
      version: { status: { in: ['enabled', 'approved'] } },
    },
    include: { extension: true, version: { select: { id: true, version: true, status: true } } },
  });
}

async function isCapabilityStillAvailable(
  capabilityId: string,
  extensionId: string
): Promise<boolean> {
  const cap = await prisma.extensionCapability.findUnique({
    where: { id: capabilityId },
    select: {
      enabled: true,
      reviewStatus: true,
      remoteChanged: true,
      extension: { select: { status: true, currentVersionId: true } },
      versionId: true,
    },
  });
  if (!cap) return false;
  if (!cap.enabled || cap.reviewStatus !== 'approved' || cap.remoteChanged) return false;
  if (cap.extension.status !== 'enabled') return false;
  if (cap.extension.currentVersionId && cap.extension.currentVersionId !== cap.versionId)
    return false;
  void extensionId;
  return true;
}

// Availability is asked for every external tool on every turn: a short cache
// keeps that to one query per capability every few seconds. Execution always
// re-checks fresh, so a suspension still applies immediately.
const AVAILABILITY_TTL_MS = 15_000;
const availability = new Map<string, { ok: boolean; at: number }>();

async function cachedCheck(
  key: string,
  fresh: boolean,
  check: () => Promise<boolean>
): Promise<boolean> {
  const hit = availability.get(key);
  if (!fresh && hit && Date.now() - hit.at < AVAILABILITY_TTL_MS) return hit.ok;
  const ok = await check();
  if (availability.size > 2000) availability.clear();
  availability.set(key, { ok, at: Date.now() });
  return ok;
}

/** The actor has the credentials this capability needs (personal or team connection). */
async function hasConnectionFor(
  extensionId: string,
  scope: 'none' | 'team' | 'personal',
  actor: CurrentUser
): Promise<boolean> {
  if (scope === 'none') return true;
  const { resolveConnectionForActor } = await import('./connections-service');
  try {
    return Boolean(await resolveConnectionForActor(extensionId, scope, actor));
  } catch {
    return false;
  }
}

function toDefinition(row: CapabilityRow): ToolDefinition {
  const extension = row.extension;
  const operation = row.operation as Record<string, unknown> | null;
  const manifestTags = ((extension.config as Record<string, unknown> | null)?.contextTags as
    string[] | undefined) ?? ['all'];
  const parameters = jsonSchemaToZod(row.inputSchema as JsonSchema);
  return {
    name: row.name,
    description: `${row.description || row.localName} [${extension.name}]`,
    parameters,
    requiredPermission: row.requiredPermission ?? 'assistant.use',
    enabledByDefault: false,
    category: 'extension',
    source: extension.kind as ToolDefinition['source'],
    version: row.version.version,
    effect: row.effect as ToolEffect,
    approvalPolicy: row.approvalPolicy as 'auto' | 'require_approval',
    timeoutMs: row.timeoutMs,
    maxResultBytes: row.maxResultBytes,
    dataScope: row.dataScope,
    extensionId: extension.id,
    capabilityId: row.id,
    connectionScope: row.connectionScope as 'none' | 'team' | 'personal',
    allowedRoleKeys: extension.allowedRoleKeys,
    contextTags: manifestTags,
    // Never offer what cannot run: suspended/changed capability, an MCP server
    // whose circuit is open, or a connection this user has not made.
    isAvailable: async (actor, opts) => {
      const fresh = Boolean(opts?.fresh);
      if (extension.kind === 'mcp' && !fresh && !isMcpServerHealthy(extension.id)) return false;
      const live = await cachedCheck(`cap:${row.id}`, fresh, () =>
        isCapabilityStillAvailable(row.id, extension.id)
      );
      if (!live) return false;
      const scope = row.connectionScope as 'none' | 'team' | 'personal';
      if (!actor || scope === 'none') return true;
      return cachedCheck(
        `conn:${extension.id}:${scope}:${scope === 'personal' ? actor.id : 'team'}`,
        fresh,
        () => hasConnectionFor(extension.id, scope, actor)
      );
    },
    summarize: (args) =>
      `${extension.name} → ${row.localName}: ${JSON.stringify(args ?? {}).slice(0, 300)}`,
    execute: async (actor, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (extension.kind === 'mcp') {
        const { callMcpTool } = await import('./mcp-client-service');
        return callMcpTool(extension, row, a, actor);
      }
      const isHttpOperation = Boolean((operation as { method?: string } | null)?.method);
      if (extension.kind === 'api' || (extension.kind === 'plugin' && isHttpOperation)) {
        const { executeApiOperation } = await import('./api-runtime');
        if (!operation) throw new Error('La capacidad no tiene operación definida');
        return executeApiOperation({
          extension,
          capability: row,
          operation: operation as never,
          args: a,
          actor,
        });
      }
      if (extension.kind === 'skill' || (extension.kind === 'plugin' && !isHttpOperation)) {
        const { runSkillByKey } = await import('./skill-runner');
        const skillKey = (row.operation as { skillKey?: string } | null)?.skillKey ?? row.localName;
        return runSkillByKey(actor, skillKey, a);
      }
      throw new Error(`Tipo de extensión no soportado: ${extension.kind}`);
    },
  };
}

export async function refreshExternalTools(force = false): Promise<void> {
  if (!force && Date.now() - lastRefresh < REFRESH_TTL_MS) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const rows = await loadRows();
      clearExternalTools();
      for (const row of rows) {
        try {
          registerExternalTool(toDefinition(row));
        } catch (err) {
          console.error(
            '[external-tools] skip',
            row.name,
            err instanceof Error ? err.message : err
          );
        }
      }
      lastRefresh = Date.now();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Test helper. */
export function resetExternalToolsCache(): void {
  lastRefresh = 0;
  availability.clear();
}

/** Drops cached availability (a connection was added or revoked). */
export function invalidateToolAvailability(extensionId?: string): void {
  if (!extensionId) {
    availability.clear();
    return;
  }
  for (const key of availability.keys())
    if (key.includes(`:${extensionId}:`)) availability.delete(key);
}

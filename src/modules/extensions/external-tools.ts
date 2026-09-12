import { prisma } from '@/lib/prisma';
import {
  clearExternalTools,
  registerExternalTool,
  type ToolDefinition,
  type ToolEffect,
} from '@/modules/ai/tools/registry';
import { jsonSchemaToZod, type JsonSchema } from './json-schema-to-zod';

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
    isAvailable: () => isCapabilityStillAvailable(row.id, extension.id),
    summarize: (args) =>
      `${extension.name} → ${row.localName}: ${JSON.stringify(args ?? {}).slice(0, 300)}`,
    execute: async (actor, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (extension.kind === 'mcp') {
        const { callMcpTool } = await import('./mcp-client-service');
        return callMcpTool(extension, row, a, actor);
      }
      if (extension.kind === 'api' || (extension.kind === 'plugin' && operation)) {
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
      if (extension.kind === 'skill' || (extension.kind === 'plugin' && !operation)) {
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
}

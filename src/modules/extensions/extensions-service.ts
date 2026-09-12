import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { cancelJobsByGroup } from '@/modules/jobs/job-queue';
import { canonicalJson } from './json-schema-to-zod';
import { hashTool } from './mcp-client-service';
import { importOpenApi, type ImportedOperation } from './openapi-importer';
import { invalidateProposalsForTool } from './proposals-service';
import { refreshExternalTools } from './external-tools';
import { isHostAllowed } from './safe-fetch';

/**
 * Extension lifecycle: create/import → review (classify effects, data,
 * limits) → test with fixtures → approve a version → enable for teams →
 * suspend/revoke. Every state change is audited.
 *
 *   draft → testing → pending_approval → approved → enabled → suspended
 */

export const EFFECTS = [
  'read',
  'draft',
  'internal_task',
  'external_send',
  'business_write',
  'destructive',
] as const;
export const EXTENSION_STATES = [
  'draft',
  'testing',
  'pending_approval',
  'approved',
  'enabled',
  'suspended',
  'revoked',
] as const;

const TRANSITIONS: Record<string, string[]> = {
  draft: ['testing', 'pending_approval', 'revoked'],
  testing: ['pending_approval', 'draft', 'revoked'],
  pending_approval: ['approved', 'draft', 'revoked'],
  approved: ['enabled', 'suspended', 'revoked'],
  enabled: ['suspended', 'revoked'],
  suspended: ['enabled', 'revoked'],
  revoked: [],
};

export class ExtensionError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ExtensionError';
  }
}

const namespaceSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z][a-z0-9_.-]*$/, 'Namespace inválido (minúsculas, dígitos, . _ -)');

export const createExtensionSchema = z.object({
  kind: z.enum(['mcp', 'api', 'plugin', 'skill']),
  namespace: namespaceSchema,
  name: z.string().min(2).max(120),
  description: z.string().max(2000).optional(),
  allowedHosts: z.array(z.string().min(1).max(253)).max(20).default([]),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).max(5).default([443]),
  allowedRoleKeys: z.array(z.string().min(1).max(60)).max(50).default([]),
  config: z.record(z.unknown()).optional(),
});

export type CreateExtensionInput = z.infer<typeof createExtensionSchema>;

function assertConfigHostsApproved(
  kind: string,
  config: Record<string, unknown> | undefined,
  allowedHosts: string[]
) {
  const urls: string[] = [];
  const api = config?.api as { baseUrl?: string } | undefined;
  const mcp = config?.mcp as { url?: string } | undefined;
  const oauth = config?.oauth as { authorizationUrl?: string; tokenUrl?: string } | undefined;
  if (api?.baseUrl) urls.push(api.baseUrl);
  if (mcp?.url) urls.push(mcp.url);
  if (oauth?.authorizationUrl) urls.push(oauth.authorizationUrl);
  if (oauth?.tokenUrl) urls.push(oauth.tokenUrl);
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ExtensionError(`URL inválida en configuración: ${raw}`, 400);
    }
    if (url.protocol !== 'https:') throw new ExtensionError(`Solo HTTPS: ${raw}`, 400);
    if (!isHostAllowed(url.hostname, allowedHosts)) {
      throw new ExtensionError(
        `El dominio ${url.hostname} no está en la lista de dominios aprobados`,
        400
      );
    }
  }
  if (kind === 'api' && !api?.baseUrl)
    throw new ExtensionError('Una extensión API requiere config.api.baseUrl', 400);
  if (kind === 'mcp' && !mcp?.url)
    throw new ExtensionError('Una extensión MCP requiere config.mcp.url', 400);
}

export async function createExtension(actor: CurrentUser, input: CreateExtensionInput) {
  assertConfigHostsApproved(input.kind, input.config, input.allowedHosts);
  const existing = await prisma.extension.findUnique({ where: { namespace: input.namespace } });
  if (existing) throw new ExtensionError('Ya existe una extensión con ese namespace', 409);
  const extension = await prisma.extension.create({
    data: {
      kind: input.kind,
      namespace: input.namespace,
      name: input.name,
      description: input.description ?? null,
      createdBy: actor.id,
      allowedHosts: input.allowedHosts,
      allowedPorts: input.allowedPorts,
      allowedRoleKeys: input.allowedRoleKeys,
      config: (input.config ?? {}) as Prisma.InputJsonValue,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'extension.created',
    targetType: 'extension',
    targetId: extension.id,
    metadata: { kind: input.kind, namespace: input.namespace },
  });
  return extension;
}

export async function updateExtension(
  actor: CurrentUser,
  id: string,
  patch: Partial<CreateExtensionInput>
) {
  const extension = await prisma.extension.findUnique({ where: { id } });
  if (!extension) throw new ExtensionError('Extensión no encontrada', 404);
  const allowedHosts = patch.allowedHosts ?? extension.allowedHosts;
  const config = (patch.config ??
    (extension.config as Record<string, unknown> | null) ??
    undefined) as Record<string, unknown> | undefined;
  assertConfigHostsApproved(extension.kind, config, allowedHosts);
  const updated = await prisma.extension.update({
    where: { id },
    data: {
      name: patch.name,
      description: patch.description,
      allowedHosts: patch.allowedHosts,
      allowedPorts: patch.allowedPorts,
      allowedRoleKeys: patch.allowedRoleKeys,
      config: patch.config ? (patch.config as Prisma.InputJsonValue) : undefined,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'extension.updated',
    targetType: 'extension',
    targetId: id,
    metadata: { changedKeys: Object.keys(patch) },
  });
  await refreshExternalTools(true);
  return updated;
}

export async function transitionExtension(
  actor: CurrentUser,
  id: string,
  next: (typeof EXTENSION_STATES)[number],
  reason?: string
) {
  const extension = await prisma.extension.findUnique({
    where: { id },
    include: { capabilities: { select: { name: true } } },
  });
  if (!extension) throw new ExtensionError('Extensión no encontrada', 404);
  if (!TRANSITIONS[extension.status]?.includes(next)) {
    throw new ExtensionError(`Transición no permitida: ${extension.status} → ${next}`, 409);
  }
  if (next === 'enabled' && !extension.currentVersionId) {
    throw new ExtensionError('No hay una versión aprobada para habilitar', 409);
  }
  const updated = await prisma.extension.update({
    where: { id },
    data: {
      status: next,
      suspendedAt: next === 'suspended' || next === 'revoked' ? new Date() : null,
      suspendedReason: next === 'suspended' || next === 'revoked' ? (reason ?? null) : null,
    },
  });
  if (next === 'suspended' || next === 'revoked') {
    // Immediate effect: cancel dependent pending jobs and invalidate approvals.
    await cancelJobsByGroup(`extension:${id}`);
    for (const cap of extension.capabilities) {
      await invalidateProposalsForTool(
        cap.name,
        `La extensión fue ${next === 'suspended' ? 'suspendida' : 'revocada'}`
      );
    }
    if (next === 'revoked') {
      await prisma.extensionCapability.updateMany({
        where: { extensionId: id },
        data: { enabled: false },
      });
      await prisma.extensionConnection.updateMany({
        where: { extensionId: id, revokedAt: null },
        data: { status: 'revoked', revokedAt: new Date(), secretCiphertext: null },
      });
    }
  }
  await recordAuditEvent({
    actorUserId: actor.id,
    action: `extension.${next}`,
    targetType: 'extension',
    targetId: id,
    metadata: { from: extension.status, reason: reason ?? null },
  });
  await refreshExternalTools(true);
  return updated;
}

/** Creates an immutable version from an API/plugin manifest (content-addressed). */
export async function createVersionFromOperations(
  actor: CurrentUser,
  extensionId: string,
  operations: ImportedOperation[],
  manifestExtra: Record<string, unknown> = {}
) {
  const extension = await prisma.extension.findUnique({ where: { id: extensionId } });
  if (!extension) throw new ExtensionError('Extensión no encontrada', 404);
  const manifest = { kind: extension.kind, operations, ...manifestExtra };
  const contentHash = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  const same = await prisma.extensionVersion.findFirst({ where: { extensionId, contentHash } });
  if (same) return same;
  const current = extension.currentVersionId
    ? await prisma.extensionVersion.findUnique({
        where: { id: extension.currentVersionId },
        include: { capabilities: true },
      })
    : null;
  const previous = new Map((current?.capabilities ?? []).map((c) => [c.localName, c]));
  const version = await prisma.extensionVersion.create({
    data: {
      extensionId,
      version: `v${contentHash.slice(0, 8)}`,
      contentHash,
      manifest: manifest as never,
      status: 'draft',
      publishedBy: actor.id,
    },
  });
  for (const op of operations) {
    const inputSchema = {
      type: 'object',
      properties: {
        ...((op.pathParams.properties as Record<string, unknown>) ?? {}),
        ...((op.queryParams.properties as Record<string, unknown>) ?? {}),
        ...(((op.bodySchema?.properties as Record<string, unknown>) ?? {}) as Record<
          string,
          unknown
        >),
      },
      required: [
        ...((op.pathParams.required as string[]) ?? []),
        ...((op.queryParams.required as string[]) ?? []),
        ...(((op.bodySchema?.required as string[]) ?? []) as string[]),
      ],
      additionalProperties: false,
    };
    const schemaHash = hashTool({
      localName: op.operationId,
      description: op.summary || op.description,
      inputSchema,
      outputSchema: op.responseSchema,
    });
    const prev = previous.get(op.operationId);
    const keep = prev && prev.schemaHash === schemaHash;
    await prisma.extensionCapability.create({
      data: {
        extensionId,
        versionId: version.id,
        name: `${extension.namespace}__${op.operationId}`.replace(/[^A-Za-z0-9_]/g, '_'),
        localName: op.operationId,
        description: (op.summary || op.description || op.operationId).slice(0, 2000),
        inputSchema: inputSchema as never,
        outputSchema: (op.responseSchema ?? undefined) as never,
        schemaHash,
        effect: keep ? prev.effect : op.suggestedEffect,
        approvalPolicy: keep
          ? prev.approvalPolicy
          : op.suggestedEffect === 'read'
            ? 'auto'
            : 'require_approval',
        dataScope: keep ? prev.dataScope : [],
        requiredPermission: keep ? prev.requiredPermission : 'assistant.use',
        timeoutMs: keep ? prev.timeoutMs : 15_000,
        maxResultBytes: keep ? prev.maxResultBytes : 64 * 1024,
        connectionScope: keep ? prev.connectionScope : 'team',
        reviewStatus: keep ? prev.reviewStatus : 'pending',
        enabled: keep ? prev.enabled : false,
        remoteChanged: false,
        operation: {
          method: op.method,
          path: op.path,
          pathParams: op.pathParams,
          queryParams: op.queryParams,
          bodySchema: op.bodySchema,
          bodyContentType: op.bodyContentType,
          responseFields: [],
          idempotent: op.method === 'GET' || op.method === 'PUT',
        } as never,
      },
    });
  }
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'extension.version_created',
    targetType: 'extension_version',
    targetId: version.id,
    metadata: { extensionId, operations: operations.length },
  });
  return version;
}

export async function importOpenApiIntoExtension(
  actor: CurrentUser,
  extensionId: string,
  document: unknown,
  selected?: string[]
) {
  const result = importOpenApi(document);
  const operations =
    selected && selected.length > 0
      ? result.operations.filter((o) => selected.includes(o.operationId))
      : result.operations;
  const version = await createVersionFromOperations(actor, extensionId, operations, {
    source: 'openapi',
    title: result.title,
    warnings: result.warnings,
  });
  return {
    version,
    warnings: result.warnings,
    imported: operations.length,
    available: result.operations.map((o) => ({
      operationId: o.operationId,
      method: o.method,
      path: o.path,
      summary: o.summary,
    })),
  };
}

export const reviewCapabilitySchema = z.object({
  effect: z.enum(EFFECTS).optional(),
  approvalPolicy: z.enum(['auto', 'require_approval']).optional(),
  dataScope: z.array(z.string().max(60)).max(30).optional(),
  requiredPermission: z.string().max(80).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  maxResultBytes: z
    .number()
    .int()
    .min(1024)
    .max(4 * 1024 * 1024)
    .optional(),
  connectionScope: z.enum(['none', 'team', 'personal']).optional(),
  reviewStatus: z.enum(['pending', 'approved', 'blocked']).optional(),
  enabled: z.boolean().optional(),
  responseFields: z.array(z.string().max(200)).max(50).optional(),
  description: z.string().max(2000).optional(),
});

/** Admin classification of one capability. Enabling requires an approved review. */
export async function reviewCapability(
  actor: CurrentUser,
  capabilityId: string,
  patch: z.infer<typeof reviewCapabilitySchema>
) {
  const cap = await prisma.extensionCapability.findUnique({ where: { id: capabilityId } });
  if (!cap) throw new ExtensionError('Capacidad no encontrada', 404);
  const reviewStatus = patch.reviewStatus ?? cap.reviewStatus;
  const enabled = patch.enabled ?? cap.enabled;
  if (enabled && reviewStatus !== 'approved')
    throw new ExtensionError('Solo una capacidad aprobada puede habilitarse', 409);
  const operation = cap.operation as Record<string, unknown> | null;
  const updated = await prisma.extensionCapability.update({
    where: { id: capabilityId },
    data: {
      effect: patch.effect,
      approvalPolicy: patch.approvalPolicy,
      dataScope: patch.dataScope,
      requiredPermission:
        patch.requiredPermission === undefined ? undefined : patch.requiredPermission,
      timeoutMs: patch.timeoutMs,
      maxResultBytes: patch.maxResultBytes,
      connectionScope: patch.connectionScope,
      reviewStatus,
      enabled,
      remoteChanged: reviewStatus === 'approved' ? false : cap.remoteChanged,
      description: patch.description,
      operation:
        patch.responseFields && operation
          ? ({ ...operation, responseFields: patch.responseFields } as never)
          : undefined,
    },
  });
  if (patch.effect && patch.effect !== cap.effect) {
    await invalidateProposalsForTool(cap.name, 'La clasificación de la capacidad cambió');
  }
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'extension.capability_reviewed',
    targetType: 'extension_capability',
    targetId: capabilityId,
    metadata: { changedKeys: Object.keys(patch) },
  });
  await refreshExternalTools(true);
  return updated;
}

/** Approves a version: becomes the current one; the previous is superseded. Requires every enabled capability to be approved. */
export async function approveVersion(actor: CurrentUser, versionId: string, notes?: string) {
  const version = await prisma.extensionVersion.findUnique({
    where: { id: versionId },
    include: { capabilities: true, extension: true },
  });
  if (!version) throw new ExtensionError('Versión no encontrada', 404);
  if (version.status === 'superseded')
    throw new ExtensionError('La versión ya fue reemplazada', 409);
  const unreviewedEnabled = version.capabilities.filter(
    (c) => c.enabled && c.reviewStatus !== 'approved'
  );
  if (unreviewedEnabled.length > 0)
    throw new ExtensionError('Hay capacidades habilitadas sin aprobar', 409);
  await prisma.$transaction(async (tx) => {
    if (version.extension.currentVersionId && version.extension.currentVersionId !== versionId) {
      await tx.extensionVersion.update({
        where: { id: version.extension.currentVersionId },
        data: { status: 'superseded' },
      });
      await tx.extensionCapability.updateMany({
        where: { versionId: version.extension.currentVersionId },
        data: { enabled: false },
      });
    }
    await tx.extensionVersion.update({
      where: { id: versionId },
      data: {
        status: 'approved',
        approvedBy: actor.id,
        approvedAt: new Date(),
        reviewNotes: notes ?? version.reviewNotes,
      },
    });
    await tx.extension.update({
      where: { id: version.extensionId },
      data: {
        currentVersionId: versionId,
        status: version.extension.status === 'enabled' ? 'enabled' : 'approved',
      },
    });
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'extension.version_approved',
    targetType: 'extension_version',
    targetId: versionId,
    metadata: { extensionId: version.extensionId },
  });
  await refreshExternalTools(true);
  return prisma.extensionVersion.findUnique({ where: { id: versionId } });
}

/** Controlled test of a capability with a fixture or a live read; writes need explicit confirmation. */
export async function testCapability(
  actor: CurrentUser,
  capabilityId: string,
  options: { args?: Record<string, unknown>; fixture?: string; confirmWrite?: boolean }
) {
  const cap = await prisma.extensionCapability.findUnique({
    where: { id: capabilityId },
    include: { extension: true, version: true },
  });
  if (!cap) throw new ExtensionError('Capacidad no encontrada', 404);
  const { jsonSchemaToZod } = await import('./json-schema-to-zod');
  const parsed = jsonSchemaToZod(cap.inputSchema as never).safeParse(options.args ?? {});
  if (!parsed.success)
    throw new ExtensionError(`Argumentos inválidos: ${parsed.error.message}`, 400);
  let result: unknown;
  if (cap.extension.kind === 'mcp') {
    if (cap.effect !== 'read' && !options.confirmWrite) {
      result = {
        mode: 'preview',
        target: `MCP ${cap.extension.namespace} → ${cap.localName}`,
        payload: parsed.data,
        note: 'Operación con efectos: confirma para ejecutarla realmente.',
      };
    } else {
      const { callMcpTool } = await import('./mcp-client-service');
      result = {
        mode: 'live',
        result: await callMcpTool(
          cap.extension,
          cap,
          parsed.data as Record<string, unknown>,
          actor
        ),
      };
    }
  } else if (cap.operation) {
    const { testApiOperation } = await import('./api-runtime');
    result = await testApiOperation(
      {
        extension: cap.extension,
        capability: cap,
        operation: cap.operation as never,
        args: parsed.data as Record<string, unknown>,
        actor,
        fixture: options.fixture,
      },
      { confirmWrite: options.confirmWrite }
    );
  } else {
    throw new ExtensionError('Esta capacidad no se puede probar directamente', 400);
  }
  await prisma.extensionVersion.update({
    where: { id: cap.versionId },
    data: {
      lastTestedAt: new Date(),
      lastTestResult: { capabilityId, ok: true, at: new Date().toISOString() } as never,
    },
  });
  if (cap.extension.status === 'draft') {
    await prisma.extension.update({ where: { id: cap.extensionId }, data: { status: 'testing' } });
  }
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'extension.capability_tested',
    targetType: 'extension_capability',
    targetId: capabilityId,
    metadata: { fixture: options.fixture ?? null, confirmWrite: Boolean(options.confirmWrite) },
  });
  return result;
}

export async function listExtensions(filters: { kind?: string; status?: string } = {}) {
  const rows = await prisma.extension.findMany({
    where: {
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    include: {
      versions: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          version: true,
          status: true,
          createdAt: true,
          approvedAt: true,
          lastTestedAt: true,
        },
      },
      _count: { select: { capabilities: true, connections: true, executions: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map((e) => ({
    id: e.id,
    namespace: e.namespace,
    kind: e.kind,
    name: e.name,
    description: e.description,
    status: e.status,
    createdBy: e.createdBy,
    currentVersionId: e.currentVersionId,
    allowedRoleKeys: e.allowedRoleKeys,
    allowedHosts: e.allowedHosts,
    allowedPorts: e.allowedPorts,
    config: sanitizeConfig(e.config),
    suspendedAt: e.suspendedAt?.toISOString() ?? null,
    suspendedReason: e.suspendedReason,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    versions: e.versions.map((v) => ({
      ...v,
      createdAt: v.createdAt.toISOString(),
      approvedAt: v.approvedAt?.toISOString() ?? null,
      lastTestedAt: v.lastTestedAt?.toISOString() ?? null,
    })),
    counts: e._count,
  }));
}

/** Configuration never contains secrets, but keep the contract explicit. */
function sanitizeConfig(config: unknown): Record<string, unknown> | null {
  if (!config || typeof config !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (/secret|token|password|key$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function getExtensionDetail(id: string) {
  const e = await prisma.extension.findUnique({
    where: { id },
    include: {
      versions: {
        orderBy: { createdAt: 'desc' },
        include: { capabilities: { orderBy: { localName: 'asc' } } },
      },
    },
  });
  if (!e) throw new ExtensionError('Extensión no encontrada', 404);
  const executions = await prisma.extensionExecution.groupBy({
    by: ['status'],
    where: { extensionId: id, createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    _count: { _all: true },
  });
  return {
    id: e.id,
    namespace: e.namespace,
    kind: e.kind,
    name: e.name,
    description: e.description,
    status: e.status,
    createdBy: e.createdBy,
    currentVersionId: e.currentVersionId,
    allowedRoleKeys: e.allowedRoleKeys,
    allowedHosts: e.allowedHosts,
    allowedPorts: e.allowedPorts,
    config: sanitizeConfig(e.config),
    suspendedAt: e.suspendedAt?.toISOString() ?? null,
    suspendedReason: e.suspendedReason,
    versions: e.versions.map((v) => ({
      id: v.id,
      version: v.version,
      contentHash: v.contentHash,
      status: v.status,
      reviewNotes: v.reviewNotes,
      publishedBy: v.publishedBy,
      approvedBy: v.approvedBy,
      approvedAt: v.approvedAt?.toISOString() ?? null,
      lastTestedAt: v.lastTestedAt?.toISOString() ?? null,
      lastTestResult: v.lastTestResult,
      createdAt: v.createdAt.toISOString(),
      manifest: v.manifest,
      capabilities: v.capabilities.map((c) => ({
        id: c.id,
        name: c.name,
        localName: c.localName,
        description: c.description,
        inputSchema: c.inputSchema,
        outputSchema: c.outputSchema,
        schemaHash: c.schemaHash,
        effect: c.effect,
        approvalPolicy: c.approvalPolicy,
        dataScope: c.dataScope,
        requiredPermission: c.requiredPermission,
        timeoutMs: c.timeoutMs,
        maxResultBytes: c.maxResultBytes,
        connectionScope: c.connectionScope,
        reviewStatus: c.reviewStatus,
        enabled: c.enabled,
        remoteChanged: c.remoteChanged,
        operation: c.operation,
      })),
    })),
    executions30d: Object.fromEntries(executions.map((g) => [g.status, g._count._all])),
  };
}

export async function listExecutions(
  filters: { extensionId?: string; status?: string; userId?: string; limit?: number } = {}
) {
  const rows = await prisma.extensionExecution.findMany({
    where: {
      ...(filters.extensionId ? { extensionId: filters.extensionId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.userId ? { userId: filters.userId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filters.limit ?? 100, 500),
  });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** Catalog visible to a regular user: enabled extensions their roles may use. */
export async function listCatalogForUser(actor: CurrentUser) {
  const rows = await prisma.extension.findMany({
    where: { status: 'enabled' },
    include: {
      capabilities: {
        where: { enabled: true, reviewStatus: 'approved', remoteChanged: false },
        select: {
          id: true,
          localName: true,
          description: true,
          effect: true,
          connectionScope: true,
          versionId: true,
        },
      },
    },
    orderBy: { name: 'asc' },
  });
  return rows
    .filter((e) => actor.isSuperAdmin || e.allowedRoleKeys.some((r) => actor.roleKeys.includes(r)))
    .map((e) => ({
      id: e.id,
      namespace: e.namespace,
      kind: e.kind,
      name: e.name,
      description: e.description,
      supportsPersonalConnection: e.capabilities.some((c) => c.connectionScope === 'personal'),
      oauthConfigured: Boolean((e.config as Record<string, unknown> | null)?.oauth),
      capabilities: e.capabilities
        .filter((c) => c.versionId === e.currentVersionId)
        .map((c) => ({
          id: c.id,
          name: c.localName,
          description: c.description,
          effect: c.effect,
          connectionScope: c.connectionScope,
        })),
    }));
}

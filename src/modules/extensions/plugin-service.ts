import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { ExtensionError } from './extensions-service';
import type { ImportedPlugin } from './plugin-importer';
import { hashTool } from './mcp-client-service';
import { isHostAllowed } from './safe-fetch';

/**
 * Installs an imported plugin package as a new DRAFT version of a `plugin`
 * extension: operations become capabilities (API runtime), skills become
 * team skills owned by the installer (draft until published), templates and
 * docs are stored in the manifest. Uninstall (revoke) disables capabilities,
 * cancels dependent jobs and keeps history and audit.
 */
export async function installPluginVersion(
  actor: CurrentUser,
  extensionId: string,
  imported: ImportedPlugin
) {
  const extension = await prisma.extension.findUnique({ where: { id: extensionId } });
  if (!extension) throw new ExtensionError('Extensión no encontrada', 404);
  if (extension.kind !== 'plugin')
    throw new ExtensionError('La extensión no es de tipo plugin', 400);
  if (imported.manifest.namespace !== extension.namespace) {
    throw new ExtensionError(
      `El manifiesto es para el namespace ${imported.manifest.namespace}, no ${extension.namespace}`,
      400
    );
  }
  if (imported.manifest.api) {
    const base = new URL(imported.manifest.api.baseUrl);
    const hosts =
      extension.allowedHosts.length > 0
        ? extension.allowedHosts
        : imported.manifest.api.allowedHosts;
    if (!isHostAllowed(base.hostname, hosts))
      throw new ExtensionError(
        `El host ${base.hostname} no está aprobado para esta extensión`,
        400
      );
  }

  const existing = await prisma.extensionVersion.findFirst({
    where: { extensionId, contentHash: imported.contentHash },
  });
  if (existing) return { versionId: existing.id, reused: true, warnings: imported.warnings };

  const current = extension.currentVersionId
    ? await prisma.extensionVersion.findUnique({
        where: { id: extension.currentVersionId },
        include: { capabilities: true },
      })
    : null;
  const previous = new Map((current?.capabilities ?? []).map((c) => [c.localName, c]));

  const version = await prisma.extensionVersion
    .create({
      data: {
        extensionId,
        version: imported.manifest.version,
        contentHash: imported.contentHash,
        manifest: {
          kind: 'plugin',
          manifest: imported.manifest,
          templates: imported.templates,
          docs: imported.docs,
          files: imported.files,
          skills: imported.skills.map((s) => s.key),
        } as unknown as Prisma.InputJsonValue,
        status: 'draft',
        publishedBy: actor.id,
      },
    })
    .catch((err) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ExtensionError(
          `Ya existe la versión ${imported.manifest.version} con otro contenido; cambia el número de versión`,
          409
        );
      }
      throw err;
    });

  // Merge API config (base URL, hosts) into the extension config when the package declares one.
  if (imported.manifest.api) {
    const config = ((extension.config as Record<string, unknown> | null) ?? {}) as Record<
      string,
      unknown
    >;
    await prisma.extension.update({
      where: { id: extensionId },
      data: {
        config: {
          ...config,
          api: {
            baseUrl: imported.manifest.api.baseUrl,
            apiKeyHeader: imported.manifest.api.apiKeyHeader,
          },
          contextTags: imported.manifest.contextTags,
        } as Prisma.InputJsonValue,
        allowedHosts:
          extension.allowedHosts.length > 0
            ? extension.allowedHosts
            : imported.manifest.api.allowedHosts,
      },
    });
  }

  for (const op of imported.manifest.operations) {
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
      description: op.summary,
      inputSchema,
      outputSchema: null,
    });
    const prev = previous.get(op.operationId);
    const keep = prev && prev.schemaHash === schemaHash;
    await prisma.extensionCapability.create({
      data: {
        extensionId,
        versionId: version.id,
        name: `${extension.namespace}__${op.operationId}`.replace(/[^A-Za-z0-9_]/g, '_'),
        localName: op.operationId,
        description: (op.summary || op.operationId).slice(0, 2000),
        inputSchema: inputSchema as never,
        schemaHash,
        effect: keep ? prev.effect : op.suggestedEffect,
        approvalPolicy: keep
          ? prev.approvalPolicy
          : op.suggestedEffect === 'read'
            ? 'auto'
            : 'require_approval',
        dataScope: keep ? prev.dataScope : [],
        requiredPermission: 'assistant.use',
        timeoutMs: keep ? prev.timeoutMs : 15_000,
        maxResultBytes: keep ? prev.maxResultBytes : 64 * 1024,
        connectionScope: keep ? prev.connectionScope : 'team',
        reviewStatus: keep ? prev.reviewStatus : 'pending',
        enabled: keep ? prev.enabled : false,
        operation: {
          method: op.method,
          path: op.path,
          pathParams: op.pathParams,
          queryParams: op.queryParams,
          bodySchema: op.bodySchema,
          bodyContentType: 'application/json',
          responseFields: op.responseFields,
          fixtures: op.fixtures,
          idempotent: op.method === 'GET' || op.method === 'PUT',
        } as never,
      },
    });
  }

  // Skills ship as team skills in DRAFT: publishing them is a separate administrative step.
  for (const skill of imported.skills) {
    const key = `${extension.namespace}.${skill.key}`.replace(/[^a-z0-9_.-]/g, '-');
    const definitionHash = createHash('sha256')
      .update(JSON.stringify(skill.definition))
      .digest('hex')
      .slice(0, 12);
    await prisma.skill.upsert({
      where: { key },
      create: {
        key,
        name: skill.name,
        purpose: skill.purpose,
        ownerUserId: actor.id,
        scope: 'team',
        status: 'draft',
        definition: skill.definition as unknown as Prisma.InputJsonValue,
        extensionId,
      },
      update: {
        name: skill.name,
        purpose: skill.purpose,
        definition: skill.definition as unknown as Prisma.InputJsonValue,
        status: 'draft',
        version: { increment: 1 },
      },
    });
    // Expose the skill as a capability of the plugin so the assistant can run it once enabled.
    await prisma.extensionCapability.create({
      data: {
        extensionId,
        versionId: version.id,
        name: `${extension.namespace}__skill_${skill.key}`.replace(/[^A-Za-z0-9_]/g, '_'),
        localName: `skill:${skill.key}`,
        description: `${skill.purpose} (skill ${definitionHash})`.slice(0, 2000),
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            skill.definition.inputs.map((i) => [
              i.name,
              {
                type: i.type === 'json' ? 'object' : i.type,
                description: i.description ?? i.label,
              },
            ])
          ),
          required: skill.definition.inputs.filter((i) => i.required).map((i) => i.name),
          additionalProperties: false,
        } as never,
        schemaHash: definitionHash,
        effect: 'internal_task',
        approvalPolicy: 'auto',
        requiredPermission: 'assistant.use',
        timeoutMs: skill.definition.limits.maxDurationMs,
        maxResultBytes: 64 * 1024,
        connectionScope: 'none',
        reviewStatus: 'pending',
        enabled: false,
        operation: { skillKey: key } as never,
      },
    });
  }

  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'extension.plugin_installed',
    targetType: 'extension_version',
    targetId: version.id,
    metadata: {
      extensionId,
      version: imported.manifest.version,
      operations: imported.manifest.operations.length,
      skills: imported.skills.length,
      warnings: imported.warnings,
    },
  });
  return { versionId: version.id, reused: false, warnings: imported.warnings };
}

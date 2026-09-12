import { createHash } from 'crypto';
import type { CurrentUser } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';
import { canonicalJson } from './json-schema-to-zod';
import { isHostAllowed, isPublicAddress } from './safe-fetch';
import dns from 'dns/promises';
import net from 'net';
import {
  buildAuthHeaders,
  readConnectionSecret,
  resolveConnectionForActor,
  touchConnection,
} from './connections-service';
import { getValidAccessToken } from './oauth-service';
import { redactDeep } from './secrets';

/**
 * Remote MCP client (Streamable HTTP over HTTPS, official SDK).
 *
 * - The transport uses a policed fetch: approved host/port only, public DNS
 *   answers only, no automatic redirects, wall-clock timeout.
 * - The client advertises NO capabilities (no sampling, no roots, no
 *   elicitation) so the server cannot initiate work or read files.
 * - Discovered tools are stored as a DRAFT version; UNIK classifies each one
 *   after review. When the remote catalog changes, changed/new tools are
 *   blocked until re-reviewed.
 */

export interface McpExtensionConfig {
  url: string;
  timeoutMs?: number;
  /** Static headers approved by the admin (never secrets). */
  headers?: Record<string, string>;
}

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'McpError';
  }
}

async function assertMcpUrl(
  url: URL,
  allowedHosts: string[],
  allowedPorts: number[]
): Promise<void> {
  if (url.protocol !== 'https:') throw new McpError('El servidor MCP debe usar HTTPS', 'scheme');
  if (!isHostAllowed(url.hostname, allowedHosts))
    throw new McpError(`Dominio no aprobado: ${url.hostname}`, 'host');
  const port = url.port ? Number(url.port) : 443;
  if (!allowedPorts.includes(port)) throw new McpError(`Puerto no aprobado: ${port}`, 'port');
  const addresses = net.isIP(url.hostname)
    ? [url.hostname]
    : (await dns.lookup(url.hostname, { all: true, verbatim: true })).map((r) => r.address);
  for (const address of addresses) {
    if (!isPublicAddress(address))
      throw new McpError('Destino MCP no permitido (dirección interna)', 'private_address');
  }
}

/** fetch wrapper enforcing the egress policy for the SDK transport. */
export function createPolicedFetch(policy: {
  allowedHosts: string[];
  allowedPorts: number[];
  timeoutMs: number;
}): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    );
    await assertMcpUrl(url, policy.allowedHosts, policy.allowedPorts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    const upstream = init?.signal;
    upstream?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const res = await fetch(url.toString(), {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        throw new McpError('Redirección no permitida desde el servidor MCP', 'redirect');
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface DiscoveredTool {
  localName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaHash: string;
  /** Server annotations are recorded for the reviewer but never trusted. */
  annotations: Record<string, unknown> | null;
}

export function hashTool(tool: {
  localName: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        n: tool.localName,
        d: tool.description,
        i: tool.inputSchema,
        o: tool.outputSchema ?? null,
      })
    )
    .digest('hex');
}

type ExtensionRow = {
  id: string;
  namespace: string;
  allowedHosts: string[];
  allowedPorts: number[];
  config: unknown;
};

async function openClient(extension: ExtensionRow, authHeaders: Record<string, string>) {
  const cfg = (extension.config as { mcp?: McpExtensionConfig } | null)?.mcp;
  if (!cfg?.url) throw new McpError('La extensión no tiene URL de servidor MCP', 'config');
  const url = new URL(cfg.url);
  await assertMcpUrl(url, extension.allowedHosts, extension.allowedPorts);
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: createPolicedFetch({
      allowedHosts: extension.allowedHosts,
      allowedPorts: extension.allowedPorts,
      timeoutMs,
    }),
    requestInit: { headers: { ...(cfg.headers ?? {}), ...authHeaders } },
  });
  // No client capabilities: sampling, roots and elicitation stay disabled.
  const client = new Client({ name: 'unik-assistant', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, timeoutMs };
}

async function authHeadersFor(
  extension: ExtensionRow,
  actor: CurrentUser,
  connectionScope: 'none' | 'team' | 'personal'
) {
  const connection = await resolveConnectionForActor(extension.id, connectionScope, actor);
  if (!connection) return { headers: {}, connectionId: null as string | null };
  const secret =
    connection.authType === 'oauth2'
      ? await getValidAccessToken(connection.id)
      : await readConnectionSecret(connection.id);
  return { headers: buildAuthHeaders(connection.authType, secret), connectionId: connection.id };
}

/** Lists the remote tools (draft catalog). Uses the team connection when configured. */
export async function discoverMcpTools(
  extension: ExtensionRow,
  actor: CurrentUser
): Promise<{ tools: DiscoveredTool[]; serverInfo: Record<string, unknown> | null }> {
  const scope = ((extension.config as { mcp?: { connectionScope?: string } } | null)?.mcp
    ?.connectionScope ?? 'none') as 'none' | 'team' | 'personal';
  const { headers } = await authHeadersFor(extension, actor, scope);
  const { client, transport } = await openClient(extension, headers);
  try {
    const tools: DiscoveredTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      for (const tool of page.tools) {
        const inputSchema = (tool.inputSchema as Record<string, unknown>) ?? { type: 'object' };
        const outputSchema =
          (tool as { outputSchema?: Record<string, unknown> }).outputSchema ?? null;
        const description = tool.description ?? '';
        tools.push({
          localName: tool.name,
          description,
          inputSchema,
          outputSchema,
          schemaHash: hashTool({ localName: tool.name, description, inputSchema, outputSchema }),
          annotations: (tool as { annotations?: Record<string, unknown> }).annotations ?? null,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    const serverInfo = (client.getServerVersion() as Record<string, unknown> | undefined) ?? null;
    return { tools, serverInfo };
  } finally {
    await transport.close().catch(() => undefined);
  }
}

/** Calls one approved tool. Result content is bounded and redacted. */
export async function callMcpTool(
  extension: ExtensionRow,
  capability: {
    localName: string;
    connectionScope: string;
    timeoutMs: number;
    maxResultBytes: number;
  },
  args: Record<string, unknown>,
  actor: CurrentUser
): Promise<unknown> {
  const { headers, connectionId } = await authHeadersFor(
    extension,
    actor,
    capability.connectionScope as 'none' | 'team' | 'personal'
  );
  const { client, transport } = await openClient(extension, headers);
  try {
    const result = await client.callTool(
      { name: capability.localName, arguments: args },
      undefined,
      { timeout: capability.timeoutMs }
    );
    if (connectionId) await touchConnection(connectionId);
    const content = Array.isArray(result.content) ? result.content : [];
    const parts = content.map((c: Record<string, unknown>) => {
      if (c.type === 'text')
        return { type: 'text', text: String(c.text ?? '').slice(0, capability.maxResultBytes) };
      if (c.type === 'image' || c.type === 'audio')
        return { type: c.type, mimeType: c.mimeType, note: 'contenido binario omitido' };
      if (c.type === 'resource')
        return { type: 'resource', uri: (c.resource as Record<string, unknown> | undefined)?.uri };
      return { type: String(c.type) };
    });
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (result.isError) {
      throw new McpError(
        parts
          .map((p) => ('text' in p ? p.text : ''))
          .join('\n')
          .slice(0, 1000) || 'El servidor MCP devolvió un error',
        'tool_error'
      );
    }
    return redactDeep({ content: parts, structuredContent: structured ?? null });
  } catch (err) {
    if (connectionId)
      await touchConnection(connectionId, err instanceof Error ? err.message : 'error');
    throw err;
  } finally {
    await transport.close().catch(() => undefined);
  }
}

/**
 * Persists a discovery as a new DRAFT version and diffs it against the
 * currently approved version. Unchanged capabilities keep their
 * classification and enabled state; new or altered ones start blocked.
 */
export async function syncMcpCatalog(
  extensionId: string,
  actor: CurrentUser
): Promise<{
  versionId: string;
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}> {
  const extension = await prisma.extension.findUnique({ where: { id: extensionId } });
  if (!extension || extension.kind !== 'mcp')
    throw new McpError('Extensión MCP no encontrada', 'not_found');
  const { tools, serverInfo } = await discoverMcpTools(extension, actor);
  const contentHash = createHash('sha256')
    .update(canonicalJson(tools.map((t) => t.schemaHash).sort()))
    .digest('hex');

  const current = extension.currentVersionId
    ? await prisma.extensionVersion.findUnique({
        where: { id: extension.currentVersionId },
        include: { capabilities: true },
      })
    : null;
  const previous = new Map((current?.capabilities ?? []).map((c) => [c.localName, c]));

  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const tool of tools) {
    const prev = previous.get(tool.localName);
    if (!prev) added.push(tool.localName);
    else if (prev.schemaHash !== tool.schemaHash) changed.push(tool.localName);
    else unchanged.push(tool.localName);
  }
  const removed = [...previous.keys()].filter((n) => !tools.some((t) => t.localName === n));

  const existingSame = await prisma.extensionVersion.findFirst({
    where: { extensionId, contentHash },
  });
  if (existingSame && existingSame.id === extension.currentVersionId) {
    return {
      versionId: existingSame.id,
      added: [],
      changed: [],
      removed: [],
      unchanged: tools.map((t) => t.localName),
    };
  }

  const versionLabel = `mcp-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  const version = await prisma.extensionVersion.create({
    data: {
      extensionId,
      version: versionLabel,
      contentHash,
      manifest: { kind: 'mcp', serverInfo, tools: tools.map((t) => ({ ...t })) } as never,
      status: 'draft',
      publishedBy: actor.id,
    },
  });
  for (const tool of tools) {
    const prev = previous.get(tool.localName);
    const keep = prev && prev.schemaHash === tool.schemaHash;
    await prisma.extensionCapability.create({
      data: {
        extensionId,
        versionId: version.id,
        name: `${extension.namespace}__${tool.localName}`.replace(/[^A-Za-z0-9_]/g, '_'),
        localName: tool.localName,
        description: tool.description.slice(0, 2000),
        inputSchema: tool.inputSchema as never,
        outputSchema: (tool.outputSchema ?? undefined) as never,
        schemaHash: tool.schemaHash,
        effect: keep ? prev.effect : 'business_write',
        approvalPolicy: keep ? prev.approvalPolicy : 'require_approval',
        dataScope: keep ? prev.dataScope : [],
        requiredPermission: keep ? prev.requiredPermission : 'assistant.use',
        timeoutMs: keep ? prev.timeoutMs : 20_000,
        maxResultBytes: keep ? prev.maxResultBytes : 64 * 1024,
        connectionScope: keep
          ? prev.connectionScope
          : ((extension.config as { mcp?: { connectionScope?: string } } | null)?.mcp
              ?.connectionScope ?? 'none'),
        reviewStatus: keep ? prev.reviewStatus : 'pending',
        enabled: keep ? prev.enabled : false,
        remoteChanged: !keep && Boolean(prev),
      },
    });
  }
  if (current && (added.length > 0 || changed.length > 0 || removed.length > 0)) {
    // Block the altered tools of the version in use until re-review.
    await prisma.extensionCapability.updateMany({
      where: { versionId: current.id, localName: { in: [...changed, ...removed] } },
      data: { enabled: false, remoteChanged: true, reviewStatus: 'pending' },
    });
    await prisma.extensionVersion.update({
      where: { id: current.id },
      data: {
        reviewNotes: `Catálogo remoto cambiado: +${added.length} ~${changed.length} -${removed.length}`,
      },
    });
    const { invalidateProposalsForTool } = await import('./proposals-service');
    for (const name of [...changed, ...removed]) {
      await invalidateProposalsForTool(
        `${extension.namespace}__${name}`.replace(/[^A-Za-z0-9_]/g, '_'),
        'El servidor MCP cambió la herramienta'
      );
    }
  }
  return { versionId: version.id, added, changed, removed, unchanged };
}

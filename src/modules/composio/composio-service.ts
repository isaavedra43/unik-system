import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import type { ToolEffect } from '@/modules/ai/tools/registry';
import { redactSecrets } from '@/modules/extensions/secrets';
import { recordExtensionExecution } from '@/modules/extensions/extension-audit';
import { absoluteUrl } from '@/lib/app-url';
import {
  ComposioError,
  composioUserId,
  getComposio,
  isComposioConfigured,
} from './composio-client';
import { resolveComposioEffect } from './composio-effects';
import {
  actorMatchesPolicy,
  allowedToolkitsFor,
  getPolicy,
  normalizeToolkitSlug,
  type ComposioPolicy,
} from './composio-policy-service';
import { shrinkJson } from './shrink-json';
import { safeFetch } from '@/modules/extensions/safe-fetch';
import { mergeCatalogItems, type CatalogToolkit, type RawToolkitItem } from './composio-catalog';

export type { CatalogToolkit, RawToolkitItem } from './composio-catalog';

/**
 * Composio integration: every toolkit/tool the assistant can reach goes through
 * here, so UNIK's rules apply in one place:
 *   - only toolkits enabled by an administrator AND allowed for the actor's roles;
 *   - the Composio session is created with that same allow-list (enforced by
 *     Composio too, not only by UNIK);
 *   - the effect of each tool is classified by UNIK (never trusted from Composio);
 *   - accounts are per-user (`unik_<userId>`); tokens stay inside Composio.
 */

type Composio = ReturnType<typeof getComposio>;
type ComposioSession = Awaited<ReturnType<Composio['sessions']['create']>>;

const SESSION_TTL_MS = 10 * 60_000;
const TOOL_META_TTL_MS = 10 * 60_000;
export const COMPOSIO_EXECUTE_TIMEOUT_MS = 45_000;
export const COMPOSIO_MAX_RESULT_BYTES = 48 * 1024;

const sessionCache = new Map<string, { session: ComposioSession; at: number }>();
const toolMetaCache = new Map<string, { meta: ComposioToolMeta; at: number }>();

export interface ComposioToolMeta {
  slug: string;
  name: string;
  toolkit: string;
  toolkitName: string;
  description: string;
  tags: string[];
  inputSchema: Record<string, unknown>;
  isNoAuth: boolean;
  isDeprecated: boolean;
}

export interface ComposioToolkitStatus {
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  isNoAuth: boolean;
  connectedAccountId: string | null;
}

function assertConfigured(): void {
  if (!isComposioConfigured()) {
    throw new ComposioError(
      'Composio no está configurado: falta COMPOSIO_API_KEY en el servidor.',
      'not_configured',
      503
    );
  }
}

async function sessionFor(actor: CurrentUser, allowed: string[]): Promise<ComposioSession> {
  const key = `${actor.id}:${allowed.join(',')}`;
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.session;
  const session = await getComposio().sessions.create(composioUserId(actor.id), {
    toolkits: allowed,
    manageConnections: false,
  });
  sessionCache.set(key, { session, at: Date.now() });
  if (sessionCache.size > 500) {
    for (const [k, v] of sessionCache)
      if (Date.now() - v.at > SESSION_TTL_MS) sessionCache.delete(k);
  }
  return session;
}

function upstream(err: unknown, fallback: string): ComposioError {
  const message = err instanceof Error ? err.message : fallback;
  return new ComposioError(redactSecrets(message).slice(0, 500), 'upstream', 502);
}

// ── toolkits & connections ────────────────────────────────────────────────

export async function listToolkits(
  actor: CurrentUser,
  options: { search?: string; connectedOnly?: boolean; limit?: number } = {}
): Promise<ComposioToolkitStatus[]> {
  assertConfigured();
  const allowed = await allowedToolkitsFor(actor);
  if (allowed.length === 0) return [];
  try {
    const session = await sessionFor(actor, allowed);
    const res = await session.toolkits({
      toolkits: allowed,
      // El endpoint session.toolkits() de Composio rechaza limit > 50 (HTTP_BadRequest).
      limit: Math.min(Math.max(options.limit ?? 50, 1), 50),
      ...(options.search ? { search: options.search } : {}),
      ...(options.connectedOnly ? { isConnected: true } : {}),
    });
    return res.items.map((item) => ({
      slug: item.slug.toLowerCase(),
      name: item.name,
      logo: item.logo ?? null,
      connected: Boolean(item.connection?.isActive) || item.isNoAuth,
      isNoAuth: item.isNoAuth,
      connectedAccountId: item.connection?.connectedAccount?.id ?? null,
    }));
  } catch (err) {
    if (err instanceof ComposioError) throw err;
    throw upstream(err, 'No se pudo consultar Composio');
  }
}

/** Compact "what can the assistant reach" line for the system prompt. Never throws. */
const connectedCache = new Map<string, { at: number; value: string[] }>();
export async function connectedToolkitSlugs(actor: CurrentUser): Promise<string[]> {
  if (!isComposioConfigured()) return [];
  const hit = connectedCache.get(actor.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let value: string[] = [];
  try {
    value = await Promise.race([
      listToolkits(actor, { connectedOnly: true, limit: 50 }).then((r) => r.map((t) => t.slug)),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 2_000)),
    ]);
  } catch {
    value = [];
  }
  connectedCache.set(actor.id, { at: Date.now(), value });
  return value;
}

export function invalidateConnectionCaches(actorId: string): void {
  connectedCache.delete(actorId);
  for (const k of sessionCache.keys()) if (k.startsWith(`${actorId}:`)) sessionCache.delete(k);
}

/** Throws unless the actor may connect this toolkit; returns its state. Creates nothing. */
export async function getConnectionState(
  actor: CurrentUser,
  toolkit: string
): Promise<{ toolkit: string; name: string; connected: boolean }> {
  assertConfigured();
  const slug = normalizeToolkitSlug(toolkit);
  if (!hasPermission(actor, 'extensions.connect')) {
    throw new ComposioError(
      'No tienes permiso para conectar cuentas propias (extensions.connect).',
      'forbidden',
      403
    );
  }
  const policy = await getPolicy(slug);
  if (!actorMatchesPolicy(actor, policy)) {
    throw new ComposioError(
      `El toolkit "${slug}" no está habilitado para tu rol. Pide a un administrador que lo habilite en Admin → Extensiones → Composio.`,
      'toolkit_not_allowed',
      403
    );
  }
  const found = (await listToolkits(actor, { limit: 50 })).find((t) => t.slug === slug);
  return { toolkit: slug, name: found?.name ?? slug, connected: Boolean(found?.connected) };
}

/** Creates the Composio-hosted authorization link. Called when the USER presses "Conectar" (links are short-lived: never stored). */
export async function connectToolkit(
  actor: CurrentUser,
  toolkit: string
): Promise<{
  toolkit: string;
  redirectUrl: string | null;
  connectionId: string | null;
  /** true cuando Composio ya la dejó ACTIVA (managed/no-auth): no hay OAuth que abrir. */
  connected: boolean;
}> {
  const { toolkit: slug } = await getConnectionState(actor, toolkit);
  const allowed = await allowedToolkitsFor(actor);
  try {
    const session = await sessionFor(actor, allowed);
    const request = await session.authorize(slug, {
      callbackUrl: absoluteUrl(
        `/app/assistant/api/composio/callback?toolkit=${encodeURIComponent(slug)}`
      ),
    });
    invalidateConnectionCaches(actor.id);
    if (!request.redirectUrl) {
      // Managed/credential-less toolkits come back ACTIVE without an OAuth
      // round-trip — reporting it as an error was what hid the "connected" state.
      if (request.status === 'ACTIVE') {
        return { toolkit: slug, redirectUrl: null, connectionId: request.id, connected: true };
      }
      throw new ComposioError('Composio no devolvió un enlace de autorización.', 'upstream', 502);
    }
    return {
      toolkit: slug,
      redirectUrl: request.redirectUrl,
      connectionId: request.id,
      connected: false,
    };
  } catch (err) {
    if (err instanceof ComposioError) throw err;
    throw upstream(err, 'No se pudo iniciar la conexión');
  }
}

export async function disconnectToolkit(
  actor: CurrentUser,
  connectedAccountId: string
): Promise<void> {
  assertConfigured();
  const composio = getComposio();
  try {
    // Only accounts that belong to THIS user can be removed.
    const mine = await composio.connectedAccounts.list({
      userIds: [composioUserId(actor.id)],
      limit: 100,
    });
    if (!mine.items.some((a) => a.id === connectedAccountId)) {
      throw new ComposioError('Cuenta no encontrada', 'forbidden', 404);
    }
    await composio.connectedAccounts.delete(connectedAccountId);
    invalidateConnectionCaches(actor.id);
  } catch (err) {
    if (err instanceof ComposioError) throw err;
    throw upstream(err, 'No se pudo desconectar la cuenta');
  }
}

/** Every toolkit Composio offers (for the admin panel). The API has no text search: fetched once by usage and filtered here. */
let catalogCache: { at: number; items: CatalogToolkit[] } | null = null;

/**
 * The SDK's toolkits.get() flattens away `next_cursor`, so the full catalog is
 * fetched straight from the REST endpoint — every page, no silent truncation.
 * Goes through safeFetch like any other outbound call (host allowlist + DNS
 * check); the API key stays server-side.
 */
const CATALOG_PAGE_SIZE = 200;
const CATALOG_MAX_PAGES = 30; // hard bound: 6 000 toolkits is far past the real catalog

async function fetchCatalogPage(baseUrl: string, apiKey: string, cursor?: string) {
  const url = new URL('/api/v3.1/toolkits', baseUrl);
  url.searchParams.set('limit', String(CATALOG_PAGE_SIZE));
  url.searchParams.set('sort_by', 'usage');
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await safeFetch(
    url.toString(),
    { headers: { 'x-api-key': apiKey, Accept: 'application/json' } },
    {
      allowedHosts: [url.hostname],
      allowedContentTypes: ['application/json'],
      maxResponseBytes: 8 * 1024 * 1024,
      timeoutMs: 20_000,
    }
  );
  if (res.status !== 200) {
    throw new Error(`Composio catalog respondió ${res.status}`);
  }
  return JSON.parse(res.body.toString('utf8')) as {
    items?: RawToolkitItem[];
    next_cursor?: string | null;
  };
}

export async function listCatalogToolkits(search?: string, limit = 0): Promise<CatalogToolkit[]> {
  assertConfigured();
  try {
    if (!catalogCache || Date.now() - catalogCache.at > 10 * 60_000) {
      const baseUrl = process.env.COMPOSIO_BASE_URL?.trim() || 'https://backend.composio.dev';
      const apiKey = process.env.COMPOSIO_API_KEY!.trim();
      const rawItems: RawToolkitItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
        const res = await fetchCatalogPage(baseUrl, apiKey, cursor);
        rawItems.push(...(res.items ?? []));
        if (!res.next_cursor || !res.items?.length) break;
        cursor = res.next_cursor;
      }
      catalogCache = { at: Date.now(), items: mergeCatalogItems(rawItems) };
    }
    const term = search?.trim().toLowerCase();
    const items = term
      ? catalogCache.items.filter((t) =>
          `${t.slug} ${t.name} ${t.categories.join(' ')}`.toLowerCase().includes(term)
        )
      : catalogCache.items;
    return limit > 0 ? items.slice(0, limit) : items;
  } catch (err) {
    throw upstream(err, 'No se pudo consultar el catálogo de Composio');
  }
}

// ── tools ─────────────────────────────────────────────────────────────────

/** Compact JSON Schema for the prompt: types, descriptions, enums and required only. */
export function compactSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof s.type === 'string' || Array.isArray(s.type)) out.type = s.type;
  if (typeof s.description === 'string') out.description = s.description.slice(0, 160);
  if (Array.isArray(s.enum)) out.enum = s.enum.slice(0, 20);
  if (s.default !== undefined && typeof s.default !== 'object') out.default = s.default;
  if (depth < 2 && s.properties && typeof s.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, unknown>)
        .slice(0, 40)
        .map(([k, v]) => [k, compactSchema(v, depth + 1)])
    );
  }
  if (depth < 2 && s.items) out.items = compactSchema(s.items, depth + 1);
  if (Array.isArray(s.required)) out.required = s.required;
  return out;
}

function toMeta(raw: {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  toolkit?: { slug: string; name: string };
  inputParameters?: unknown;
  isNoAuth?: boolean;
  isDeprecated?: boolean;
}): ComposioToolMeta {
  const toolkit = raw.toolkit?.slug?.toLowerCase() || raw.slug.split('_')[0].toLowerCase();
  return {
    slug: raw.slug.toUpperCase(),
    name: raw.name,
    toolkit,
    toolkitName: raw.toolkit?.name ?? toolkit,
    description: raw.description ?? '',
    tags: raw.tags ?? [],
    inputSchema: (raw.inputParameters as Record<string, unknown> | undefined) ?? {
      type: 'object',
      properties: {},
    },
    isNoAuth: Boolean(raw.isNoAuth),
    isDeprecated: Boolean(raw.isDeprecated),
  };
}

export async function getToolMeta(slug: string): Promise<ComposioToolMeta> {
  assertConfigured();
  const key = slug.toUpperCase();
  const hit = toolMetaCache.get(key);
  if (hit && Date.now() - hit.at < TOOL_META_TTL_MS) return hit.meta;
  try {
    const raw = await getComposio().tools.getRawComposioToolBySlug(key);
    const meta = toMeta(raw);
    toolMetaCache.set(key, { meta, at: Date.now() });
    return meta;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/not\s*found|404|TOOL_NOT_FOUND/i.test(message)) {
      throw new ComposioError(
        `La herramienta ${key} no existe en Composio. Usa composioSearchTools para encontrar el slug correcto.`,
        'tool_not_found',
        404
      );
    }
    throw upstream(err, 'No se pudo leer la herramienta');
  }
}

export interface ResolvedComposioTool {
  meta: ComposioToolMeta;
  policy: ComposioPolicy;
  effect: ToolEffect;
}

/** Throws unless the actor may use this tool; returns its UNIK-classified effect. */
export async function resolveTool(actor: CurrentUser, slug: string): Promise<ResolvedComposioTool> {
  const meta = await getToolMeta(slug);
  const policy = await getPolicy(meta.toolkit);
  if (!actorMatchesPolicy(actor, policy) || !policy) {
    throw new ComposioError(
      `El toolkit "${meta.toolkit}" no está habilitado para tu rol. Un administrador debe habilitarlo en Admin → Extensiones → Composio.`,
      'toolkit_not_allowed',
      403
    );
  }
  if (policy.disabledTools.includes(meta.slug)) {
    throw new ComposioError(
      `La herramienta ${meta.slug} está deshabilitada por un administrador.`,
      'tool_not_allowed',
      403
    );
  }
  if (meta.isDeprecated) {
    throw new ComposioError(
      `La herramienta ${meta.slug} está obsoleta en Composio.`,
      'tool_not_allowed',
      400
    );
  }
  const effect = resolveComposioEffect(meta.slug, {
    toolkit: meta.toolkit,
    tags: meta.tags,
    overrides: policy.effectOverrides,
  });
  return { meta, policy, effect };
}

export interface ComposioToolSummary {
  slug: string;
  toolkit: string;
  description: string;
  effect: ToolEffect;
  requiresApproval: boolean;
  input: Record<string, unknown>;
}

export async function searchTools(
  actor: CurrentUser,
  options: { query?: string; toolkit?: string; limit?: number }
): Promise<{ tools: ComposioToolSummary[]; toolkits: string[] }> {
  assertConfigured();
  const allowed = await allowedToolkitsFor(actor);
  const toolkit = options.toolkit ? normalizeToolkitSlug(options.toolkit) : undefined;
  if (toolkit && !allowed.includes(toolkit)) {
    throw new ComposioError(
      `El toolkit "${toolkit}" no está habilitado para tu rol o no existe.`,
      'toolkit_not_allowed',
      403
    );
  }
  const scope = toolkit ? [toolkit] : allowed;
  if (scope.length === 0) return { tools: [], toolkits: [] };
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 15);
  const query = options.query?.trim();
  try {
    const raw = (await getComposio().tools.getRawComposioTools({
      toolkits: scope,
      limit,
      ...(query ? { search: query } : { important: true }),
    })) as unknown as Array<Parameters<typeof toMeta>[0]>;
    const tools: ComposioToolSummary[] = [];
    for (const r of raw) {
      const meta = toMeta(r);
      toolMetaCache.set(meta.slug, { meta, at: Date.now() });
      const policy = await getPolicy(meta.toolkit);
      if (!policy || meta.isDeprecated || policy.disabledTools.includes(meta.slug)) continue;
      const effect = resolveComposioEffect(meta.slug, {
        toolkit: meta.toolkit,
        tags: meta.tags,
        overrides: policy.effectOverrides,
      });
      tools.push({
        slug: meta.slug,
        toolkit: meta.toolkit,
        description: meta.description.slice(0, 240),
        effect,
        requiresApproval:
          effect === 'external_send' || effect === 'business_write' || effect === 'destructive',
        input: compactSchema(meta.inputSchema),
      });
    }
    return { tools, toolkits: scope };
  } catch (err) {
    if (err instanceof ComposioError) throw err;
    throw upstream(err, 'No se pudo buscar en Composio');
  }
}

export interface ComposioExecutionResult {
  tool: string;
  toolkit: string;
  successful: boolean;
  data?: unknown;
  error?: string;
  needsConnection?: boolean;
  uncertain?: boolean;
  truncated?: boolean;
}

class ComposioTimeout extends Error {}

/** Executes an already-authorized tool for the actor. Approval is handled by the common executor. */
export async function executeComposioTool(
  actor: CurrentUser,
  slug: string,
  args: Record<string, unknown>,
  options: { proposalId?: string } = {}
): Promise<ComposioExecutionResult> {
  const { meta, effect } = await resolveTool(actor, slug);
  const started = Date.now();
  const requestBytes = Buffer.byteLength(JSON.stringify(args ?? {}));
  const audit = (
    status: 'success' | 'error' | 'timeout' | 'pending_review',
    errorMessage?: string,
    responseBytes = 0
  ) =>
    recordExtensionExecution({
      extensionId: null,
      capabilityId: null,
      userId: actor.id,
      toolName: `composio:${meta.slug}`,
      status,
      durationMs: Date.now() - started,
      requestBytes,
      responseBytes,
      errorCode: status === 'success' ? undefined : status,
      errorMessage,
      proposalId: options.proposalId,
    }).catch((e) => console.error('[composio] audit failed', e instanceof Error ? e.message : e));

  const allowed = await allowedToolkitsFor(actor);
  try {
    const session = await sessionFor(actor, allowed);
    if (!meta.isNoAuth) {
      const status = await session.toolkits({ toolkits: [meta.toolkit], limit: 1 });
      const item = status.items[0];
      if (!item || !(item.connection?.isActive || item.isNoAuth)) {
        await audit('error', 'not_connected');
        return {
          tool: meta.slug,
          toolkit: meta.toolkit,
          successful: false,
          needsConnection: true,
          error: `El usuario aún no conectó su cuenta de ${meta.toolkitName}. Llama composioConnect con toolkit "${meta.toolkit}" y pídele que la autorice.`,
        };
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const response = (await Promise.race([
      session.execute(meta.slug, args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ComposioTimeout()), COMPOSIO_EXECUTE_TIMEOUT_MS);
      }),
    ]).finally(() => timer && clearTimeout(timer))) as {
      data?: unknown;
      successful?: boolean;
      error?: string | null;
    };

    const shrunk = shrinkJson(redactStrings(response.data ?? null), COMPOSIO_MAX_RESULT_BYTES);
    const successful = response.successful !== false && !response.error;
    await audit(successful ? 'success' : 'error', response.error ?? undefined, shrunk.bytes);
    return {
      tool: meta.slug,
      toolkit: meta.toolkit,
      successful,
      ...(successful
        ? { data: shrunk.value }
        : { error: redactSecrets(String(response.error ?? 'Error de Composio')).slice(0, 800) }),
      ...(shrunk.truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    if (err instanceof ComposioTimeout) {
      // A write may have completed remotely: never report it as failed with certainty.
      const uncertain = effect !== 'read' && effect !== 'draft';
      await audit(uncertain ? 'pending_review' : 'timeout', 'timeout');
      return {
        tool: meta.slug,
        toolkit: meta.toolkit,
        successful: false,
        uncertain,
        error: `Tiempo agotado (${COMPOSIO_EXECUTE_TIMEOUT_MS / 1000}s).${uncertain ? ' La operación pudo completarse: verifícalo antes de repetirla.' : ''}`,
      };
    }
    const message = err instanceof Error ? err.message : 'Error de Composio';
    await audit('error', redactSecrets(message));
    return {
      tool: meta.slug,
      toolkit: meta.toolkit,
      successful: false,
      error: redactSecrets(message).slice(0, 800),
    };
  }
}

function redactStrings<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactStrings(v, depth + 1),
      ])
    ) as unknown as T;
  }
  return value;
}

/** Admin view: the tools of one toolkit with UNIK's inferred effect and any override in force. */
export async function listToolkitTools(
  toolkit: string,
  limit = 100
): Promise<
  Array<{
    slug: string;
    description: string;
    inferredEffect: ToolEffect;
    effect: ToolEffect;
    overridden: boolean;
    disabled: boolean;
  }>
> {
  assertConfigured();
  const slug = normalizeToolkitSlug(toolkit);
  const policy = await getPolicy(slug);
  try {
    const raw = (await getComposio().tools.getRawComposioTools({
      toolkits: [slug],
      limit,
    })) as unknown as Array<Parameters<typeof toMeta>[0]>;
    return raw.map((r) => {
      const meta = toMeta(r);
      const inferredEffect = resolveComposioEffect(meta.slug, {
        toolkit: meta.toolkit,
        tags: meta.tags,
      });
      const effect = resolveComposioEffect(meta.slug, {
        toolkit: meta.toolkit,
        tags: meta.tags,
        overrides: policy?.effectOverrides,
      });
      return {
        slug: meta.slug,
        description: meta.description.slice(0, 200),
        inferredEffect,
        effect,
        overridden: effect !== inferredEffect,
        disabled: Boolean(policy?.disabledTools.includes(meta.slug)),
      };
    });
  } catch (err) {
    throw upstream(err, 'No se pudieron listar las herramientas del toolkit');
  }
}

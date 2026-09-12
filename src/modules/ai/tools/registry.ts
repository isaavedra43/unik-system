import { z, ZodType } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import { zodToJsonSchema } from './zod-to-json-schema';

/**
 * Tool registry and COMMON EXECUTOR.
 *
 * Built-in tools (registered in code) and external capabilities (MCP servers,
 * custom APIs, plugins, skills — registered from the database) go through the
 * same `executeTool`, which enforces, in order:
 *   1. the tool exists and is currently available (extension not suspended,
 *      version still approved);
 *   2. it is enabled for the assistant (built-in: admin `enabledTools` list;
 *      external: capability enabled + approved + role allowed);
 *   3. the actor holds the required permission;
 *   4. the arguments validate against the schema;
 *   5. the effect classification: side-effecting actions produce an approval
 *      proposal instead of running, unless an approved proposal is presented;
 *   6. timeout and result size limits;
 *   7. audit (external executions are recorded with request/response sizes).
 */

export type ToolCategory =
  | 'sales'
  | 'system'
  | 'export'
  | 'finance'
  | 'inventory'
  | 'purchases'
  | 'payments'
  | 'invoices'
  | 'packages'
  | 'products'
  | 'contacts'
  | 'extension'
  | 'skill'
  | 'knowledge'
  | 'communication';

/** Effect categories defined by UNIK after review (never by the tool itself). */
export type ToolEffect =
  'read' | 'draft' | 'internal_task' | 'external_send' | 'business_write' | 'destructive';

export type ToolSource = 'builtin' | 'mcp' | 'api' | 'plugin' | 'skill';

export const EFFECTS_REQUIRING_APPROVAL: ReadonlySet<ToolEffect> = new Set([
  'external_send',
  'business_write',
  'destructive',
]);

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ZodType<unknown>;
  requiredPermission?: string;
  execute: (actor: CurrentUser, args: unknown, ctx: ToolExecutionContext) => Promise<unknown>;
  enabledByDefault: boolean;
  category: ToolCategory;
  /** Defaults to 'builtin'. */
  source?: ToolSource;
  version?: string;
  /** Defaults to 'read'. */
  effect?: ToolEffect;
  /** 'auto' skips the approval step even for side effects (admin decision). */
  approvalPolicy?: 'auto' | 'require_approval';
  /** Max wall-clock time. Default: 60s built-in, capability value for external. */
  timeoutMs?: number;
  /** Max serialized result size. 0 = unlimited (built-in default). */
  maxResultBytes?: number;
  dataScope?: string[];
  extensionId?: string;
  capabilityId?: string;
  connectionScope?: 'none' | 'team' | 'personal';
  /** Role keys allowed to use an external tool. Empty = super_admin only. */
  allowedRoleKeys?: string[];
  /** Context tags for on-demand loading ("all" or page prefixes like "sales"). */
  contextTags?: string[];
  /** Dynamic availability (suspended extension, revoked connection...). */
  isAvailable?: () => Promise<boolean> | boolean;
  /** Human summary used in approval cards. */
  summarize?: (args: unknown) => string;
}

export interface ToolExecutionContext {
  conversationId?: string;
  messageId?: string;
  /** Admin-enabled built-in tool names. When omitted, built-in enablement is not checked. */
  enabledToolNames?: string[];
  /** Presented when executing an approved proposal. */
  approvedProposalId?: string;
  /** Internal trusted flows only (never from the model). */
  skipApproval?: boolean;
  /** Optional binding context for approvals. */
  recipient?: string;
  fileIds?: string[];
  contextHash?: string;
  /** Skill run that invoked the tool (limits which tools are allowed). */
  skillRunId?: string;
}

export interface ProposalSummary {
  id: string;
  summary: string;
  effect: ToolEffect;
  expiresAt: string;
  toolName: string;
}

export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  durationMs: number;
  /** The tool did not run: a proposal was created and must be approved by the user. */
  needsApproval?: boolean;
  proposal?: ProposalSummary;
  /** Result was cut to the configured size. */
  truncated?: boolean;
  /** Outcome unknown (e.g. timeout after the request may have completed). */
  uncertain?: boolean;
}

const registry = new Map<string, ToolDefinition>();
const externalRegistry = new Map<string, ToolDefinition>();

const BUILTIN_DEFAULT_TIMEOUT_MS = 60_000;

export function registerTool(def: ToolDefinition): void {
  if (registry.has(def.name)) {
    throw new Error(`Tool already registered: ${def.name}`);
  }
  registry.set(def.name, { source: 'builtin', effect: 'read', ...def });
}

/** External capabilities are (re)registered from the database; replacing is allowed. */
export function registerExternalTool(def: ToolDefinition): void {
  if (registry.has(def.name)) {
    throw new Error(`External tool name collides with a built-in tool: ${def.name}`);
  }
  externalRegistry.set(def.name, def);
}

export function unregisterExternalTool(name: string): void {
  externalRegistry.delete(name);
}

export function clearExternalTools(): void {
  externalRegistry.clear();
}

function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name) ?? externalRegistry.get(name);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return getTool(name);
}

/** Built-in tools only (code registered). */
export function getAllTools(): ToolDefinition[] {
  return [...registry.values()];
}

export function getExternalTools(): ToolDefinition[] {
  return [...externalRegistry.values()];
}

function actorHasPermission(actor: CurrentUser, permission?: string): boolean {
  if (!permission) return true;
  return actor.isSuperAdmin || actor.permissionKeys.includes(permission as never);
}

function actorAllowedForExternal(actor: CurrentUser, tool: ToolDefinition): boolean {
  if (actor.isSuperAdmin) return true;
  const allowed = tool.allowedRoleKeys ?? [];
  return allowed.some((role) => actor.roleKeys.includes(role));
}

function matchesContext(tool: ToolDefinition, page?: string): boolean {
  const tags = tool.contextTags;
  if (!tags || tags.length === 0 || tags.includes('all')) return true;
  if (!page) return false;
  return tags.some((tag) => page.startsWith(tag));
}

/** Built-in tools available for an actor: enabled in config AND actor has permission. */
export function getAvailableTools(
  actor: CurrentUser,
  enabledToolNames: string[]
): ToolDefinition[] {
  return getAllTools().filter((t) => {
    if (!enabledToolNames.includes(t.name)) return false;
    return actorHasPermission(actor, t.requiredPermission);
  });
}

/**
 * Built-in + external tools available for this actor and context. External
 * tools are never governed by `enabledToolNames`: they need an enabled,
 * approved capability and a role match, and are loaded per context so prompts
 * stay small.
 */
export async function loadAvailableTools(
  actor: CurrentUser,
  enabledToolNames: string[],
  options: { page?: string } = {}
): Promise<ToolDefinition[]> {
  const builtin = getAvailableTools(actor, enabledToolNames);
  const external: ToolDefinition[] = [];
  for (const tool of externalRegistry.values()) {
    if (!actorHasPermission(actor, tool.requiredPermission)) continue;
    if (!actorAllowedForExternal(actor, tool)) continue;
    if (!matchesContext(tool, options.page)) continue;
    try {
      if (tool.isAvailable && !(await tool.isAvailable())) continue;
    } catch {
      continue;
    }
    external.push(tool);
  }
  return [...builtin, ...external];
}

/** Converts tools to OpenAI function spec format (also compatible with most providers). */
export function toOpenAiTools(tools: ToolDefinition[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters),
    },
  }));
}

export class ToolTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Tiempo de ejecución agotado (${timeoutMs} ms)`);
    this.name = 'ToolTimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundResult(
  result: unknown,
  maxBytes: number
): { value: unknown; truncated: boolean; bytes: number } {
  let serialized: string;
  try {
    serialized = JSON.stringify(result) ?? 'null';
  } catch {
    serialized = String(result);
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (!maxBytes || bytes <= maxBytes) return { value: result, truncated: false, bytes };
  return {
    value: {
      truncated: true,
      originalBytes: bytes,
      maxBytes,
      preview: serialized.slice(0, maxBytes),
      note: 'El resultado excedió el límite configurado y fue recortado.',
    },
    truncated: true,
    bytes,
  };
}

function requiresApproval(tool: ToolDefinition): boolean {
  const effect = tool.effect ?? 'read';
  if (!EFFECTS_REQUIRING_APPROVAL.has(effect)) return false;
  return tool.approvalPolicy !== 'auto';
}

function defaultSummary(tool: ToolDefinition, args: unknown): string {
  if (tool.summarize) {
    try {
      return tool.summarize(args);
    } catch {
      // fall through
    }
  }
  const short = JSON.stringify(args ?? {});
  return `${tool.name}: ${short.length > 300 ? `${short.slice(0, 300)}…` : short}`;
}

/** Executes a tool validating availability, enablement, permissions, args, approval and limits. */
export async function executeTool(
  name: string,
  actor: CurrentUser,
  rawArgs: unknown,
  ctx: ToolExecutionContext = {}
): Promise<ToolExecutionResult> {
  const tool = getTool(name);
  if (!tool) {
    return {
      success: false,
      error: `Unknown tool: ${name}`,
      errorCode: 'unknown_tool',
      durationMs: 0,
    };
  }
  const source = tool.source ?? 'builtin';

  // 1. Availability (suspended extension, superseded version, revoked connection...)
  try {
    if (tool.isAvailable && !(await tool.isAvailable())) {
      await recordDenied(tool, actor, ctx, 'unavailable');
      return {
        success: false,
        error: 'Herramienta no disponible',
        errorCode: 'unavailable',
        durationMs: 0,
      };
    }
  } catch {
    return {
      success: false,
      error: 'Herramienta no disponible',
      errorCode: 'unavailable',
      durationMs: 0,
    };
  }

  // 2. Enablement — checked here too, not only when listing tools for the model.
  if (source === 'builtin') {
    if (ctx.enabledToolNames && !ctx.enabledToolNames.includes(name)) {
      return {
        success: false,
        error: 'Herramienta deshabilitada',
        errorCode: 'disabled',
        durationMs: 0,
      };
    }
  } else if (!actorAllowedForExternal(actor, tool)) {
    await recordDenied(tool, actor, ctx, 'role');
    return {
      success: false,
      error: 'Sin autorización para esta extensión',
      errorCode: 'forbidden',
      durationMs: 0,
    };
  }

  // 3. Permission
  if (!actorHasPermission(actor, tool.requiredPermission)) {
    await recordDenied(tool, actor, ctx, 'permission');
    return { success: false, error: 'Sin permiso', errorCode: 'forbidden', durationMs: 0 };
  }

  // 4. Arguments
  const parsed = tool.parameters.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid args: ${parsed.error.message}`,
      errorCode: 'invalid_args',
      durationMs: 0,
    };
  }

  // 5. Approval for side effects
  if (requiresApproval(tool) && !ctx.skipApproval && !ctx.approvedProposalId) {
    const { createProposal } = await import('@/modules/extensions/proposals-service');
    const proposal = await createProposal({
      actor,
      tool,
      args: parsed.data,
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      summary: defaultSummary(tool, parsed.data),
      recipient: ctx.recipient,
      fileIds: ctx.fileIds,
      contextHash: ctx.contextHash,
    });
    await recordExecution(tool, actor, ctx, {
      status: 'needs_approval',
      durationMs: 0,
      requestBytes: Buffer.byteLength(JSON.stringify(parsed.data ?? {})),
      responseBytes: 0,
      proposalId: proposal.id,
    });
    return {
      success: false,
      needsApproval: true,
      error: 'Requiere aprobación del usuario',
      errorCode: 'needs_approval',
      durationMs: 0,
      proposal: {
        id: proposal.id,
        summary: proposal.summary,
        effect: proposal.effect as ToolEffect,
        expiresAt: proposal.expiresAt.toISOString(),
        toolName: tool.name,
      },
    };
  }

  // 6. Execution with timeout and result bound
  const timeoutMs = tool.timeoutMs ?? (source === 'builtin' ? BUILTIN_DEFAULT_TIMEOUT_MS : 15_000);
  const maxResultBytes = tool.maxResultBytes ?? (source === 'builtin' ? 0 : 64 * 1024);
  const requestBytes = Buffer.byteLength(JSON.stringify(parsed.data ?? {}));
  const start = Date.now();
  try {
    const raw = await withTimeout(tool.execute(actor, parsed.data, ctx), timeoutMs);
    const uncertain = Boolean(
      raw && typeof raw === 'object' && (raw as { uncertain?: boolean }).uncertain === true
    );
    const bounded = boundResult(raw, maxResultBytes);
    const durationMs = Date.now() - start;
    await recordExecution(tool, actor, ctx, {
      status: uncertain ? 'pending_review' : 'success',
      durationMs,
      requestBytes,
      responseBytes: bounded.bytes,
      proposalId: ctx.approvedProposalId,
    });
    return {
      success: true,
      result: bounded.value,
      durationMs,
      truncated: bounded.truncated,
      uncertain,
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    const isTimeout = e instanceof ToolTimeoutError;
    const message = e instanceof Error ? e.message : 'Unknown error';
    const effect = tool.effect ?? 'read';
    // A timeout on a side-effecting external call may have completed remotely.
    const uncertain = isTimeout && source !== 'builtin' && EFFECTS_REQUIRING_APPROVAL.has(effect);
    await recordExecution(tool, actor, ctx, {
      status: uncertain ? 'pending_review' : isTimeout ? 'timeout' : 'error',
      durationMs,
      requestBytes,
      responseBytes: 0,
      errorCode: isTimeout ? 'timeout' : 'error',
      errorMessage: message,
      proposalId: ctx.approvedProposalId,
    });
    return {
      success: false,
      error: message,
      errorCode: isTimeout ? 'timeout' : 'error',
      durationMs,
      uncertain,
    };
  }
}

interface ExecutionRecord {
  status: 'success' | 'error' | 'denied' | 'timeout' | 'pending_review' | 'needs_approval';
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  errorCode?: string;
  errorMessage?: string;
  proposalId?: string;
}

/** External executions are audited (never their secrets); built-ins are audited by the orchestrator. */
async function recordExecution(
  tool: ToolDefinition,
  actor: CurrentUser,
  ctx: ToolExecutionContext,
  record: ExecutionRecord
): Promise<void> {
  if ((tool.source ?? 'builtin') === 'builtin') return;
  void ctx;
  try {
    const { recordExtensionExecution } = await import('@/modules/extensions/extension-audit');
    await recordExtensionExecution({
      extensionId: tool.extensionId ?? null,
      capabilityId: tool.capabilityId ?? null,
      userId: actor.id,
      toolName: tool.name,
      ...record,
    });
  } catch (err) {
    console.error('[registry] audit failed', err instanceof Error ? err.message : err);
  }
}

async function recordDenied(
  tool: ToolDefinition,
  actor: CurrentUser,
  ctx: ToolExecutionContext,
  reason: string
): Promise<void> {
  await recordExecution(tool, actor, ctx, {
    status: 'denied',
    durationMs: 0,
    requestBytes: 0,
    responseBytes: 0,
    errorCode: reason,
  });
}

/** Zod schema helper for empty-object tools. */
export const emptyParameters = z.object({}).describe('Sin parámetros.');

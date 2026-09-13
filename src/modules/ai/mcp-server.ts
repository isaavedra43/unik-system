import { timingSafeEqual } from 'node:crypto';
import type { CurrentUser } from '@/modules/auth/authorization';
import { loadUserActor } from '@/modules/auth/user-actor';
import { getAiSettings } from './ai-admin-config-service';
import { executeTool, getAllTools, loadAvailableTools, type ToolDefinition } from './tools/registry';
import { zodToJsonSchema } from './tools/zod-to-json-schema';
import { refreshExternalTools } from '@/modules/extensions/external-tools';
// Registers every built-in tool (side-effect imports).
import './tools';

/**
 * UNIK as an MCP SERVER — the whole system (every registered tool: sales,
 * quotes, invoices, inbox, chat, campaigns, skills, artifacts…) exposed to any
 * MCP client (Claude Desktop, Cursor, another agent) over Streamable HTTP at
 * POST /api/mcp.
 *
 * Auth: `Authorization: Bearer <UNIK_MCP_API_KEY>`; the acting UNIK user is
 * `UNIK_MCP_ACTOR_USERNAME` (or `X-UNIK-User` header when
 * UNIK_MCP_ALLOW_USER_HEADER=true). Permissions, approvals and audit are the
 * SAME as in the UI: a side-effecting tool returns a proposal that a human
 * must approve inside UNIK — the external agent never bypasses that.
 */

export class McpAuthError extends Error {
  constructor(message: string, public readonly status = 401) {
    super(message);
    this.name = 'McpAuthError';
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function isMcpServerConfigured(): boolean {
  return Boolean(process.env.UNIK_MCP_API_KEY && process.env.UNIK_MCP_API_KEY.length >= 16);
}

/** Resolves the acting user for an MCP request or throws McpAuthError. */
export async function authenticateMcpRequest(request: Request): Promise<CurrentUser> {
  const expected = process.env.UNIK_MCP_API_KEY;
  if (!expected || expected.length < 16) throw new McpAuthError('Servidor MCP no configurado (UNIK_MCP_API_KEY)', 503);
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token || !safeEqual(token, expected)) throw new McpAuthError('Token MCP inválido', 401);

  const allowHeader = process.env.UNIK_MCP_ALLOW_USER_HEADER === 'true';
  const headerUser = allowHeader ? request.headers.get('x-unik-user')?.trim() : null;
  const username = headerUser || process.env.UNIK_MCP_ACTOR_USERNAME?.trim();
  const actor = username ? await loadUserActor({ username }) : null;
  if (!actor) throw new McpAuthError('Usuario MCP no encontrado o inactivo (UNIK_MCP_ACTOR_USERNAME / X-UNIK-User)', 403);
  return actor;
}

export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; title: string };
}

function annotate(tool: ToolDefinition): McpToolListing['annotations'] {
  const effect = tool.effect ?? 'read';
  return {
    title: tool.name,
    readOnlyHint: effect === 'read',
    destructiveHint: effect === 'destructive',
  };
}

/** Tools this actor can use (admin-enabled built-ins + approved external capabilities). */
export async function listMcpTools(actor: CurrentUser): Promise<{ tools: ToolDefinition[]; enabledToolNames: string[] }> {
  const settings = await getAiSettings();
  await refreshExternalTools();
  const tools = await loadAvailableTools(actor, settings.enabledTools, { page: '/api/mcp' });
  return { tools, enabledToolNames: settings.enabledTools };
}

export function toMcpListing(tool: ToolDefinition): McpToolListing {
  const schema = zodToJsonSchema(tool.parameters);
  const inputSchema = schema.type === 'object' ? schema : { type: 'object', properties: {}, additionalProperties: true };
  const effect = tool.effect ?? 'read';
  const suffix = effect === 'read' ? '' : ` [efecto: ${effect}${effect === 'draft' ? '' : ' — requiere aprobación humana dentro de UNIK'}]`;
  return { name: tool.name, description: `${tool.description}${suffix}`, inputSchema, annotations: annotate(tool) };
}

export interface McpCallResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export async function callMcpTool(actor: CurrentUser, name: string, args: unknown, enabledToolNames: string[]): Promise<McpCallResult> {
  if (!getAllTools().some((t) => t.name === name)) {
    const { tools } = await listMcpTools(actor);
    if (!tools.some((t) => t.name === name)) {
      return { content: [{ type: 'text', text: `Herramienta desconocida: ${name}` }], isError: true };
    }
  }
  const result = await executeTool(name, actor, args ?? {}, { enabledToolNames, recipient: 'mcp' });
  if (result.needsApproval && result.proposal) {
    const payload = {
      status: 'needs_approval',
      message: 'Esta acción tiene efectos y necesita aprobación humana. Pídele al usuario que la apruebe en UNIK (Asistente IA → propuestas pendientes).',
      proposal: result.proposal,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
  if (!result.success) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: result.error, code: result.errorCode }) }], isError: true };
  }
  const data = (result.result ?? {}) as Record<string, unknown>;
  const text = JSON.stringify(data);
  return {
    content: [{ type: 'text', text: text.length > 200_000 ? `${text.slice(0, 200_000)}…[truncated]` : text }],
    structuredContent: typeof data === 'object' && data !== null && !Array.isArray(data) ? data : { result: data },
  };
}

/**
 * Builds a fresh MCP server bound to this actor. Stateless: one server +
 * transport per request (no session ids), which is what serverless-style
 * route handlers need.
 */
export async function createMcpServerForActor(actor: CurrentUser) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const { tools, enabledToolNames } = await listMcpTools(actor);
  const server = new McpServer(
    { name: 'unik-system', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } }, instructions: buildInstructions(actor, tools.length) }
  );

  // Low-level handlers: we already have JSON schemas + a governed executor.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(toMcpListing) }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await callMcpTool(actor, name, args, enabledToolNames);
    return result as unknown as Record<string, unknown>;
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return { server, transport };
}

function buildInstructions(actor: CurrentUser, toolCount: number): string {
  return [
    `Servidor MCP de UNIK System actuando como el usuario "${actor.name}" (${actor.username}).`,
    `Expone ${toolCount} herramientas del ERP: ventas, cotizaciones, facturas, pagos, paquetes, productos, contactos, compras, bandeja omnicanal, chat interno, campañas, reportes (PDF/Excel), skills y sistema.`,
    'Los estados de Zoho se guardan en inglés (pending, sent, paid…); las herramientas aceptan español y lo traducen.',
    'Las herramientas con efectos (envíos, cambios comerciales, eliminaciones) devuelven status "needs_approval": una persona debe aprobarlas dentro de UNIK; no reintentes.',
  ].join('\n');
}

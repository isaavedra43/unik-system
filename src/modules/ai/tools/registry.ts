import { z, ZodType } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import { zodToJsonSchema } from './zod-to-json-schema';

export type ToolCategory = 'sales' | 'system' | 'export' | 'finance' | 'inventory';

interface ToolDefinition {
  name: string;
  description: string;
  parameters: ZodType<unknown>;
  requiredPermission?: string;
  execute: (actor: CurrentUser, args: unknown) => Promise<unknown>;
  enabledByDefault: boolean;
  category: ToolCategory;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  if (registry.has(def.name)) {
    throw new Error(`Tool already registered: ${def.name}`);
  }
  registry.set(def.name, def);
}

function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function getAllTools(): ToolDefinition[] {
  return [...registry.values()];
}

/** Tools available for an actor: enabled in config AND actor has permission. */
export function getAvailableTools(
  actor: CurrentUser,
  enabledToolNames: string[]
): ToolDefinition[] {
  return getAllTools().filter((t) => {
    if (!enabledToolNames.includes(t.name)) return false;
    if (
      t.requiredPermission &&
      !actor.permissionKeys.includes(t.requiredPermission as never) &&
      !actor.isSuperAdmin
    ) {
      return false;
    }
    return true;
  });
}

/** Converts tools to OpenAI function spec format (also compatible with most providers). */
export function toOpenAiTools(
  tools: ToolDefinition[]
): Array<{
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

interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/** Executes a tool validating permissions and args. */
export async function executeTool(
  name: string,
  actor: CurrentUser,
  rawArgs: unknown
): Promise<ToolExecutionResult> {
  const tool = getTool(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}`, durationMs: 0 };
  }
  if (
    tool.requiredPermission &&
    !actor.permissionKeys.includes(tool.requiredPermission as never) &&
    !actor.isSuperAdmin
  ) {
    return { success: false, error: 'Sin permiso', durationMs: 0 };
  }
  const parsed = tool.parameters.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid args: ${parsed.error.message}`,
      durationMs: 0,
    };
  }
  const start = Date.now();
  try {
    const result = await tool.execute(actor, parsed.data);
    return { success: true, result, durationMs: Date.now() - start };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Unknown error',
      durationMs: Date.now() - start,
    };
  }
}

/** Zod schema helper for empty-object tools. */
export const emptyParameters = z.object({}).describe('Sin parámetros.');

import { z } from 'zod';
import { registerTool, type ToolDefinition } from './registry';

/**
 * Composio gateway: one small, stable set of tools that reaches every toolkit
 * (Gmail, Calendar, Slack, GitHub, Notion, Sheets…) instead of registering
 * thousands of tools the model can't hold. Flow the model follows:
 *   composioListToolkits → composioSearchTools → (composioConnect) → composioExecute
 *
 * Governance lives in `@/modules/composio`: admin policy per toolkit and role,
 * UNIK-classified effects (a send/create/delete always produces an approval
 * card), per-user accounts, audit.
 */

const isConfigured = async () => {
  const { isComposioConfigured } = await import('@/modules/composio/composio-client');
  return isComposioConfigured();
};

const asError = (err: unknown) => {
  const e = err as { message?: string; code?: string };
  return { error: e?.message ?? 'Error de Composio', code: e?.code ?? 'error' };
};

const COMMON: Pick<
  ToolDefinition,
  'category' | 'enabledByDefault' | 'requiredPermission' | 'isAvailable' | 'source'
> = {
  category: 'extension',
  enabledByDefault: true,
  requiredPermission: 'assistant.use',
  isAvailable: isConfigured,
};

registerTool({
  ...COMMON,
  name: 'composioListToolkits',
  description:
    'Lista las apps externas (Gmail, Google Calendar, Slack, GitHub, Notion, Sheets, Drive, HubSpot, Stripe…) que el asistente puede usar vía Composio para ESTE usuario y si ya conectó su cuenta. Úsala cuando pidan algo de una app externa o para saber qué puede conectar.',
  effect: 'read',
  parameters: z.object({
    search: z.string().max(60).optional().describe('Filtra por nombre, p. ej. "calendar"'),
    connectedOnly: z.boolean().optional().describe('Solo las apps que el usuario ya conectó'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { search?: string; connectedOnly?: boolean };
    try {
      const { listToolkits } = await import('@/modules/composio/composio-service');
      const toolkits = await listToolkits(actor, args);
      return {
        count: toolkits.length,
        toolkits: toolkits.map((t) => ({
          slug: t.slug,
          name: t.name,
          connected: t.connected,
          isNoAuth: t.isNoAuth,
        })),
        note:
          toolkits.length === 0
            ? 'No hay apps externas habilitadas para este usuario. Un administrador debe habilitarlas en Admin → Extensiones → Composio.'
            : 'Si la app no está conectada, llama composioConnect. Luego busca la herramienta con composioSearchTools.',
      };
    } catch (err) {
      return asError(err);
    }
  },
});

registerTool({
  ...COMMON,
  name: 'composioSearchTools',
  description:
    'Busca herramientas concretas de una app externa (Composio) por lo que quieres hacer. Escribe la consulta en INGLÉS con palabras clave ("send email", "list calendar events", "create issue", "append row"). Devuelve el slug exacto, sus parámetros y si requiere aprobación. Siempre se llama antes de composioExecute.',
  effect: 'read',
  parameters: z.object({
    query: z
      .string()
      .max(120)
      .optional()
      .describe('Qué quieres hacer, en inglés. Vacío = las herramientas principales del toolkit'),
    toolkit: z
      .string()
      .max(60)
      .optional()
      .describe('Slug del toolkit (de composioListToolkits), p. ej. "gmail". Muy recomendable.'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { query?: string; toolkit?: string };
    try {
      const { searchTools } = await import('@/modules/composio/composio-service');
      const { tools, toolkits } = await searchTools(actor, args);
      return {
        count: tools.length,
        searchedToolkits: toolkits,
        tools,
        note:
          tools.length === 0
            ? 'Sin resultados: prueba otras palabras clave en inglés o indica el toolkit. Si no hay toolkits habilitados, díselo al usuario.'
            : 'Llama composioExecute con el slug exacto en "tool" y los parámetros en "arguments". Las de efecto external_send/business_write/destructive muestran una tarjeta de aprobación.',
      };
    } catch (err) {
      return asError(err);
    }
  },
});

registerTool({
  ...COMMON,
  name: 'composioConnect',
  description:
    'Muestra en el chat un botón "Conectar" para que el usuario autorice SU cuenta de una app externa (Gmail, Slack, GitHub…). Úsala cuando composioExecute diga que falta conectar la cuenta o el usuario lo pida. El enlace lo genera el botón al pulsarlo; tú no recibes ni pegas enlaces.',
  effect: 'internal_task',
  parameters: z.object({
    toolkit: z.string().min(1).max(60).describe('Slug del toolkit, p. ej. "gmail"'),
  }),
  execute: async (actor, rawArgs) => {
    const { toolkit } = rawArgs as { toolkit: string };
    try {
      const { getConnectionState } = await import('@/modules/composio/composio-service');
      const state = await getConnectionState(actor, toolkit);
      return state.connected
        ? {
            ...state,
            message: `${state.name} ya está conectado: continúa con composioSearchTools / composioExecute.`,
          }
        : {
            ...state,
            message: `Se mostró un botón "Conectar ${state.name}" en el chat. Pídele al usuario que lo pulse, complete el acceso y te avise para continuar.`,
          };
    } catch (err) {
      return asError(err);
    }
  },
});

const summarizeArgs = (args: unknown): string => {
  const a = (args ?? {}) as { tool?: string; arguments?: Record<string, unknown> };
  const entries = Object.entries(a.arguments ?? {})
    .slice(0, 6)
    .map(([k, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${text.length > 90 ? `${text.slice(0, 90)}…` : text}`;
    });
  return `${a.tool ?? 'Composio'}${entries.length ? ` — ${entries.join(' · ')}` : ''}`;
};

registerTool({
  ...COMMON,
  name: 'composioExecute',
  description:
    'Ejecuta UNA herramienta de Composio (slug exacto de composioSearchTools) con la cuenta conectada del usuario. Leer datos corre directo; enviar, crear, modificar o borrar genera una tarjeta de aprobación y NO se ejecuta hasta que el usuario apruebe. Nunca inventes slugs ni parámetros.',
  // Conservative default for listings; the real effect is resolved per call below.
  effect: 'business_write',
  timeoutMs: 60_000,
  parameters: z.object({
    tool: z.string().min(3).max(120).describe('Slug exacto, p. ej. GMAIL_FETCH_EMAILS'),
    arguments: z
      .record(z.unknown())
      .default({})
      .describe('Parámetros de la herramienta según su esquema'),
  }),
  summarize: summarizeArgs,
  resolveEffect: async (actor, args) => {
    const { tool } = args as { tool: string };
    const { resolveTool } = await import('@/modules/composio/composio-service');
    return (await resolveTool(actor, tool)).effect;
  },
  prepareArgs: async (actor, args) => {
    const input = args as { tool: string; arguments: Record<string, unknown> };
    try {
      const { resolveTool } = await import('@/modules/composio/composio-service');
      const { validateComposioArgs } = await import('@/modules/composio/validate-args');
      const { meta } = await resolveTool(actor, input.tool);
      const problems = validateComposioArgs(meta.inputSchema, input.arguments);
      if (problems.length > 0) {
        return {
          error: `Parámetros inválidos para ${meta.slug}: ${problems.join('; ')}. Revisa el esquema con composioSearchTools y vuelve a intentarlo.`,
        };
      }
      return { args: { tool: meta.slug, arguments: input.arguments } };
    } catch (err) {
      return { error: asError(err).error };
    }
  },
  execute: async (actor, rawArgs, ctx) => {
    const { tool, arguments: toolArgs } = rawArgs as {
      tool: string;
      arguments: Record<string, unknown>;
    };
    try {
      const { executeComposioTool } = await import('@/modules/composio/composio-service');
      return await executeComposioTool(actor, tool, toolArgs, {
        proposalId: ctx.approvedProposalId,
      });
    } catch (err) {
      return { successful: false, tool, ...asError(err) };
    }
  },
});

import type { CurrentUser } from '@/modules/auth/authorization';
import { chatCompletionStream, type ChatMessage, type ToolSpec } from './ai-client';
import { AiApiError } from './ai-client';
import { buildSystemPrompt } from './ai-context-builder';
import {
  getAvailableTools,
  executeTool,
  toOpenAiTools,
} from './tools/index';
import { getAiSettings } from './ai-admin-config-service';
import {
  getMessages,
  addMessage,
  autoTitleConversation,
} from './ai-sessions-service';
import { recordAiToolCall } from './ai-audit';
import { checkRateLimit, recordTokenUsage } from './ai-rate-limit';
import { validateInput, validateOutput } from './ai-guardrails';

export interface OrchestratorInput {
  conversationId: string;
  message: string;
  actor: CurrentUser;
  context?: { page?: string };
  /** Optional model override — user can pick a model in the chat UI. */
  model?: string;
}

export interface OrchestratorEvent {
  type: 'token' | 'tool_call_start' | 'tool_call_end' | 'artifact' | 'done' | 'error';
  data?: unknown;
}

export async function* runAssistant(
  input: OrchestratorInput
): AsyncGenerator<OrchestratorEvent> {
  // 1. Check if AI is enabled (before any work)
  const settings = await getAiSettings();
  if (!settings.isEnabled) {
    yield { type: 'error', data: { message: 'El asistente está desactivado temporalmente.' } };
    return;
  }

  // 2. Validate input
  const inputValidation = validateInput(input.message, settings.inputMaxLength);
  if (!inputValidation.valid) {
    yield { type: 'error', data: { message: inputValidation.error } };
    return;
  }

  // 3. Rate limit
  const rateLimit = checkRateLimit(
    input.actor.id,
    settings.maxMessagesPerMinute,
    settings.maxTokensPerDay
  );
  if (!rateLimit.allowed) {
    yield {
      type: 'error',
      data: {
        message: `Límite de mensajes alcanzado. Reinicia en ${new Date(rateLimit.resetAt).toLocaleTimeString('es-MX')}.`,
      },
    };
    return;
  }

  // 4. Persist user message
  await addMessage(input.conversationId, 'user', input.message, null, 0, 0, 0);
  await autoTitleConversation(input.conversationId, input.message);

  // 5. Load history
  const history = await getMessages(
    input.conversationId,
    input.actor.id,
    settings.maxConversationMessages
  );

  // 6. Build system prompt
  const systemPrompt = await buildSystemPrompt(input.actor, input.context);

  // 7. Build messages
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content ?? '',
          tool_call_id: m.toolCallId ?? '',
        };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        const toolCalls = m.toolCalls as Array<{ id: string; name: string; arguments: string }>;
        return {
          role: 'assistant' as const,
          content: m.content,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return {
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content ?? '',
      };
    }),
  ];

  // 8. Get available tools
  const availableTools = getAvailableTools(input.actor, settings.enabledTools);
  const toolSpecs: ToolSpec[] = toOpenAiTools(availableTools);

  // Resolve effective model: user override > default
  const effectiveModel = input.model ?? settings.deployment;
  const fallbackModel = settings.fallbackDeployment;

  // 9. Agent loop (max maxToolIterations)
  let iteration = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let usingFallback = false;

  // Track the last data tool result so we can auto-inject it into artifact tools
  let lastToolRows: Record<string, unknown>[] | null = null;
  let lastToolName: string | null = null;

  const ARTIFACT_TOOLS = new Set([
    'generatePdfReport',
    'generateExcelReport',
    'generateCsvExport',
    'generateTable',
  ]);

  while (iteration < settings.maxToolIterations) {
    iteration++;

    let iterationContent = '';
    let iterationToolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    let finishReason: string | undefined;

    const modelToUse = usingFallback ? fallbackModel : effectiveModel;

    try {
      for await (const chunk of chatCompletionStream({
        messages,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        userId: input.actor.id,
        conversationId: input.conversationId,
        model: modelToUse,
      })) {
      if (chunk.delta) {
        iterationContent += chunk.delta;
        yield { type: 'token', data: { delta: chunk.delta } };
      }
      if (chunk.toolCalls) {
        iterationToolCalls = chunk.toolCalls;
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
      if (chunk.usage) {
        totalPromptTokens += chunk.usage.promptTokens;
        totalCompletionTokens += chunk.usage.completionTokens;
        recordTokenUsage(input.actor.id, chunk.usage.totalTokens);
      }
    }
    } catch (err) {
      // Handle 429 rate limit: try fallback model
      if (err instanceof AiApiError && err.code === 'rate_limit' && !usingFallback && fallbackModel) {
        console.warn(`[ai-orchestrator] Rate limited on ${modelToUse}, falling back to ${fallbackModel}`);
        usingFallback = true;
        iteration--; // Don't count this failed attempt
        continue;
      }
      // Re-throw other errors
      throw err;
    }

    // If no tool calls, we're done
    if (!iterationToolCalls || iterationToolCalls.length === 0 || finishReason === 'stop') {
      // Validate output for potential leaked secrets
      const outputValidation = validateOutput(iterationContent);
      if (!outputValidation.valid && (outputValidation.warnings?.length ?? 0) > 0) {
        // Log warnings but don't block the response — the guardrail is heuristic
        console.warn('[ai-orchestrator] Output validation warnings:', outputValidation.warnings);
      }
      await addMessage(
        input.conversationId,
        'assistant',
        iterationContent,
        null,
        totalPromptTokens,
        totalCompletionTokens,
        0
      );
      yield {
        type: 'done',
        data: {
          content: iterationContent,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
        },
      };
      return;
    }

    // Has tool calls: persist assistant message with tool_calls
    const assistantMessage = await addMessage(
      input.conversationId,
      'assistant',
      iterationContent,
      iterationToolCalls,
      totalPromptTokens,
      totalCompletionTokens,
      0
    );

    // Add to context
    messages.push({
      role: 'assistant',
      content: iterationContent || null,
      tool_calls: iterationToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute each tool call
    for (const tc of iterationToolCalls) {
      yield { type: 'tool_call_start', data: { name: tc.name, args: tc.arguments } };

      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(tc.arguments);
      } catch {
        parsedArgs = {};
      }

      // Inject conversationId for artifact tools that need it
      if (parsedArgs && typeof parsedArgs === 'object') {
        const argsObj = parsedArgs as Record<string, unknown>;
        if (!argsObj.conversationId) {
          argsObj.conversationId = input.conversationId;
        }

        // Auto-inject rows and title for artifact tools when the IA didn't pass them
        if (ARTIFACT_TOOLS.has(tc.name)) {
          if (!argsObj.rows && lastToolRows && lastToolRows.length > 0) {
            console.log(`[ai-orchestrator] Auto-injecting ${lastToolRows.length} rows from ${lastToolName} into ${tc.name}`);
            argsObj.rows = lastToolRows;
          }
          if (!argsObj.title && lastToolName) {
            // Auto-generate a title from the last tool name
            const titleMap: Record<string, string> = {
              getCashSales: 'Ventas en Efectivo',
              getSalesOrdersSummary: 'Resumen de Ventas',
              getTopProducts: 'Productos Más Vendidos',
              getSalesBySalesperson: 'Ventas por Vendedor',
              getSalesByLocation: 'Ventas por Sucursal',
              getSalesByStatus: 'Ventas por Estado',
              getSalesByPaymentMethod: 'Ventas por Método de Pago',
              getSalesTrend: 'Tendencia de Ventas',
              getTopCustomers: 'Top Clientes',
              getAccountsReceivable: 'Cuentas por Cobrar',
              getRevenueAnalysis: 'Análisis de Ingresos',
              getDailyRevenue: 'Ingresos Diarios',
              getSalesRanking: 'Ranking de Ventas',
              getSalesKPIs: 'KPIs de Ventas',
              getProductCatalog: 'Catálogo de Productos',
              getLowStockAlerts: 'Alertas de Bajo Stock',
            };
            argsObj.title = titleMap[lastToolName] ?? 'Reporte UNIK';
          }
        }
      }

      const result = await executeTool(tc.name, input.actor, parsedArgs);

      // Track the last data tool result for auto-injection into artifact tools
      if (result.success && result.result && typeof result.result === 'object' && !ARTIFACT_TOOLS.has(tc.name)) {
        const toolResult = result.result as Record<string, unknown>;
        // Find the array of objects in the result (common keys: orders, products, rows, items, customers, etc.)
        let foundRows: Record<string, unknown>[] | null = null;
        for (const key of Object.keys(toolResult)) {
          const val = toolResult[key];
          if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
            foundRows = val as Record<string, unknown>[];
            break;
          }
        }
        if (foundRows) {
          lastToolRows = foundRows;
          lastToolName = tc.name;
        }
      }

      // If the tool generated an artifact, emit an artifact event
      if (result.success && result.result && typeof result.result === 'object') {
        const toolResult = result.result as Record<string, unknown>;
        if (toolResult.artifactId && toolResult.type) {
          yield {
            type: 'artifact',
            data: {
              artifactId: toolResult.artifactId,
              type: toolResult.type,
              title: toolResult.title,
              filename: toolResult.filename,
              downloadUrl: toolResult.downloadUrl,
              inlineRender: toolResult.inlineRender,
              rowCount: toolResult.rowCount,
              sizeBytes: toolResult.sizeBytes,
              pageCount: toolResult.pageCount,
              chartType: toolResult.chartType,
            },
          };
        }
      }

      // Audit tool call
      await recordAiToolCall({
        messageId: assistantMessage.id,
        toolName: tc.name,
        args: parsedArgs,
        result: result.result,
        durationMs: result.durationMs,
        success: result.success,
        errorCode: result.error,
      });

      // Add result to context
      messages.push({
        role: 'tool',
        content: JSON.stringify(result.success ? result.result : { error: result.error }),
        tool_call_id: tc.id,
      });

      // Persist tool message
      await addMessage(
        input.conversationId,
        'tool',
        JSON.stringify(result.success ? result.result : { error: result.error }),
        null,
        0,
        0,
        result.durationMs,
        tc.id
      );

      yield {
        type: 'tool_call_end',
        data: {
          name: tc.name,
          success: result.success,
          durationMs: result.durationMs,
        },
      };
    }

    // Loop: call the active provider again with tool results
  }

  // Reached iteration limit
  yield {
    type: 'error',
    data: { message: 'El asistente alcanzó el límite de iteraciones de tools.' },
  };
}

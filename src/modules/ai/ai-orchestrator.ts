import type { CurrentUser } from '@/modules/auth/authorization';
import { chatCompletionStream, type ChatMessage, type ToolSpec } from './ai-client';
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
  type: 'token' | 'tool_call_start' | 'tool_call_end' | 'done' | 'error';
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

  // 9. Agent loop (max maxToolIterations)
  let iteration = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  while (iteration < settings.maxToolIterations) {
    iteration++;

    let iterationContent = '';
    let iterationToolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    let finishReason: string | undefined;

    for await (const chunk of chatCompletionStream({
      messages,
      tools: toolSpecs.length > 0 ? toolSpecs : undefined,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      userId: input.actor.id,
      conversationId: input.conversationId,
      model: input.model,
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

      const result = await executeTool(tc.name, input.actor, parsedArgs);

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

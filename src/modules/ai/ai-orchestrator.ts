import type { CurrentUser } from '@/modules/auth/authorization';
import { chatCompletionStream, type ChatMessage, type ToolSpec, type ContentPart } from './ai-client';
import { AiApiError } from './ai-client';
import { buildSystemPrompt } from './ai-context-builder';
import {
  loadAvailableTools,
  executeTool,
  toOpenAiTools,
} from './tools/index';
import { refreshExternalTools } from '@/modules/extensions/external-tools';
import { buildUiComponents } from './generative-ui/build-ui';
import { getPreferences, PAUSED_MODE_HIDDEN_EFFECTS } from '@/modules/copilot/preferences-service';
import { getAiSettings } from './ai-admin-config-service';
import {
  getMessages,
  addMessage,
  autoTitleConversation,
} from './ai-sessions-service';
import { recordAiToolCall } from './ai-audit';
import { checkRateLimit, recordTokenUsage } from './ai-rate-limit';
import { validateInput, validateOutput } from './ai-guardrails';
import { listAttachments, processAttachment, resolveAttachmentsForMessage, type AttachmentResult } from './ai-attachments-service';
import { prisma } from '@/lib/prisma';
import { buildReportSubtitle, buildSummaryCards } from './ai-report-helpers';
import { resolveReportCustomization, type ReportCustomization } from './report-customization';
import {
  ARTIFACT_TOOL_NAMES,
  collectRowArrays,
  declaredRowTotal,
  findLastDataToolResult,
  pickPrimaryRowArray,
  resolveReportRows,
  type ReportRowsDecision,
} from './ai-history-data';
import { maybeSummarizeConversation } from './ai-conversation-summary';
import { absoluteUrl } from '@/lib/app-url';
import type { Prisma } from '@prisma/client';
import type { ToolDefinition, ToolExecutionResult } from './tools/registry';
import { CORE_TOOL_NAMES, PROVIDER_MAX_TOOLS, findToolsByTopic, selectToolsForTurn } from './tool-selector';
import { classifyTask, classifyTaskWithJev, pickModelForTier, resolveTurnModel } from './model-router';
import { decide, answerBool, answerScore } from './decisions/decision-engine';
import { draftConfidenceDecision, reviewNeededDecision } from './decisions/decision-points';
import { detectDomainsWithJev } from './decisions/jev-domains';
import { prefetchLikelyRead } from './prefetch';
import { wrapUntrusted } from './ai-guardrails';
import { redactDeep } from '@/modules/extensions/secrets';
import { getModelById } from './model-catalog';
import { isReasoningModel } from './providers/openai';
import { buildTurnDirectives, looksUnfinished, stripMarkdownImages, wantsDocument } from './turn-directives';
import { reviewComplexAnswer } from './ai-answer-review';
import { checkAnswer, collectFolios, collectResultNumbers } from './answer-checks';
import { emitWorkspaceEvents, workspaceEventsForTool } from './workspace-events';
import {
  capabilitiesFromTools,
  capabilityPromptBlock,
  describeSourcesUsed,
  detectRequiredCapabilities,
  forcedToolNames,
  missingCapabilityNote,
} from './capabilities';
import { parseFollowUps } from './followups';
import { captureLearnings } from './ai-learning';
import { buildRevisionDirective, isRevisionRequest, mergeRevisionArgs, type RevisionContext } from './revisions';
import { inferConfidence, parseConfidence } from './confidence';
import { mergeMessageMeta } from './ai-sessions-service';
import { attachmentKind } from './ai-attachments-service';
import { judgeTurnQuality } from './ai-quality-judge';
import { notifyAiTaskDone } from './ai-notifications';

interface OrchestratorInput {
  conversationId: string;
  message: string;
  actor: CurrentUser;
  context?: {
    page?: string;
    voice?: boolean;
    /** Set when the assistant runs as the inbox copilot of this conversation. */
    inboxConversationId?: string;
    /** Set when the assistant runs as the internal-chat copilot of this channel. */
    chatChannelId?: string;
  };
  /** Optional model override — user can pick a model in the chat UI ("auto" = routing). */
  model?: string;
  /** Plan-then-execute requested for this message: propose steps, wait for confirmation. */
  planFirst?: boolean;
  /** Always notify (in-app + push) when this turn finishes, even if it was quick. */
  notifyWhenDone?: boolean;
  /**
   * Optional attachment IDs (images/PDFs uploaded by the user). They are
   * resolved server-side: must belong to this conversation and user, be
   * unlinked and READY. Paths are never accepted from the client.
   */
  attachmentIds?: string[];
}

interface OrchestratorEvent {
  type: 'token' | 'tool_call_start' | 'tool_call_end' | 'artifact' | 'proposal' | 'action' | 'ui' | 'done' | 'error';
  data?: unknown;
}

/** Tools whose successful result must open something in the user's screen (call dock, internal call). */
const UI_ACTION_TOOLS = new Set(['callContact', 'startOutboundCall', 'startInternalCall']);

const EXPORT_MAX_ROWS = 5000;
const EXPORT_PAGE_SIZE = 200; // querySalesOrders' Zod max

/** Tools that only make sense inside a copilot side panel (any surface). */
const SURFACE_ONLY_TOOLS = new Set(['suggestNextActions']);
/** Tools that only exist inside the inbox copilot (take `inboxConversationId`). */
const INBOX_ONLY_TOOLS = new Set([
  'proposeInboxDraft',
  'updateInboxConversation',
  'addInboxNote',
]);
/** Tools that take the inbox conversation as context (customer = the contact of this conversation). */
const INBOX_CONTEXT_TOOLS = new Set(['draftQuoteFromRequest', 'sendQuoteToContact']);
/** Tools that only exist inside the internal-chat copilot. */
const CHAT_ONLY_TOOLS = new Set(['proposeChatDraft']);
/** In the inbox the quote path is draftQuoteFromRequest → sendQuoteToContact (one approval); the manual builders only confuse the model there. */
const INBOX_HIDDEN_TOOLS = new Set(['createQuote', 'previewQuote']);
/** Chat tools whose `chatChannelId` defaults to the current channel. */
const CHAT_CHANNEL_ID_TOOLS = new Set([
  'getChatChannelMessages',
  'summarizeChatChannel',
  'proposeChatDraft',
  'pinChatMessage',
  'searchChatMessages',
]);
/** Existing comms tools whose `conversationId` means the inbox conversation. */
const INBOX_CONVERSATION_ID_TOOLS = new Set([
  'getConversationMessages',
  'draftReply',
  'sendInboxMessage',
  'createCommitment',
]);

/**
 * Drops orphan tool replies (no preceding assistant tool_calls in the window)
 * and strips tool_calls whose replies were cut off, so the provider always sees
 * a valid sequence. Pure; keeps everything else untouched.
 */
export function sanitizeHistory<T extends { role: string; toolCalls: unknown; toolCallId: string | null }>(history: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i];
    if (m.role === 'tool') {
      i += 1; // orphan: nothing with tool_calls precedes it inside the window
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && (m.toolCalls as unknown[]).length > 0) {
      const ids = new Set((m.toolCalls as Array<{ id: string }>).map((tc) => tc.id));
      const replies: T[] = [];
      let j = i + 1;
      while (j < history.length && history[j].role === 'tool') {
        replies.push(history[j]);
        j += 1;
      }
      const answered = replies.filter((r) => r.toolCallId && ids.has(r.toolCallId));
      if (answered.length === ids.size) {
        out.push(m, ...answered);
      } else {
        // Incomplete pair: keep the assistant text without tool_calls.
        out.push({ ...m, toolCalls: null });
      }
      i = j;
      continue;
    }
    out.push(m);
    i += 1;
  }
  return out;
}

async function linkArtifactToMessage(artifactId: string, messageId: string, spec: Record<string, unknown>): Promise<void> {
  try {
    const row = await prisma.aiArtifact.findUnique({ where: { id: artifactId }, select: { meta: true } });
    if (!row) return;
    const meta = { ...((row.meta as Record<string, unknown> | null) ?? {}), spec };
    await prisma.aiArtifact.update({ where: { id: artifactId }, data: { messageId, meta: meta as Prisma.InputJsonValue } });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'ai.artifact.link_failed', artifactId, message: error instanceof Error ? error.message : 'unknown' }));
  }
}

/** The records array of a result, read from the SAME field as the original result when known. */
function recordRowsOf(result: Record<string, unknown> | null | undefined, rowKey: string | null): Record<string, unknown>[] | null {
  if (!result) return null;
  // A page past the end has `orders: []` — never fall back to another array (a breakdown) then.
  if (rowKey && Array.isArray(result[rowKey])) return result[rowKey] as Record<string, unknown>[];
  return pickPrimaryRowArray(result)?.rows ?? null;
}

/**
 * Chat tool results are paginated so the model's context stays small, but a report must hold
 * every matching row. When the last data result was a partial page, re-run the same tool with
 * the same filters page by page (never through the model) and concatenate the rows.
 */
async function fetchAllRowsForExport(
  toolName: string | null,
  toolArgs: Record<string, unknown> | null,
  lastResult: Record<string, unknown> | null,
  rowKey: string | null,
  fallbackRows: Record<string, unknown>[],
  actor: CurrentUser
): Promise<Record<string, unknown>[]> {
  if (!toolName || !toolArgs || !lastResult) return fallbackRows;
  const total = declaredRowTotal(lastResult) ?? NaN;
  const showing = Number(lastResult.showing ?? fallbackRows.length);
  const totalPages = Number(lastResult.totalPages ?? 1);
  const paginated = Number.isFinite(total) && (total > showing || totalPages > 1);
  if (!paginated || !('page' in toolArgs || 'pageSize' in toolArgs || lastResult.mode === 'list')) {
    return fallbackRows;
  }

  const all: Record<string, unknown>[] = [];
  const pages = Math.min(Math.ceil(total / EXPORT_PAGE_SIZE), Math.ceil(EXPORT_MAX_ROWS / EXPORT_PAGE_SIZE));
  for (let page = 1; page <= pages; page++) {
    const res = await executeTool(toolName, actor, { ...toolArgs, page, pageSize: EXPORT_PAGE_SIZE });
    if (!res.success || !res.result || typeof res.result !== 'object') break;
    const rows = recordRowsOf(res.result as Record<string, unknown>, rowKey);
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < EXPORT_PAGE_SIZE) break;
  }
  return all.length >= fallbackRows.length ? all : fallbackRows;
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

  // 3.5. Resolve attachments BEFORE persisting anything: only the actor's own,
  // unlinked, READY files of this conversation are accepted (quarantined or
  // foreign files are silently dropped).
  let resolvedAttachments: AttachmentResult[] = [];
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    resolvedAttachments = await resolveAttachmentsForMessage(
      input.conversationId,
      input.actor.id,
      input.attachmentIds
    );
    if (resolvedAttachments.length < new Set(input.attachmentIds).size) {
      console.warn('[orchestrator] Some attachments were ignored (not ready or not owned)');
    }
  }

  const runStartedAt = Date.now();

  // 4. Persist user message
  const userMessage = await addMessage(input.conversationId, 'user', input.message, null, 0, 0, 0);
  await autoTitleConversation(input.conversationId, input.message);

  // 4.5. Associate attachments with the user message (same guard as the resolver)
  if (resolvedAttachments.length > 0) {
    try {
      await prisma.aiAttachment.updateMany({
        where: {
          id: { in: resolvedAttachments.map((a) => a.id) },
          conversationId: input.conversationId,
          uploadedBy: input.actor.id,
          messageId: null,
        },
        data: { messageId: userMessage.id },
      });
    } catch (err) {
      console.error('[orchestrator] Error associating attachments:', err);
    }
  }

  // 5. Load history
  const history = await getMessages(
    input.conversationId,
    input.actor.id,
    settings.maxConversationMessages
  );

  // 5.5. Resolve the tools the actor can actually use BEFORE the prompt — the
  // capability list the model sees must be truthful (what is enabled, not what
  // exists in code). `isAutoTrigger` is derived early: filters depend on it.
  const inboxConversationId = input.context?.inboxConversationId;
  const chatChannelId = input.context?.chatChannelId;
  const isAutoTrigger = input.message.startsWith('⟦auto:');
  const actorPreferences = await getPreferences(input.actor.id).catch(() => null);
  const lastAssistantContent = [...history].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0)?.content ?? null;
  const documentRequested = wantsDocument(input.message, lastAssistantContent);
  await refreshExternalTools();
  const loadedTools = await loadAvailableTools(input.actor, settings.enabledTools, {
    page: input.context?.page,
  });
  // Paused mode: the assistant keeps answering and drafting, but tools with side
  // effects are not even offered to the model.
  const availableTools = (
    actorPreferences?.mode === 'paused'
      ? loadedTools.filter((t) => !PAUSED_MODE_HIDDEN_EFFECTS.has(t.effect ?? 'read'))
      : loadedTools
  )
    // An elaborate document is only offered when the user asked for one (or accepted an offer):
    // otherwise the model spends minutes writing a 15-page file nobody requested.
    .filter((t) => documentRequested || isAutoTrigger || t.name !== 'composeDocument')
    .filter((t) => inboxConversationId || chatChannelId || !SURFACE_ONLY_TOOLS.has(t.name))
    .filter((t) => inboxConversationId || !INBOX_ONLY_TOOLS.has(t.name))
    .filter((t) => !inboxConversationId || !INBOX_HIDDEN_TOOLS.has(t.name))
    .filter((t) => chatChannelId || !CHAT_ONLY_TOOLS.has(t.name));

  // 6. Build system prompt (+ the live inbox context when running as copilot)
  let systemPrompt = await buildSystemPrompt(input.actor, { ...input.context, conversationId: input.conversationId });
  // Capability contract: the prompt states what is REALLY on/off this turn so a
  // missing capability becomes an honest admission instead of an improvised lie.
  const capabilityStatus = capabilitiesFromTools(availableTools);
  systemPrompt += `\n\n${capabilityPromptBlock(capabilityStatus)}`;
  const requiredCaps = detectRequiredCapabilities(input.message);
  const missingCaps = requiredCaps.filter((r) => !capabilityStatus.find((c) => c.id === r.cap)?.available);
  if (missingCaps.length > 0) systemPrompt += `\n\n${missingCapabilityNote(missingCaps, capabilityStatus)}`;
  try {
    const { buildComposioPrompt } = await import('@/modules/composio/composio-prompt');
    const composioBlock = await buildComposioPrompt(input.actor);
    if (composioBlock) systemPrompt += `\n\n${composioBlock}`;
  } catch (err) {
    console.warn('[orchestrator] composio prompt skipped:', err instanceof Error ? err.message : err);
  }
  if (inboxConversationId) {
    const { buildInboxCopilotPrompt } = await import('@/modules/comms/inbox-copilot');
    systemPrompt += `\n\n${await buildInboxCopilotPrompt(input.actor, inboxConversationId)}`;
  } else if (chatChannelId) {
    const { buildChatCopilotPrompt } = await import('@/modules/chat/chat-copilot');
    systemPrompt += `\n\n${await buildChatCopilotPrompt(input.actor, chatChannelId)}`;
  }

  // 6.5. Agent memory recall: episodes, confirmed facts and playbooks relevant to THIS
  // message. Injected before classification so it informs tool choice and routing.
  // Skipped when the user disabled memory in preferences (loaded above).
  if (actorPreferences?.memoryEnabled !== false) {
    const { buildRecallBlock } = await import('@/modules/memory/memory-service');
    const recallBlock = await buildRecallBlock(input.actor.id, input.message).catch(() => '');
    if (recallBlock) systemPrompt += `\n\n${recallBlock}`;
  }

  // 7. Build messages (history is sanitized so every `tool` reply follows its
  // `tool_calls` message — the context window can otherwise cut a pair in half
  // and the provider rejects the request with a 400).
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...sanitizeHistory(history).map((m) => {
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

  // 7.4. Files sent EARLIER in this thread stay available, like in ChatGPT: a follow-up
  // ("dame un PDF con todo", "revisa la segunda hoja") must not depend on the model's own
  // earlier transcription. They are re-attached (newest first, bounded) on every turn that
  // is not a trivial acknowledgement.
  const recentToolNames = [
    ...new Set(
      history
        .filter((m) => m.role === 'assistant' && Array.isArray(m.toolCalls))
        .flatMap((m) => (m.toolCalls as Array<{ name?: string }>).map((tc) => tc.name).filter((n): n is string => typeof n === 'string'))
    ),
  ];
  let priorAttachments: AttachmentResult[] = [];
  if (!isAutoTrigger && !input.context?.voice) {
    try {
      const priorRows = await prisma.aiAttachment.findMany({
        where: { conversationId: input.conversationId, messageId: { not: null }, NOT: { messageId: userMessage.id } },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: 6,
      });
      if (priorRows.length > 0) {
        const wanted = new Set(priorRows.map((r) => r.id));
        const all = await listAttachments(input.conversationId);
        const candidates = all.filter((a) => wanted.has(a.id) && (a.status === 'ready' || a.status === 'legacy'));
        const prelim = classifyTask({
          message: input.message,
          attachmentKinds: [...resolvedAttachments, ...candidates].map((a) => {
            const k = attachmentKind(a.mimeType);
            return k === 'text' ? 'other' : k;
          }),
          planFirst: input.planFirst,
          recentToolNames,
        });
        if (prelim.tier !== 'simple') priorAttachments = candidates;
      }
    } catch (err) {
      console.warn('[orchestrator] prior attachments skipped:', err instanceof Error ? err.message : err);
    }
  }
  const priorIds = new Set(priorAttachments.map((a) => a.id));
  const attachmentsForContext = [...resolvedAttachments, ...priorAttachments];
  // Order numbers listed in text attachments (a PDF/CSV of orders) = the universe handwritten
  // folios are reconciled against (lookupSalesOrdersByNumber reads it from the tool context).
  const attachmentOrderNumbers: string[] = [];
  const collectOrderNumbers = (text: string) => {
    const seen = new Set(attachmentOrderNumbers);
    for (const m of text.matchAll(/\b(?:OV|SO)-?\s?(\d{4,7})\b/gi)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        attachmentOrderNumbers.push(m[1]);
      }
    }
  };

  // 7.5. Process attachments — inject multimodal content into the last user message
  if (attachmentsForContext.length > 0) {
    // Find the last user message (the one just added)
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx >= 0) {
      const userText = messages[lastUserIdx].content as string;
      const contentParts: ContentPart[] = [{ type: 'text', text: userText }];

      // Process each attachment
      for (const att of attachmentsForContext) {
        try {
          const processed = await processAttachment(att);
          const priorTag = priorIds.has(att.id) ? ' (enviado en un mensaje anterior de esta conversación)' : '';

          if (processed.type === 'image') {
            // Add image content part for OpenAI Vision
            contentParts.push({ type: 'text', text: `[Imagen adjunta "${att.fileName}"${priorTag}]` });
            contentParts.push({
              type: 'image_url',
              image_url: { url: processed.dataUrl },
            });
          } else if (processed.type === 'text') {
            if (attachmentOrderNumbers.length < 5000) collectOrderNumbers(processed.content);
            // Add extracted text (PDF, Word, Excel, transcript, plain text) as a text content part
            const kind = attachmentKind(att.mimeType);
            const label = (att.mimeType === 'application/pdf'
              ? `[Contenido del PDF "${att.fileName}"`
              : kind === 'audio'
                ? `[Audio "${att.fileName}"`
                : kind === 'document'
                  ? `[Contenido del documento "${att.fileName}"`
                  : `[Contenido del archivo "${att.fileName}"`) + `${priorTag}]`;
            contentParts.push({
              type: 'text',
              text: `${label}:\n${processed.content}`,
            });
          } else if (processed.type === 'file_part') {
            // Scanned PDF: the model reads the file itself (OCR fallback with vision)
            contentParts.push({ type: 'text', text: processed.note });
            contentParts.push({ type: 'file', file: { filename: processed.filename, file_data: processed.dataUrl } });
          } else if (processed.type === 'file') {
            contentParts.push({ type: 'text', text: processed.content });
          }
        } catch (err) {
          console.error(`[orchestrator] Error processing attachment ${att.fileName}:`, err);
          contentParts.push({
            type: 'text',
            text: `[Error al procesar el archivo "${att.fileName}"]`,
          });
        }
      }

      // Replace the last user message with multimodal content
      messages[lastUserIdx] = {
        role: 'user',
        content: contentParts,
      };
    }
  }

  // 8. Tools were already loaded and capability-filtered above (the prompt needs
  // them first). `availableTools` is the actor's real menu for this turn.

  // 8.4. Jev decisions (one cheap call each, run in parallel): which domains this
  // message touches beyond the regex pass, and which model tier the turn needs.
  const attachmentKindList = attachmentsForContext.map((a) => {
    const k = attachmentKind(a.mimeType);
    return k === 'text' ? 'other' : k;
  });
  const [jevDomains, classification] = await Promise.all([
    detectDomainsWithJev(input.message, {
      userId: input.actor.id,
      conversationId: input.conversationId,
    }).catch(() => [] as string[]),
    classifyTaskWithJev(
      {
        message: input.message,
        attachmentKinds: attachmentKindList,
        planFirst: input.planFirst,
        autoTrigger: isAutoTrigger,
        recentToolNames,
      },
      { userId: input.actor.id, conversationId: input.conversationId }
    ).catch(() => classifyTask({
      message: input.message,
      attachmentKinds: attachmentKindList,
      planFirst: input.planFirst,
      autoTrigger: isAutoTrigger,
      recentToolNames,
    })),
  ]);

  // 8.5. Offer only the tools that matter this turn (OpenAI accepts ≤128; every tool costs tokens).
  // Core + surface tools are always present; the rest is chosen by relevance and recent use.
  // `loadMoreTools` lets the model pull any other tool by topic in one extra step.
  const pinnedTools = [
    ...(inboxConversationId ? [...INBOX_ONLY_TOOLS, ...INBOX_CONVERSATION_ID_TOOLS, 'suggestNextActions', 'draftQuoteFromRequest', 'sendQuoteToContact'] : []),
    ...(chatChannelId ? [...CHAT_ONLY_TOOLS, ...CHAT_CHANNEL_ID_TOOLS, 'suggestNextActions', 'listChatChannels', 'startInternalCall', 'createChatEvent'] : []),
  ];
  // A "simple" turn (greeting, thanks, short clarification — no data intent and no
  // recent tool context) gets the cheap model AND a minimal prompt: three tool
  // specs instead of ~30. `loadMoreTools` is the escape valve — if the classifier
  // misread the intent, the model pulls real tools in one extra step.
  // A capability the user explicitly asked for can NEVER be starved this way:
  // `forced` tools enter the menu even on the simple tier or a dropped domain.
  const forced = forcedToolNames(
    requiredCaps.filter((r) => !missingCaps.some((m) => m.cap === r.cap)),
    availableTools
  );
  const SIMPLE_TIER_TOOLS = new Set(['loadMoreTools', 'getSystemTime', 'recallMemory']);
  const selection =
    classification.tier === 'simple' && pinnedTools.length === 0 && forced.size === 0
      ? {
          offered: availableTools.filter((t) => SIMPLE_TIER_TOOLS.has(t.name)),
          dropped: [] as ToolDefinition[],
          domains: [] as string[],
        }
      : selectToolsForTurn({
          tools: availableTools,
          message: input.message,
          recentToolNames,
          pinned: pinnedTools,
          extraDomains: jevDomains,
          // Attachment turns are long already: fewer tools = smaller prompt on every pass.
          maxTools: Math.min(Math.max(8, Number(settings.maxToolsPerTurn) || 96), PROVIDER_MAX_TOOLS, attachmentsForContext.length > 0 ? 48 : PROVIDER_MAX_TOOLS),
        });
  // Same set ⇒ same order: the serialized tools are the first part of every request and a
  // stable prefix is what lets the provider cache the prompt between passes and turns.
  const mergedOffered = [...selection.offered];
  for (const t of availableTools) {
    if (forced.has(t.name) && !mergedOffered.some((o) => o.name === t.name)) mergedOffered.push(t);
  }
  let offeredTools: ToolDefinition[] = mergedOffered.sort((a, b) => a.name.localeCompare(b.name));
  let toolSpecs: ToolSpec[] = toOpenAiTools(offeredTools);
  const availableByName = new Map(availableTools.map((t) => [t.name, t] as const));
  if (selection.dropped.length > 0) {
    console.log(JSON.stringify({ event: 'ai.tools.selected', offered: offeredTools.length, dropped: selection.dropped.length, domains: selection.domains }));
  }

  // 8.6. Model routing: explicit choice wins; "auto"/none → the classification above
  // (Jev when enabled, heuristics otherwise) picks the cheapest capable model.
  const routing = resolveTurnModel(settings, input.model, classification);
  const effectiveModel = routing.model;
  const fallbackModel = settings.fallbackDeployment;

  // Output budget: a complex turn (analysis, cross-check of attachments, a composed
  // document with every row written by the model) needs far more than a chat answer.
  // The admin's maxTokens is the floor; the model's own output cap is the ceiling.
  const resolveTurnMaxTokens = (model: string): number => {
    const cap = getModelById(model)?.maxOutput;
    const heavy = classification.tier === 'complex' || attachmentsForContext.length > 0;
    // Reasoning models spend part of the budget thinking: give them room for both.
    const wanted = heavy ? Math.max(settings.maxTokens, isReasoningModel(model) ? 32_000 : 12_000) : settings.maxTokens;
    return cap && cap > 0 ? Math.min(wanted, cap) : wanted;
  };
  const turnReasoningEffort = classification.tier === 'complex' ? settings.reasoningEffort || 'high' : classification.tier === 'simple' ? 'minimal' : 'low';

  // 8.65. Working instructions for THIS turn go last in the system prompt (most recent = most
  // followed): the attachment/analysis protocol, the document protocol or the complex-task bar.
  const directives = buildTurnDirectives({
    message: input.message,
    tier: classification.tier,
    attachmentKinds: resolvedAttachments.map((a) => attachmentKind(a.mimeType)),
    priorAttachmentKinds: priorAttachments.map((a) => attachmentKind(a.mimeType)),
    voice: Boolean(input.context?.voice),
    autoTrigger: isAutoTrigger,
    modelReasonsWithVision: isReasoningModel(effectiveModel) && (getModelById(effectiveModel)?.capabilities.includes('vision') ?? true),
    lastAssistantContent,
  });
  if (directives && messages[0] && typeof messages[0].content === 'string') {
    messages[0].content += `\n\n${directives}`;
  }

  // 8.67. Objective detection (Jev): a message that delegates lasting work
  // ("investiga X y avísame", "vigila Y cada mañana") becomes a Mission proposal
  // instead of a one-shot answer. Chat and data asks stay in this turn.
  if (!isAutoTrigger && !input.context?.voice && classification.tier !== 'simple') {
    try {
      const { missionClassifyDecision } = await import('./decisions/decision-points');
      const { decide, answerChoice } = await import('./decisions/decision-engine');
      const mc = missionClassifyDecision(input.message);
      const kind = await decide(mc.state, mc.questions, {
        userId: input.actor.id,
        conversationId: input.conversationId,
      }).then((r) => answerChoice(r, 'kind', ['chat', 'consulta', 'objetivo', 'rutina'] as const));
      if (kind === 'objetivo' || kind === 'rutina') {
        messages[0].content += `\n\n## OBJETIVO DETECTADO
El mensaje del usuario delega trabajo que dura más que este turno${kind === 'rutina' ? ' (es recurrente)' : ''}. NO lo resuelvas improvisando en esta respuesta: llama proposeMission con el objetivo claro y los pasos concretos${kind === 'rutina' ? ' y el schedule apropiado ("daily:HH:mm" CDMX o "every:N" minutos)' : ''}. La misión corre cuando el usuario la aprueba, paso a paso, y le avisa al terminar. Si además hay algo contestable ya mismo, respóndelo breve y propón la misión para el trabajo duradero.`;
      }
    } catch (err) {
      console.warn('[orchestrator] mission classify skipped:', err instanceof Error ? err.message : err);
    }
  }

  // 8.66. "Quita los totales", "ponlo en vertical": changes apply to the file just delivered.
  // The model is told what it generated it with; the generator gets the previous arguments
  // under the new ones; the result becomes the next version of the same document.
  let revision: RevisionContext | null = null;
  if (!isAutoTrigger && isRevisionRequest(input.message)) {
    try {
      const last = await prisma.aiArtifact.findFirst({
        where: { conversationId: input.conversationId, type: { in: ['pdf', 'xlsx', 'docx', 'csv', 'image'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, type: true, meta: true },
      });
      const meta = (last?.meta as Record<string, unknown> | null) ?? null;
      const spec = meta?.spec as { generatedBy?: string; generatorArgs?: Record<string, unknown> } | undefined;
      if (last && spec?.generatedBy && spec.generatorArgs && !meta?.supersededBy) {
        revision = {
          artifactId: last.id,
          type: last.type,
          title: typeof meta?.title === 'string' ? meta.title : 'Documento',
          version: typeof meta?.version === 'number' ? meta.version : 1,
          generatedBy: spec.generatedBy,
          generatorArgs: spec.generatorArgs,
        };
        if (messages[0] && typeof messages[0].content === 'string') messages[0].content += `\n\n${buildRevisionDirective(revision)}`;
      }
    } catch (err) {
      console.warn('[orchestrator] revision context skipped:', err instanceof Error ? err.message : err);
    }
  }

  // 8.7. Live data requested explicitly → bypass the short-TTL read cache this turn.
  const wantsFreshData = /\b(actualiza\w*|en tiempo real|refresca\w*|sin cach[eé]|datos de ahora|ahorita mismo|al momento)\b/i.test(input.message);

  // 8.75. Prefetch: Jev predicts the one read the model will almost surely call and
  // warms the shared read cache while the first model call is still in flight. Only
  // cacheable reads the actor can actually run; skipped when the user asked for
  // live data (that call bypasses the cache anyway) or the turn is trivial.
  if (!isAutoTrigger && classification.tier !== 'simple' && !wantsFreshData) {
    void prefetchLikelyRead(input.message, input.actor, offeredTools, {
      userId: input.actor.id,
      conversationId: input.conversationId,
      enabledToolNames: settings.enabledTools,
    })
      .then((p) => {
        if (p) console.log(JSON.stringify({ event: 'ai.tools.prefetch', conversationId: input.conversationId, tool: p.tool, warmed: p.warmed, cached: p.cached }));
      })
      .catch(() => null);
  }

  // 8.8. Plan-then-execute requested from the UI for this message.
  if (input.planFirst && messages[0] && typeof messages[0].content === 'string') {
    messages[0].content += `\n\n## PLANEAR PRIMERO (activado por el usuario en este mensaje)
Antes de ejecutar cualquier tool de datos o acción, llama proposePlan con los pasos concretos y DETENTE. No ejecutes ningún paso hasta que el usuario confirme ("Ejecutar plan"). Si el mensaje del usuario ES la confirmación de un plan anterior, ejecútalo en orden.`;
  }

  // 9. Agent loop (max maxToolIterations)
  let iteration = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let usingFallback = false;
  // Mid-turn escalation: a routed standard turn whose draft fails verification (or
  // whose confidence Jev scores low) re-runs the final answer once on the
  // complex-tier model — escalation, not degradation. Explicit picks never escalate.
  let escalatedModel: string | null = null;
  const escalateModel = (): string | null => {
    if (escalatedModel || !routing.routed) return escalatedModel;
    const heavy = pickModelForTier(settings, 'complex');
    const pick =
      classification.needsVision && !(getModelById(heavy)?.capabilities.includes('vision'))
        ? settings.deployment?.trim() || 'gpt-4o'
        : heavy;
    if (pick === effectiveModel) return null;
    escalatedModel = pick;
    console.log(JSON.stringify({ event: 'ai.model.escalated', conversationId: input.conversationId, from: effectiveModel, to: pick }));
    return pick;
  };
  // Complex answers are reviewed before the user sees them, so their tokens are held back
  // and released in one piece (or rewritten once). Everything else streams as usual.
  // A reasoning model already checks its own work while thinking; a second pass would add
  // minutes for little gain. The review is for the models that answer in one shot.
  const bufferAnswer =
    settings.answerReviewEnabled !== false &&
    classification.tier === 'complex' &&
    !isAutoTrigger &&
    !input.context?.voice &&
    !isReasoningModel(effectiveModel);
  let nudges = 0;
  let reviews = 0;
  // Every folio a tool returned this turn: an answer may only cite these.
  const knownFolios = new Set<string>();
  // Every count/total a tool declared this turn: "9 ventas" or "$59,468" must match one.
  const knownTotals = { counts: new Set<number>(), money: new Set<number>() };
  const turnStats = { calls: 0, cachedHits: 0, parallelBatches: 0, dataToolsSucceeded: 0, failed: 0, loadedMore: 0 };
  const toolsUsedThisTurn: Array<{ name: string; success: boolean; cached?: boolean }> = [];
  // Provenance collected from real tool results — feeds the episode memory.
  const turnSources: string[] = [];
  const turnArtifacts: string[] = [];

  // Track the last DATA tool result so we can auto-inject it into artifact tools.
  // Seeded from the conversation history ("generame un excel con la info que te pedí"), skipping
  // artifact results and resolving the originating call by toolCallId — see ai-history-data.ts.
  const seed = findLastDataToolResult(history);
  let lastToolRows: Record<string, unknown>[] | null = seed?.rows ?? null;
  let lastToolRowKey: string | null = seed?.rowKey ?? null;
  /** Row decision per artifact tool call id: blocks incomplete reports and tells the model what the file holds. */
  const reportRowChecks = new Map<string, ReportRowsDecision>();
  let lastToolName: string | null = seed?.toolName ?? null;
  let lastToolArgs: Record<string, unknown> | null = seed?.toolArgs ?? null;
  let lastToolResult: Record<string, unknown> | null = seed?.result ?? null;

  // Tools that consume rows (and therefore get them auto-injected). generateChart is handled
  // separately (labels/series), listArtifacts/cleanupArtifacts take no data at all.
  const ARTIFACT_TOOLS = new Set([
    'generatePdfReport',
    'generateExcelReport',
    'generateCsvExport',
    'generateReportImage',
    'generateTable',
  'generateWordReport',
]);

  /**
   * Builds a dynamic report title based on the tool name and its arguments.
   * Works with querySalesOrders (the universal sales tool) and other tools.
   */
  function buildDynamicTitle(toolName: string, toolArgs: Record<string, unknown> | null): string {
    const dateRange = toolArgs?.dateRange as string | undefined;
    const dateLabel = dateRange === 'today' ? ' de Hoy'
      : dateRange === 'yesterday' ? ' de Ayer'
      : dateRange === 'this_week' ? ' de Esta Semana'
      : dateRange === 'this_month' ? ' de Este Mes'
      : dateRange === 'last_month' ? ' del Mes Pasado'
      : dateRange === 'last_7_days' ? ' de los Últimos 7 Días'
      : dateRange === 'last_30_days' ? ' de los Últimos 30 Días'
      : dateRange === 'this_year' ? ' de Este Año'
      : dateRange === 'last_year' ? ' del Año Pasado'
      : dateRange === 'all' ? ' (Histórico)'
      : '';

    // For querySalesOrders, build title from filters
    if (toolName === 'querySalesOrders') {
      const parts: string[] = ['Ventas'];
      const paymentMethods = toolArgs?.paymentMethods as string[] | undefined;
      const deliveryMethod = toolArgs?.deliveryMethod as string | undefined;
      const deliveryType = toolArgs?.deliveryType as string | undefined;
      const shippingLocation = toolArgs?.shippingLocation as string | undefined;
      const customer = toolArgs?.customer as string | undefined;
      const salesperson = toolArgs?.salesperson as string | undefined;
      const product = toolArgs?.product as string | undefined;
      const groupBy = toolArgs?.groupBy as string | undefined;
      const ticketStatus = toolArgs?.ticketStatus as string | undefined;
      const shippedStatus = toolArgs?.shippedStatus as string | undefined;
      const paidStatus = toolArgs?.paidStatus as string | undefined;
      const invoicedStatus = toolArgs?.invoicedStatus as string | undefined;
      const status = toolArgs?.status as string | undefined;

      // A status filter changes WHAT the report is about — it must be visible in the title so a
      // narrowed result ("55 pendientes") is never mistaken for the full set ("76 ventas").
      const statusLabel = (v: string | undefined, map: Array<[RegExp, string]>): string | null => {
        if (!v) return null;
        const n = v.toLowerCase();
        for (const [re, label] of map) if (re.test(n)) return label;
        return v;
      };
      const ticketLabel = statusLabel(ticketStatus, [
        [/pendiente de entrega|por entregar|sin entregar|no entregad|falta/, 'Pendientes de Entrega'],
        [/no (se ha )?cerrad|sin cerrar|abiert/, 'Abiertas (sin cerrar)'],
        [/entregad/, 'Entregadas'],
        [/cerrad|terminad|finalizad/, 'Cerradas'],
        [/transito/, 'En Tránsito'],
        [/pendiente de envio/, 'Pendientes de Envío'],
      ]);
      const shippedLabel = statusLabel(shippedStatus, [
        [/por entregar|por enviar|pendiente|no enviad|sin enviar/, 'Sin Salir de Bodega'],
        [/entregad|enviad/, 'Enviadas'],
      ]);
      const paidLabel = statusLabel(paidStatus, [
        [/con saldo|adeudo|deben|credito/, 'con Saldo Pendiente'],
        [/sin pagar|no pagad|pendiente|por cobrar/, 'No Pagadas'],
        [/parcial|abonad/, 'Parcialmente Pagadas'],
        [/pagad|liquidad|cobrad/, 'Pagadas'],
      ]);
      const invoicedLabel = statusLabel(invoicedStatus, [
        [/sin facturar|no facturad|por facturar|pendiente/, 'Sin Facturar'],
        [/facturad/, 'Facturadas'],
      ]);
      const orderLabel = statusLabel(status, [
        [/borrador|draft/, 'en Borrador'],
        [/anulad|cancelad|void/, 'Anuladas'],
        [/cerrad|closed/, 'Cerradas'],
        [/confirmad/, 'Confirmadas'],
      ]);
      if (ticketLabel) parts.push(ticketLabel);
      else if (shippedLabel) parts.push(shippedLabel);
      if (paidLabel) parts.push(paidLabel);
      if (invoicedLabel) parts.push(invoicedLabel);
      if (orderLabel && !ticketLabel) parts.push(orderLabel);

      if (paymentMethods && paymentMethods.length > 0) {
        if (paymentMethods.length === 1) {
          const pm = paymentMethods[0];
          parts.push(pm === 'EFECTIVO' ? 'en Efectivo'
            : pm === 'EFECTIVO EN BODEGA' ? 'en Efectivo en Bodega'
            : pm === 'TRANSFERENCIA' ? 'por Transferencia'
            : pm === 'DEPOSITO' ? 'por Depósito'
            : pm === 'TARJETA' ? 'con Tarjeta'
            : `por ${pm}`);
        } else {
          parts.push(`por ${paymentMethods.join(' + ')}`);
        }
      }
      if (deliveryMethod) {
        parts.push(deliveryMethod.toLowerCase().includes('pie') ? 'a Pie de Obra'
          : deliveryMethod.toLowerCase().includes('recoge') ? 'Recoge en Bodega'
          : deliveryMethod.toLowerCase().includes('instal') ? 'Instalación a Domicilio'
          : deliveryMethod);
      } else if (deliveryType) {
        parts.push(
          deliveryType === 'pie_de_obra' ? 'a Pie de Obra'
            : deliveryType === 'recoge_en_bodega' ? 'Recoge en Bodega'
            : deliveryType === 'instalacion' ? 'con Instalación'
            : deliveryType === 'domicilio' ? 'a Domicilio'
            : 'con Entrega a Cliente'
        );
      }
      if (shippingLocation) parts.push(`en ${shippingLocation}`);
      if (product) parts.push(`de ${product}`);
      if (customer) parts.push(`de ${customer}`);
      if (salesperson) parts.push(`de ${salesperson}`);
      if (groupBy === 'product') parts.push('por Producto');
      if (groupBy === 'paymentMethod') parts.push('por Método de Pago');
      if (groupBy === 'deliveryMethod') parts.push('por Método de Entrega');
      if (groupBy === 'salesperson') parts.push('por Vendedor');
      if (groupBy === 'location') parts.push('por Sucursal');
      if (groupBy === 'status') parts.push('por Estado');
      if (groupBy === 'customer') parts.push('por Cliente');
      if (groupBy === 'date') parts.push('por Fecha');

      return `${parts.join(' ')}${dateLabel}`;
    }

    // For universalSearch
    if (toolName === 'universalSearch') {
      return `Resultados de Búsqueda: ${toolArgs?.query ?? ''}`;
    }

    // For getDatabaseOverview
    if (toolName === 'getDatabaseOverview') {
      return 'Panorama de Datos UNIK';
    }

    // For new module tools — build dynamic titles with filters
    if (toolName === 'queryPurchaseOrders') {
      const parts: string[] = ['Órdenes de Compra'];
      if (toolArgs?.vendor) parts.push(`de ${toolArgs.vendor}`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryBills') {
      const parts: string[] = ['Facturas de Compra'];
      if (toolArgs?.vendor) parts.push(`de ${toolArgs.vendor}`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryVendorCredits') {
      const parts: string[] = ['Créditos de Proveedor'];
      if (toolArgs?.vendor) parts.push(`de ${toolArgs.vendor}`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryPayments') {
      const parts: string[] = ['Pagos'];
      if (toolArgs?.customer) parts.push(`de ${toolArgs.customer}`);
      if (toolArgs?.paymentMode) parts.push(`en ${toolArgs.paymentMode}`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryInvoices') {
      const parts: string[] = ['Facturas'];
      if (toolArgs?.customer) parts.push(`de ${toolArgs.customer}`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryPackages') {
      const parts: string[] = ['Paquetes'];
      if (toolArgs?.customer) parts.push(`de ${toolArgs.customer}`);
      if (toolArgs?.carrier) parts.push(`(${toolArgs.carrier})`);
      if (toolArgs?.status) parts.push(`(${toolArgs.status})`);
      return `${parts.join(' ')}${dateLabel}`;
    }
    if (toolName === 'queryProducts') {
      const parts: string[] = ['Catálogo de Productos'];
      if (toolArgs?.category) parts.push(`— ${toolArgs.category}`);
      if (toolArgs?.brand) parts.push(`— ${toolArgs.brand}`);
      if (toolArgs?.lowStock) parts.push('(Stock Bajo)');
      return parts.join(' ');
    }
    if (toolName === 'queryContacts') {
      const parts: string[] = ['Contactos'];
      if (toolArgs?.contactType === 'customer') parts[0] = 'Clientes';
      else if (toolArgs?.contactType === 'vendor') parts[0] = 'Proveedores';
      return parts.join(' ');
    }

    // Static title map for other tools
    const titleMap: Record<string, string> = {
      getTopProducts: 'Productos Más Vendidos',
      getSalesTrend: 'Tendencia de Ventas',
      getTopCustomers: 'Top Clientes',
      getAccountsReceivable: 'Cuentas por Cobrar',
      getRevenueAnalysis: 'Análisis de Ingresos',
      getDailyRevenue: 'Ingresos Diarios',
      getSalesRanking: 'Ranking de Ventas',
      getSalesKPIs: 'KPIs de Ventas',
      getDashboardSummary: 'Resumen Ejecutivo',
      getProductCatalog: 'Catálogo de Productos',
      getLowStockAlerts: 'Alertas de Bajo Stock',
      getTeamPerformance: 'Rendimiento del Equipo',
      getSalesForecast: 'Pronóstico de Ventas',
      getSalesAlerts: 'Alertas de Ventas',
      getBalanceAging: 'Antigüedad de Saldos',
      getCustomerRetention: 'Retención de Clientes',
      getProductBundles: 'Productos Comprados Juntos',
    };
    return titleMap[toolName] ?? 'Reporte UNIK';
  }

  /** Parses the model's JSON args and injects surface ids, report rows/titles and chart params. */
  async function prepareArgs(tc: { id: string; name: string; arguments: string }): Promise<unknown> {
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(tc.arguments);
    } catch {
      parsedArgs = {};
    }
    if (!parsedArgs || typeof parsedArgs !== 'object') return parsedArgs;
    const argsObj = parsedArgs as Record<string, unknown>;
    // Inbox tools work on the INBOX conversation, never on this AI thread.
    if (inboxConversationId) {
      if ((INBOX_ONLY_TOOLS.has(tc.name) || INBOX_CONTEXT_TOOLS.has(tc.name)) && !argsObj.inboxConversationId) {
        argsObj.inboxConversationId = inboxConversationId;
      }
      if (INBOX_CONVERSATION_ID_TOOLS.has(tc.name) && !argsObj.conversationId) {
        argsObj.conversationId = inboxConversationId;
      }
    }
    // Chat tools work on the current internal-chat channel by default.
    if (chatChannelId) {
      if (CHAT_CHANNEL_ID_TOOLS.has(tc.name) && !argsObj.chatChannelId) {
        argsObj.chatChannelId = chatChannelId;
      }
      if (
        tc.name === 'sendInternalChatMessage' &&
        !argsObj.channelId &&
        !argsObj.recipient &&
        !argsObj.recipientUserId
      ) {
        argsObj.channelId = chatChannelId;
      }
    }
    if (!argsObj.conversationId) {
      argsObj.conversationId = input.conversationId;
    }

    // A revision of the last file: previous generator arguments under the new ones so
    // nothing the user did not mention changes (title, columns, colors, orientation…).
    const isRevisionOfLast = Boolean(revision && tc.name === revision.generatedBy);
    if (revision && isRevisionOfLast) {
      const merged = mergeRevisionArgs(revision.generatorArgs, argsObj);
      for (const k of Object.keys(argsObj)) delete argsObj[k];
      Object.assign(argsObj, merged);
    }

    // Auto-inject rows and title for artifact tools
    if (ARTIFACT_TOOLS.has(tc.name)) {
      // How the report should LOOK comes from the user's own words ("sin totales", "quita la
      // columna vendedor", "ordénalo por cliente", "en rojo"), with whatever the model passed
      // on top — except the amounts, which only the user can turn on (or already had in the
      // version being revised).
      argsObj.customization = resolveReportCustomization(
        input.message,
        argsObj.customization as ReportCustomization | undefined,
        isRevisionOfLast ? ((revision?.generatorArgs.customization as ReportCustomization | undefined) ?? null) : null
      );
      const modelRows = Array.isArray(argsObj.rows) ? (argsObj.rows as Record<string, unknown>[]) : null;
      const subsetOnly = argsObj.subsetOnly === true;
      let decision: ReportRowsDecision | null = null;
      if (!argsObj.sections && lastToolRows && lastToolRows.length > 0) {
        // The rows of a report ALWAYS come from the data tool, never from what the model
        // re-typed: hand-typed rows are (a) a partial page ("solo algunos renglones"), and
        // (b) already-formatted strings ("$1,797.00") that break totals ("$NaN").
        // Chat results are paginated (pageSize ≤ 200) so the model's context stays small,
        // but a report must contain EVERY matching row — re-run the data tool page by page
        // (never through the model) when the last result was only a partial page.
        const systemRows =
          subsetOnly && modelRows && modelRows.length > 0
            ? lastToolRows
            : await fetchAllRowsForExport(lastToolName, lastToolArgs, lastToolResult, lastToolRowKey, lastToolRows, input.actor);
        decision = resolveReportRows({
          modelRows,
          systemRows,
          expectedRows: lastToolResult ? declaredRowTotal(lastToolResult) : null,
          subsetOnly,
          exportCap: EXPORT_MAX_ROWS,
        });
        argsObj.rows = decision.rows;
        reportRowChecks.set(tc.id, decision);
        console.log(JSON.stringify({
          event: 'ai.report.rows',
          tool: tc.name,
          sourceTool: lastToolName,
          rowKey: lastToolRowKey,
          modelRows: modelRows?.length ?? null,
          included: decision.includedRows,
          expected: decision.expectedRows,
          source: decision.source,
          complete: decision.complete,
          blocked: Boolean(decision.blockReason),
        }));
        // The cover numbers must describe the table below them: computed from the data, never typed.
        if (decision.source === 'system' && decision.complete && lastToolResult) {
          const cards = buildSummaryCards(lastToolResult);
          if (cards.length > 0) argsObj.summaryCards = cards;
        }
      }
      if (!argsObj.subtitle && lastToolName === 'querySalesOrders') {
        argsObj.subtitle = buildReportSubtitle(lastToolArgs, lastToolResult);
      }
      if (decision && !decision.complete && !decision.blockReason) {
        // A report with fewer rows than the query is only allowed when it says so on its face.
        const label =
          decision.source === 'model'
            ? `SUBCONJUNTO: ${decision.includedRows} de ${decision.expectedRows} registros`
            : `REPORTE PARCIAL: ${decision.includedRows} de ${decision.expectedRows} registros (límite de exportación)`;
        argsObj.subtitle = [label, typeof argsObj.subtitle === 'string' ? argsObj.subtitle : ''].filter(Boolean).join('  ·  ');
      }
      // Auto-inject sections for PDF when the tool result has multiple arrays
      if (tc.name === 'generatePdfReport' && !argsObj.sections && !argsObj.rows && lastToolResult) {
        const allArrays = collectRowArrays(lastToolResult);
        if (Object.keys(allArrays).length > 1) {
          const sectionLabels: Record<string, string> = {
            byPaymentMethod: 'Por Método de Pago',
            byStatus: 'Por Estado',
            bySalesperson: 'Por Vendedor',
            byLocation: 'Por Sucursal',
            byDeliveryMethod: 'Por Método de Entrega',
            byCustomer: 'Por Cliente',
            byProduct: 'Por Producto',
            byDate: 'Por Fecha',
            orders: 'Órdenes',
            topProducts: 'Productos Más Vendidos',
            topCustomers: 'Top Clientes',
          };
          argsObj.sections = Object.entries(allArrays).map(([key, rows]) => ({
            title: sectionLabels[key] ?? key,
            rows,
          }));
          console.log(`[ai-orchestrator] Auto-injecting ${Object.keys(allArrays).length} sections from ${lastToolName} into ${tc.name}`);
        }
      }
      if (!argsObj.title && lastToolName) {
        // Build title dynamically based on tool name AND its arguments
        argsObj.title = buildDynamicTitle(lastToolName, lastToolArgs);
      }

      // Auto-inject summary cards from scalar fields in the last tool result
      if (!argsObj.summaryCards && lastToolResult) {
        const cards = buildSummaryCards(lastToolResult);
        if (cards.length > 0) {
          argsObj.summaryCards = cards;
        }
      }
    }

    // Auto-inject chart params for generateChart
    if (tc.name === 'generateChart' && lastToolRows && lastToolRows.length > 0) {
      if (!argsObj.title) {
        argsObj.title = buildDynamicTitle(lastToolName ?? '', lastToolArgs);
      }
      if (!argsObj.chartType) {
        argsObj.chartType = 'bar';
      }
      if (!argsObj.labels && lastToolRows.length > 0) {
        // Use 'customer' or 'number' or first string field as labels
        const firstRow = lastToolRows[0];
        let labelKey = 'customer';
        if (!('customer' in firstRow)) {
          // Find first string field
          for (const k of Object.keys(firstRow)) {
            if (typeof firstRow[k] === 'string' && k !== 'date' && k !== 'status') {
              labelKey = k;
              break;
            }
          }
        }
        argsObj.labels = lastToolRows.map((r) => String(r[labelKey] ?? '').slice(0, 30));
      }
      if (!argsObj.series && lastToolRows.length > 0) {
        // Use 'total' or first numeric field as values
        const firstRow = lastToolRows[0];
        let valueKey = 'total';
        if (!('total' in firstRow)) {
          for (const k of Object.keys(firstRow)) {
            const v = firstRow[k];
            if (typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)) && v !== '')) {
              valueKey = k;
              break;
            }
          }
        }
        const values = lastToolRows.map((r) => Number(r[valueKey] ?? 0));
        argsObj.series = [{ label: argsObj.title as string, values }];
      }
    }
    return parsedArgs;
  }

  /**
   * `loadMoreTools` is resolved here (not in the registry): the matching tools
   * are added to the tools offered in the next model call, within the API limit.
   */
  function loadMoreTools(parsedArgs: unknown): ToolExecutionResult {
    const topic = String((parsedArgs as { topic?: unknown } | null)?.topic ?? '').trim();
    const offeredNames = new Set(offeredTools.map((t) => t.name));
    const matches = findToolsByTopic(availableTools, topic, 30);
    const added = matches.filter((t) => !offeredNames.has(t.name));
    if (added.length > 0) {
      let next = [...offeredTools, ...added];
      if (next.length > PROVIDER_MAX_TOOLS) {
        const keep = new Set<string>([...CORE_TOOL_NAMES, ...pinnedTools, ...recentToolNames, ...toolsUsedThisTurn.map((t) => t.name), ...added.map((t) => t.name)]);
        const removable = next.filter((t) => !keep.has(t.name)).map((t) => t.name);
        const drop = new Set(removable.slice(Math.max(0, removable.length - (next.length - PROVIDER_MAX_TOOLS))));
        next = next.filter((t) => !drop.has(t.name));
      }
      offeredTools = next;
      toolSpecs = toOpenAiTools(offeredTools);
      turnStats.loadedMore += added.length;
    }
    return {
      success: true,
      durationMs: 0,
      result: {
        topic,
        added: added.map((t) => ({ name: t.name, description: t.description.slice(0, 220), effect: t.effect ?? 'read' })),
        alreadyAvailable: matches.filter((t) => offeredNames.has(t.name)).map((t) => t.name),
        note:
          matches.length === 0
            ? 'Ninguna herramienta coincide con ese tema. Revisa si el usuario tiene permiso o si el tema está mal escrito.'
            : 'Estas herramientas ya están disponibles en tu siguiente paso: llámalas directamente.',
      },
    };
  }

  /** Read-only tools with no dependency on each other can run at the same time. */
  function isParallelizable(name: string): boolean {
    if (name === 'loadMoreTools' || name === 'proposePlan') return false;
    if (ARTIFACT_TOOLS.has(name) || ARTIFACT_TOOL_NAMES.has(name) || name === 'generateChart') return false;
    const def = availableByName.get(name);
    if (!def) return false;
    return (def.effect ?? 'read') === 'read';
  }

  const execCtx = (assistantMessageId: string) => ({
    conversationId: input.conversationId,
    messageId: assistantMessageId,
    enabledToolNames: settings.enabledTools,
    skipCache: wantsFreshData,
    attachmentOrderNumbers: attachmentOrderNumbers.length > 0 ? attachmentOrderNumbers : undefined,
  });

  async function runTool(tc: { id: string; name: string; arguments: string }, parsedArgs: unknown, assistantMessageId: string): Promise<ToolExecutionResult> {
    if (tc.name === 'loadMoreTools') return loadMoreTools(parsedArgs);
    const blockReason = reportRowChecks.get(tc.id)?.blockReason;
    if (blockReason) {
      return { success: false, error: blockReason, errorCode: 'incomplete_report_rows', durationMs: 0 };
    }
    try {
      return await executeTool(tc.name, input.actor, parsedArgs, execCtx(assistantMessageId));
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Error desconocido', errorCode: 'error', durationMs: 0 };
    }
  }

  /** Everything that happens after a tool ran: events, provenance, audit, context, persistence. */
  async function* finalizeToolCall(
    tc: { id: string; name: string; arguments: string },
    parsedArgs: unknown,
    result: ToolExecutionResult,
    assistantMessageId: string
  ): AsyncGenerator<OrchestratorEvent> {
    turnStats.calls += 1;
    if (result.cached) turnStats.cachedHits += 1;
    if (!result.success && !result.needsApproval) turnStats.failed += 1;
    toolsUsedThisTurn.push({ name: tc.name, success: result.success, cached: result.cached });

    // Agent Workspace feed — the third column mirrors what the agent does.
    // Fire-and-forget: the feed never delays or breaks the answer.
    const wsEvents = workspaceEventsForTool(tc.name, parsedArgs, result);
    emitWorkspaceEvents(input.conversationId, wsEvents);
    for (const ev of wsEvents) {
      if (ev.type === 'pages') {
        for (const p of (ev.payload.pages as Array<{ url?: string }> | undefined) ?? []) {
          if (p.url) turnSources.push(p.url);
        }
      } else if (ev.type === 'browser' || ev.type === 'screen') {
        const u = ev.payload.url as string | undefined;
        if (u) turnSources.push(u);
      } else if (ev.type === 'artifact') {
        const t = (ev.payload.title ?? ev.payload.fileName) as string | undefined;
        if (t) turnArtifacts.push(t);
      }
    }

    // Side-effecting action: a proposal was created and the user must approve it.
    // The model receives an explicit tool result so it asks for confirmation instead
    // of claiming the action happened.
    if (result.needsApproval && result.proposal) {
      yield {
        type: 'proposal',
        data: {
          id: result.proposal.id,
          toolName: result.proposal.toolName,
          summary: result.proposal.summary,
          effect: result.proposal.effect,
          expiresAt: result.proposal.expiresAt,
          args: parsedArgs,
        },
      };
    }

    if (result.success && result.result) {
      collectFolios(result.result, knownFolios);
      collectResultNumbers(result.result, knownTotals.counts, knownTotals.money);
    }

    // Track the last DATA tool result for auto-injection into artifact tools
    if (
      result.success &&
      result.result &&
      typeof result.result === 'object' &&
      !ARTIFACT_TOOL_NAMES.has(tc.name) &&
      tc.name !== 'loadMoreTools' &&
      tc.name !== 'proposePlan' &&
      !(result.result as Record<string, unknown>).error
    ) {
      const toolResult = result.result as Record<string, unknown>;
      // Use the RECORDS array as the default rows (never a breakdown that happens to come first);
      // preserve the COMPLETE result for multi-section PDF injection and KPI cards.
      const primary = pickPrimaryRowArray(toolResult);
      if (primary) {
        lastToolResult = toolResult;
        lastToolRows = primary.rows;
        lastToolRowKey = primary.key;
        lastToolName = tc.name;
        lastToolArgs = (parsedArgs as Record<string, unknown>) ?? null;
      }
      if (availableByName.get(tc.name)?.category !== 'system') turnStats.dataToolsSucceeded += 1;
    }

    // If the tool generated one or more artifacts, emit an artifact event per artifact.
    // (generateReportImage returns MULTIPLE artifacts — "Parte 1 de 3", "Parte 2 de 3"...—
    // when the data doesn't fit in a single image, instead of silently truncating.)
    if (result.success && result.result && typeof result.result === 'object') {
      const toolResult = result.result as Record<string, unknown>;
      const artifactList = Array.isArray(toolResult.artifacts)
        ? (toolResult.artifacts as Array<Record<string, unknown>>)
        : toolResult.artifactId && toolResult.type
          ? [toolResult]
          : [];
      if (artifactList.length > 0) {
        // Persist provenance so a later "cámbiale X al reporte" can rebuild it, and
        // attach the artifacts to this assistant message so they render forever.
        const generatorArgs = { ...((parsedArgs as Record<string, unknown>) ?? {}) };
        delete generatorArgs.rows;
        delete generatorArgs.sections;
        if (generatorArgs.blocks && JSON.stringify(generatorArgs.blocks).length > 200_000) delete generatorArgs.blocks;
        const spec = {
          generatedBy: tc.name,
          generatorArgs,
          sourceTool: lastToolName,
          sourceArgs: lastToolArgs,
          generatedAt: new Date().toISOString(),
        };
        for (const a of artifactList) {
          if (typeof a.artifactId !== 'string') continue;
          await linkArtifactToMessage(a.artifactId, assistantMessageId, spec);
        }
        // Same document, next version: the new file carries the version number and the old
        // card says it was replaced. The model is told so it presents it as a revision.
        if (revision && tc.name === revision.generatedBy && artifactList.length > 0) {
          const nextVersion = revision.version + 1;
          try {
            for (const a of artifactList) {
              if (typeof a.artifactId !== 'string') continue;
              const row = await prisma.aiArtifact.findUnique({ where: { id: a.artifactId }, select: { meta: true } });
              const meta = { ...((row?.meta as Record<string, unknown> | null) ?? {}), version: nextVersion, revisionOf: revision.artifactId };
              await prisma.aiArtifact.update({ where: { id: a.artifactId }, data: { meta: meta as Prisma.InputJsonValue } });
              a.version = nextVersion;
            }
            const prev = await prisma.aiArtifact.findUnique({ where: { id: revision.artifactId }, select: { meta: true } });
            const prevMeta = { ...((prev?.meta as Record<string, unknown> | null) ?? {}), supersededBy: String(artifactList[0].artifactId) };
            await prisma.aiArtifact.update({ where: { id: revision.artifactId }, data: { meta: prevMeta as Prisma.InputJsonValue } });
            // `toolResult` is the same object the tool message is built from below.
            toolResult.revision = {
              version: nextVersion,
              replaces: revision.artifactId,
              note: `Es la versión ${nextVersion} de "${revision.title}" con los cambios pedidos; preséntala así (qué cambió), no como un archivo nuevo.`,
            };
          } catch (err) {
            console.warn('[orchestrator] revision versioning failed:', err instanceof Error ? err.message : err);
          }
        }
      }
      for (const a of artifactList) {
        yield {
          type: 'artifact',
          data: {
            artifactId: a.artifactId,
            type: a.type,
            title: a.title,
            filename: a.filename,
            downloadUrl: typeof a.downloadUrl === 'string' ? absoluteUrl(a.downloadUrl) : a.downloadUrl,
            inlineRender: a.inlineRender,
            rowCount: a.rowCount,
            sizeBytes: a.sizeBytes,
            pageCount: a.pageCount,
            chartType: a.chartType,
            storageObjectId: typeof a.storageObjectId === 'string' ? a.storageObjectId : undefined,
            mimeType: typeof a.mimeType === 'string' ? a.mimeType : undefined,
            quoteId: typeof a.quoteId === 'string' ? a.quoteId : undefined,
            version: typeof a.version === 'number' ? a.version : undefined,
          },
        };
      }
    }

    // Generative UI: results of external tools (Composio, MCP) become visual components in the chat.
    // Specs are plain data built by a fixed, defensive mapper (never markup from the model or a server).
    if (result.success && result.result) {
      try {
        const components = buildUiComponents({ toolName: tc.name, args: parsedArgs, result: result.result, success: true });
        if (components.length > 0) {
          yield { type: 'ui', data: { toolCallId: tc.id, toolName: tc.name, components } };
        }
      } catch (err) {
        console.warn('[orchestrator] generative ui skipped:', err instanceof Error ? err.message : err);
      }
    }

    // UI actions: a phone call joins the floating call dock; an internal call opens the chat.
    if (result.success && UI_ACTION_TOOLS.has(tc.name) && result.result && typeof result.result === 'object') {
      const r = result.result as Record<string, unknown>;
      if (typeof r.callId === 'string' && !r.error) {
        yield { type: 'action', data: { kind: 'join_call', callId: r.callId, label: (r.to as string | undefined) ?? (r.phone as string | undefined) ?? null, aiCall: r.mode === 'ai' } };
      } else if (typeof r.openUrl === 'string' && !r.error) {
        yield { type: 'action', data: { kind: 'open_url', url: r.openUrl, reason: 'internal_call' } };
      }
    }

    // Audit tool call
    await recordAiToolCall({
      messageId: assistantMessageId,
      toolName: tc.name,
      args: parsedArgs,
      result: result.result,
      durationMs: result.durationMs,
      success: result.success,
      errorCode: result.needsApproval ? 'needs_approval' : (result.errorCode ?? result.error),
    });

    // Add result to context
    const toolPayload = result.success
      ? result.cached && result.result && typeof result.result === 'object' && !Array.isArray(result.result)
        ? { ...(result.result as Record<string, unknown>), cached: true, cachedAt: result.cachedAt }
        : result.result
      : result.needsApproval && result.proposal
        ? {
            needsApproval: true,
            proposalId: result.proposal.id,
            summary: result.proposal.summary,
            effect: result.proposal.effect,
            instruction:
              'NO afirmes que la acción se realizó. Explica al usuario qué se hará exactamente y pídele que apruebe la propuesta en la tarjeta mostrada.',
          }
        : { error: result.error, ...(result.uncertain ? { uncertain: true } : {}) };
    if (result.success && toolPayload && typeof toolPayload === 'object' && !Array.isArray(toolPayload) && Array.isArray((toolPayload as { uiResources?: unknown }).uiResources)) {
      // The interactive component is for the user; the model only needs to know it was shown.
      (toolPayload as Record<string, unknown>).uiResources = ((toolPayload as { uiResources: Array<{ uri?: string }> }).uiResources).map((r) => ({
        uri: r?.uri,
        note: 'Mostrado al usuario como componente interactivo en el chat.',
      }));
    }
    const rowCheck = reportRowChecks.get(tc.id);
    if (rowCheck && result.success && toolPayload && typeof toolPayload === 'object' && !Array.isArray(toolPayload)) {
      const { includedRows: n, expectedRows: expected } = rowCheck;
      (toolPayload as Record<string, unknown>).dataCompleteness = {
        includedRows: n,
        expectedRows: expected,
        complete: rowCheck.complete,
        note: rowCheck.complete
          ? `El archivo contiene ${n} filas${expected !== null ? `, todas las de la consulta (${expected})` : ''}. Di ese número al entregarlo.`
          : rowCheck.source === 'model'
            ? `El archivo contiene SOLO ${n} de ${expected} filas porque usaste subsetOnly. Díselo al usuario con esos números; nunca lo presentes como el reporte completo.`
            : `El archivo contiene SOLO ${n} de ${expected} filas (límite de exportación). Díselo al usuario con esos números y ofrece dividir por periodo o filtro.`,
      };
    }
    // Untrusted tools (web/browser/venue): secrets are scrubbed from the payload and
    // the content is wrapped so the model reads it as DATA, never as instructions.
    const toolTrust = availableByName.get(tc.name)?.resultTrust ?? 'trusted';
    const safePayload = toolTrust === 'untrusted' ? redactDeep(toolPayload) : toolPayload;
    const serializedPayload = JSON.stringify(safePayload);
    messages.push({
      role: 'tool',
      content: toolTrust === 'untrusted' ? wrapUntrusted(serializedPayload, tc.name) : serializedPayload,
      tool_call_id: tc.id,
    });

    // Persist tool message
    await addMessage(
      input.conversationId,
      'tool',
      JSON.stringify(toolPayload),
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
        needsApproval: Boolean(result.needsApproval),
        errorCode: result.errorCode ?? null,
        error: !result.success && !result.needsApproval ? (result.error ?? null) : null,
        durationMs: result.durationMs,
        cached: Boolean(result.cached),
      },
    };
  }

  while (iteration < settings.maxToolIterations) {
    iteration++;

    let iterationContent = '';
    let iterationToolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    let finishReason: string | undefined;

    const modelToUse = usingFallback ? fallbackModel : escalatedModel ?? effectiveModel;
    // Copilot auto-analysis (open / inbound): the first call MUST produce the clickable
    // action chips instead of prose, so the user only clicks.
    const forceActions =
      iteration === 1 &&
      isAutoTrigger &&
      !input.message.startsWith('⟦auto:action_failed') &&
      Boolean(inboxConversationId || chatChannelId) &&
      offeredTools.some((t) => t.name === 'suggestNextActions');

    // Buffered turns show a chip while the answer is being written instead of a blank wait.
    const draftStartedAt = Date.now();
    if (bufferAnswer) yield { type: 'tool_call_start', data: { name: 'draftAnswer', args: '{}' } };
    let draftChipClosed = false;
    const closeDraftChip = function* (): Generator<OrchestratorEvent> {
      if (!bufferAnswer || draftChipClosed) return;
      draftChipClosed = true;
      yield { type: 'tool_call_end', data: { name: 'draftAnswer', success: true, needsApproval: false, errorCode: null, error: null, durationMs: Date.now() - draftStartedAt, cached: false } };
    };
    try {
      for await (const chunk of chatCompletionStream({
        messages,
        tools: toolSpecs.length > 0 ? toolSpecs : undefined,
        toolChoice: forceActions ? { type: 'function', function: { name: 'suggestNextActions' } } : undefined,
        temperature: settings.temperature,
        maxTokens: resolveTurnMaxTokens(modelToUse),
        reasoningEffort: turnReasoningEffort,
        userId: input.actor.id,
        conversationId: input.conversationId,
        model: modelToUse,
      })) {
        if (chunk.delta) {
          iterationContent += chunk.delta;
          if (!bufferAnswer) yield { type: 'token', data: { delta: chunk.delta } };
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
      yield* closeDraftChip();
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

    yield* closeDraftChip();

    // If no tool calls, we're done
    if (!iterationToolCalls || iterationToolCalls.length === 0 || finishReason === 'stop') {
      iterationContent = stripMarkdownImages(iterationContent);

      // "Un momento, voy a generar…" is not an answer. Send the model back to finish the work
      // (once) instead of delivering a promise.
      if (nudges < 1 && iteration < settings.maxToolIterations && looksUnfinished(iterationContent)) {
        nudges += 1;
        console.log(JSON.stringify({ event: 'ai.answer.unfinished', conversationId: input.conversationId, iteration }));
        messages.push({ role: 'assistant', content: iterationContent });
        messages.push({
          role: 'system',
          content:
            'Revisión interna: tu respuesta se detuvo prometiendo trabajo ("un momento", "voy a…"). El usuario no ve mensajes parciales. Ejecuta ahora las tools que faltan y entrega el resultado COMPLETO en esta misma respuesta, sin volver a prometer.',
        });
        if (bufferAnswer) {
          yield { type: 'tool_call_start', data: { name: 'reviewAnswer', args: '{}' } };
          yield { type: 'tool_call_end', data: { name: 'reviewAnswer', success: true, needsApproval: false, errorCode: null, error: null, durationMs: 0, cached: false } };
        }
        continue;
      }

      // Deterministic verification (every model, every tier): folios that no tool
      // returned, count-vs-table mismatches, numeric claims with no total behind
      // them, source claims whose tools never ran, and "voy a…" promises with zero
      // actions. One corrective pass, max two.
      if (nudges < 2 && iteration < settings.maxToolIterations) {
        const check = checkAnswer(iterationContent, knownFolios, knownTotals, toolsUsedThisTurn);
        if (check.issues.length > 0) {
          nudges += 1;
          if (classification.tier === 'standard') escalateModel();
          console.log(JSON.stringify({ event: 'ai.answer.checks', conversationId: input.conversationId, issues: check.issues }));
          yield { type: 'tool_call_start', data: { name: 'reviewAnswer', args: '{}' } };
          yield { type: 'tool_call_end', data: { name: 'reviewAnswer', success: true, needsApproval: false, errorCode: null, error: null, durationMs: 0, cached: false } };
          messages.push({ role: 'assistant', content: iterationContent });
          messages.push({
            role: 'system',
            content:
              'Verificación automática de tu borrador (el usuario NO lo vio). Corrige y entrega la respuesta final completa:\n' +
              check.issues.map((i, n) => `${n + 1}. ${i}`).join('\n'),
          });
          continue;
        }
      }

      // Mid-turn escalation on standard turns: the deterministic checks passed, so
      // Jev scores how trustworthy the draft is; a low score reruns the final
      // answer once on the complex-tier model. Only drafts that can be wrong in a
      // way the user would notice — they cite numbers — are scored.
      if (
        escalatedModel === null &&
        routing.routed &&
        classification.tier === 'standard' &&
        !isAutoTrigger &&
        nudges < 2 &&
        iteration < settings.maxToolIterations &&
        iterationContent.trim().length >= 60 &&
        /\d/.test(iterationContent) &&
        toolsUsedThisTurn.length > 0
      ) {
        const gate = draftConfidenceDecision({
          userMessage: input.message,
          draft: iterationContent,
          toolsUsed: toolsUsedThisTurn.map((t) => t.name),
        });
        const score = await decide(gate.state, gate.questions, {
          userId: input.actor.id,
          conversationId: input.conversationId,
        })
          .then((r) => answerScore(r, 'confidence', 5))
          .catch(() => null);
        if (score !== null && score <= 0.5 && escalateModel()) {
          nudges += 1;
          console.log(JSON.stringify({ event: 'ai.answer.low_confidence', conversationId: input.conversationId, score }));
          messages.push({ role: 'assistant', content: iterationContent });
          messages.push({
            role: 'system',
            content:
              'Tu borrador anterior no pasó la evaluación de confianza (el usuario NO lo vio). Rehaz la respuesta: verifica cada cifra contra los resultados de tus tools, no afirmes nada que no puedas respaldar, y entrega la respuesta final completa.',
          });
          continue;
        }
      }

      // Internal review of complex answers: a second pass looks for missing parts, numbers
      // that do not add up and cut tables; the model rewrites once with the critique.
      // Jev gates the expensive pass: a confident "no" skips the LLM review entirely.
      if (bufferAnswer && reviews < 1 && iteration < settings.maxToolIterations && iterationContent.trim().length >= 80) {
        const reviewGate = reviewNeededDecision({
          userMessage: input.message,
          draft: iterationContent,
          toolsUsed: toolsUsedThisTurn.map((t) => t.name),
        });
        const needsReview = await decide(reviewGate.state, reviewGate.questions, {
          userId: input.actor.id,
          conversationId: input.conversationId,
        })
          .then((r) => answerBool(r, 'needs_review'))
          .catch(() => null);
        if (needsReview === false) {
          console.log(JSON.stringify({ event: 'ai.answer.review_skipped', conversationId: input.conversationId, by: 'jev' }));
        }
        if (needsReview !== false) {
        reviews += 1;
        const reviewStart = Date.now();
        yield { type: 'tool_call_start', data: { name: 'reviewAnswer', args: '{}' } };
        let verdict: Awaited<ReturnType<typeof reviewComplexAnswer>> = null;
        try {
          verdict = await reviewComplexAnswer(settings, {
            userMessage: input.message,
            answer: iterationContent,
            toolsUsed: toolsUsedThisTurn,
            hadAttachments: attachmentsForContext.length > 0,
            documentGenerated: toolsUsedThisTurn.some((t) => t.name === 'composeDocument' && t.success),
          });
        } catch (err) {
          console.warn('[ai-orchestrator] answer review failed:', err instanceof Error ? err.message : err);
        }
        yield {
          type: 'tool_call_end',
          data: { name: 'reviewAnswer', success: true, needsApproval: false, errorCode: null, error: null, durationMs: Date.now() - reviewStart, cached: false },
        };
        console.log(JSON.stringify({ event: 'ai.answer.review', conversationId: input.conversationId, approved: verdict?.approved ?? null, issues: verdict?.issues ?? [] }));
        if (verdict && !verdict.approved && verdict.issues.length > 0) {
          messages.push({ role: 'assistant', content: iterationContent });
          messages.push({
            role: 'system',
            content:
              'Revisión interna de tu borrador (el usuario NO lo vio). Corrige estos puntos y entrega la respuesta final completa — vuelve a llamar tools si hace falta para verificar:\n' +
              verdict.issues.map((i, n) => `${n + 1}. ${i}`).join('\n'),
          });
          continue;
        }
        }
      }

      if (bufferAnswer && iterationContent) yield { type: 'token', data: { delta: iterationContent } };

      // Validate output for potential leaked secrets
      const outputValidation = validateOutput(iterationContent);
      if (!outputValidation.valid && (outputValidation.warnings?.length ?? 0) > 0) {
        // Log warnings but don't block the response — the guardrail is heuristic
        console.warn('[ai-orchestrator] Output validation warnings:', outputValidation.warnings);
      }
      const finalMessage = await addMessage(
        input.conversationId,
        'assistant',
        iterationContent,
        null,
        totalPromptTokens,
        totalCompletionTokens,
        0
      );

      // Confidence label (the model writes it; if it forgot, derive it from what happened).
      const parsedConfidence = parseConfidence(iterationContent);
      // One-click follow-ups ("Sugerencias: [..] · [..]") written by the model, shown as chips.
      const followUps = parseFollowUps(parsedConfidence.content).followUps;
      const confidence = inferConfidence({
        parsed: parsedConfidence.level,
        dataToolsSucceeded: turnStats.dataToolsSucceeded,
        toolsFailed: turnStats.failed,
        hasNumbers: /\d/.test(iterationContent),
      });
      const meta = {
        model: modelToUse,
        routing: { tier: routing.tier, reason: routing.reason, routed: routing.routed },
        confidence,
        confidenceNote: parsedConfidence.note,
        // The badge's source list is derived HERE from tools that actually ran —
        // the model's self-reported note can claim sources that never executed.
        sourcesLabel: describeSourcesUsed(toolsUsedThisTurn.map((t) => t.name)),
        confidenceLabeled: parsedConfidence.level !== null,
        tools: { ...turnStats, offered: offeredTools.length, used: toolsUsedThisTurn.map((t) => t.name) },
        planFirst: Boolean(input.planFirst),
        followUps,
      };
      await mergeMessageMeta(finalMessage.id, meta);

      // Controlled learning: a correction or a business definition in the user's message
      // becomes a PENDING memory the user confirms (never blocks the answer).
      if (settings.learningCaptureEnabled !== false && !isAutoTrigger && !input.context?.voice) {
        void captureLearnings(settings, {
          userId: input.actor.id,
          userMessage: input.message,
          lastAssistantContent,
          answer: iterationContent,
        }).catch((err) => console.warn('[ai-orchestrator] learning capture failed:', err instanceof Error ? err.message : err));
      }

      // Agent memory write (never blocks): Jev gates, the utility model distills the
      // episode + facts + playbook of the turn into the three-layer memory.
      if (actorPreferences?.memoryEnabled !== false && !input.context?.voice) {
        void import('@/modules/memory/memory-extract')
          .then((m) =>
            m.extractAndStoreMemory(settings, {
              userId: input.actor.id,
              conversationId: input.conversationId,
              userMessage: input.message,
              answer: iterationContent,
              toolsUsed: toolsUsedThisTurn.map((t) => t.name),
              sourceUrls: [...new Set(turnSources)].slice(0, 15),
              artifacts: turnArtifacts.slice(0, 10),
            })
          )
          .catch((err) => console.warn('[ai-orchestrator] memory extract failed:', err instanceof Error ? err.message : err));
      }

      // Shared context: refresh this thread's rolling summary (never blocks the answer).
      void maybeSummarizeConversation(input.conversationId, input.actor.id);
      // Optional automatic quality evaluation (admin setting) — after the answer, never blocking.
      if (settings.qualityJudgeEnabled && !isAutoTrigger) {
        void judgeTurnQuality({
          messageId: finalMessage.id,
          userMessage: input.message,
          answer: iterationContent,
          toolsUsed: toolsUsedThisTurn,
          confidence,
        }).catch((err) => console.warn('[ai-orchestrator] judge failed:', err instanceof Error ? err.message : err));
      }
      // Long turns notify their owner (phone push + bell) so they can come back to the answer.
      if (!isAutoTrigger) {
        void notifyAiTaskDone({
          userId: input.actor.id,
          conversationId: input.conversationId,
          messageId: finalMessage.id,
          content: iterationContent,
          elapsedMs: Date.now() - runStartedAt,
          toolCalls: turnStats.calls,
          surface: { inboxConversationId, chatChannelId },
          force: Boolean(input.notifyWhenDone),
        }).catch((err) => console.warn('[ai-orchestrator] notify failed:', err instanceof Error ? err.message : err));
      }
      yield {
        type: 'done',
        data: {
          content: iterationContent,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          messageId: finalMessage.id,
          model: modelToUse,
          routed: routing.routed,
          tier: routing.tier,
          confidence,
          confidenceNote: parsedConfidence.note,
          sourcesLabel: describeSourcesUsed(toolsUsedThisTurn.map((t) => t.name)),
          tools: { calls: turnStats.calls, cachedHits: turnStats.cachedHits, parallelBatches: turnStats.parallelBatches },
        },
      };
      return;
    }

    // Text the model wrote before calling tools is shown as it was (usually one line).
    if (bufferAnswer && iterationContent.trim()) yield { type: 'token', data: { delta: iterationContent } };

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

    // Execute the tool calls: independent READ tools run concurrently (results are
    // finalized in the model's order); artifact, planning and side-effecting tools run
    // one by one because they depend on previous results or create approval proposals.
    let idx = 0;
    while (idx < iterationToolCalls.length) {
      const tc = iterationToolCalls[idx];
      if (!isParallelizable(tc.name)) {
        yield { type: 'tool_call_start', data: { name: tc.name, args: tc.arguments } };
        const parsedArgs = await prepareArgs(tc);
        const result = await runTool(tc, parsedArgs, assistantMessage.id);
        yield* finalizeToolCall(tc, parsedArgs, result, assistantMessage.id);
        idx += 1;
        continue;
      }
      const batch: Array<{ tc: { id: string; name: string; arguments: string }; parsedArgs: unknown }> = [];
      while (idx < iterationToolCalls.length && isParallelizable(iterationToolCalls[idx].name)) {
        const call = iterationToolCalls[idx];
        yield { type: 'tool_call_start', data: { name: call.name, args: call.arguments } };
        batch.push({ tc: call, parsedArgs: await prepareArgs(call) });
        idx += 1;
      }
      if (batch.length > 1) turnStats.parallelBatches += 1;
      const results = await Promise.all(batch.map((b) => runTool(b.tc, b.parsedArgs, assistantMessage.id)));
      for (let k = 0; k < batch.length; k++) {
        yield* finalizeToolCall(batch[k].tc, batch[k].parsedArgs, results[k], assistantMessage.id);
      }
    }

    // Loop: call the active provider again with tool results
  }

  // Reached iteration limit
  yield {
    type: 'error',
    data: { message: 'El asistente alcanzó el límite de iteraciones de tools.' },
  };
}

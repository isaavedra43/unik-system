'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  actionFailedMessage,
  performUiAction,
  uiActionFromResult,
  type UiAction,
} from '@/components/copilot/copilot-types';
import type { UiComponent } from '@/modules/ai/generative-ui/types';
import type {
  ArtifactInfo,
  AttachmentInfo,
  LiveToolCall,
  MessageData,
  ProposalExecution,
  ProposalInfo,
  WorkspaceTab,
} from '../lib/types';
import { workspaceTabForTool } from '../lib/agents';
import { useRealtime } from '../lib/realtime';

/**
 * The conversation engine of UNIVERSO: loads a thread, sends a turn over the
 * SSE endpoint and turns every event (tokens, reasoning, tool calls, cards,
 * files, approvals, UI actions) into state. A dropped stream never loses the
 * answer: the run keeps going on the server and we wait for it to persist.
 */

export interface ChatError {
  text: string;
  /** Informational (still waiting for the server) instead of a failure. */
  info?: boolean;
  /** The last message can be re-sent. */
  retry?: boolean;
}

export interface LiveTurn {
  content: string;
  reasoning: string;
  tools: LiveToolCall[];
  ui: UiComponent[];
  artifacts: ArtifactInfo[];
  startedAt: number;
  /** Model the router picked (from the routing/done events) — informative. */
  route?: { tier?: string; model?: string } | null;
}

export interface SendOptions {
  attachments?: AttachmentInfo[];
  planFirst?: boolean;
  /** Hide the user bubble (auto events like "the approved action failed"). */
  silent?: boolean;
}

export interface UseChatStreamInput {
  conversationId: string | null;
  onConversationCreated?: (id: string) => void;
  /** Real agent id (the 'principal' sentinel is never sent). */
  agentId?: string | null;
  model?: string | null;
  context?: { page?: string };
  onWorkspaceHint?: (tab: WorkspaceTab) => void;
}

const EMPTY_LIVE: LiveTurn = {
  content: '',
  reasoning: '',
  tools: [],
  ui: [],
  artifacts: [],
  startedAt: 0,
  route: null,
};

function toMessage(m: Record<string, unknown>): MessageData {
  return {
    id: String(m.id),
    role: m.role as MessageData['role'],
    content: (m.content as string | null) ?? null,
    toolCalls: m.toolCalls as MessageData['toolCalls'],
    toolCallRecords: m.toolCallRecords as MessageData['toolCallRecords'],
    attachments: m.attachments as MessageData['attachments'],
    artifacts: m.artifacts as MessageData['artifacts'],
    meta: (m.meta as MessageData['meta']) ?? null,
    feedback: (m.feedback as MessageData['feedback']) ?? null,
    createdAt: String(m.createdAt),
  };
}

function argsOf(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function useChatStream(input: UseChatStreamInput) {
  const [conversationId, setConversationId] = useState<string | null>(input.conversationId);
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<LiveTurn>(EMPTY_LIVE);
  const [proposals, setProposals] = useState<ProposalInfo[]>([]);
  const [error, setError] = useState<ChatError | null>(null);
  /** The director is reviewing the team's deliveries (agent.consolidating). */
  const [consolidating, setConsolidating] = useState(false);
  /** Title and owner agent of the open thread. */
  const [thread, setThread] = useState<{ title: string | null; agentId: string | null } | null>(
    null
  );
  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const lastSendRef = useRef<{ text: string; opts: SendOptions } | null>(null);
  const streamingRef = useRef(false);
  const pendingReloadRef = useRef(false);
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });

  // The parent owns the selected thread; creating one here reports it back.
  useEffect(() => {
    setConversationId(input.conversationId);
  }, [input.conversationId]);

  const loadConversation = useCallback(async (id: string, opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoading(true);
    try {
      const res = await fetch(`/app/assistant/api/conversations/${id}`);
      if (!res.ok) {
        if (!opts.quiet) {
          setError({
            text:
              res.status === 404
                ? 'Esta conversación ya no existe.'
                : 'No se pudo cargar la conversación.',
          });
          setMessages([]);
        }
        return;
      }
      const data = (await res.json()) as {
        messages?: Array<Record<string, unknown>>;
        conversation?: { title?: string | null; agentId?: string | null } | null;
      };
      setMessages((data.messages ?? []).map(toMessage));
      setThread({
        title: data.conversation?.title ?? null,
        agentId: data.conversation?.agentId ?? null,
      });
      // Pending approvals survive reloads.
      fetch(`/app/assistant/api/proposals?conversationId=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : { proposals: [] }))
        .then((p: { proposals?: ProposalInfo[] }) => setProposals(p.proposals ?? []))
        .catch(() => undefined);
    } catch {
      if (!opts.quiet) setError({ text: 'No se pudo cargar la conversación.' });
    } finally {
      if (!opts.quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setError(null);
    setConsolidating(false);
    if (conversationId) {
      // A thread we just created is empty on the server: keep the optimistic bubble.
      if (!streamingRef.current) void loadConversation(conversationId);
    } else {
      setMessages([]);
      setProposals([]);
      setLive(EMPTY_LIVE);
      setThread(null);
    }
  }, [conversationId, loadConversation]);

  // Team events for this thread: a delegated task reported, or the director
  // started consolidating → refresh the thread (after the current stream).
  useRealtime(
    [conversationId ? `assistant:${conversationId}` : null],
    ['agent.message', 'agent.consolidating'],
    (type) => {
      if (type === 'agent.consolidating') setConsolidating(true);
      if (type === 'agent.message') setConsolidating(false);
      if (streamingRef.current) {
        pendingReloadRef.current = true;
        return;
      }
      const id = conversationId;
      if (id) void loadConversation(id, { quiet: true });
    }
  );

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    if (conversationId) return conversationId;
    try {
      const res = await fetch('/app/assistant/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !d.id) throw new Error(d.error ?? 'fail');
      const id = d.id;
      setConversationId(id);
      inputRef.current.onConversationCreated?.(id);
      return id;
    } catch {
      setError({ text: 'No se pudo crear la conversación.', retry: false });
      return null;
    }
  }, [conversationId]);

  /** Polls until an assistant answer newer than `sinceIso` exists (≤ 15 min). */
  const waitForPersistedAnswer = useCallback(
    async (convId: string, sinceIso: string): Promise<boolean> => {
      const since = Date.parse(sinceIso) - 5_000;
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 6_000));
        try {
          const res = await fetch(`/app/assistant/api/conversations/${convId}`);
          if (!res.ok) continue;
          const data = (await res.json()) as {
            messages?: Array<{
              role: string;
              content: string | null;
              createdAt: string;
              toolCalls?: unknown;
            }>;
          };
          const done = (data.messages ?? []).some(
            (m) =>
              m.role === 'assistant' &&
              Date.parse(m.createdAt) > since &&
              typeof m.content === 'string' &&
              m.content.trim().length > 0 &&
              !m.toolCalls
          );
          if (done) return true;
        } catch {
          /* keep waiting */
        }
      }
      return false;
    },
    []
  );

  const send = useCallback(
    async (text: string, opts: SendOptions = {}) => {
      const message = text.trim();
      if (!message || streamingRef.current) return;
      setError(null);
      lastSendRef.current = { text: message, opts };
      stoppedRef.current = false;

      streamingRef.current = true;
      setStreaming(true);
      const convId = await ensureConversation();
      if (!convId) {
        streamingRef.current = false;
        setStreaming(false);
        return;
      }

      const userMsg: MessageData = {
        id: `temp-${Date.now()}`,
        role: 'user',
        content: message,
        attachments: opts.attachments?.length ? opts.attachments : undefined,
        createdAt: new Date().toISOString(),
      };
      if (!opts.silent) setMessages((prev) => [...prev, userMsg]);
      setLive({ ...EMPTY_LIVE, startedAt: Date.now() });

      const controller = new AbortController();
      abortRef.current = controller;
      const { agentId, model, context, onWorkspaceHint } = inputRef.current;

      try {
        const res = await fetch('/app/assistant/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: convId,
            message,
            context,
            model: model ?? undefined,
            agentId: agentId && agentId !== 'principal' ? agentId : undefined,
            planFirst: opts.planFirst || undefined,
            attachments: opts.attachments?.length ? opts.attachments.map((a) => a.id) : undefined,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const errData = (await res.json().catch(() => ({}))) as { error?: string };
          setError({
            text:
              res.status === 429
                ? (errData.error ??
                  'Llegaste al límite de mensajes por ahora. Intenta en un momento.')
                : (errData.error ?? 'No se pudo conectar con el asistente.'),
            retry: true,
          });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let reasoning = '';
        const tools: LiveToolCall[] = [];
        let seq = 0;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            let event: { type?: string; data?: Record<string, unknown> };
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            const data = (event.data ?? {}) as Record<string, unknown>;
            switch (event.type) {
              case 'token':
                if (typeof data.delta === 'string') {
                  content += data.delta;
                  setLive((l) => ({ ...l, content }));
                }
                break;
              case 'reasoning':
                if (typeof data.delta === 'string') {
                  reasoning += data.delta;
                  setLive((l) => ({ ...l, reasoning }));
                }
                break;
              case 'routing':
                setLive((l) => ({
                  ...l,
                  route: {
                    tier: typeof data.modelClass === 'string' ? data.modelClass : undefined,
                  },
                }));
                break;
              case 'tool_call_start': {
                const name = String(data.name ?? '');
                tools.push({
                  key: `t${seq++}`,
                  name,
                  args: argsOf(data.args),
                  startedAt: Date.now(),
                });
                setLive((l) => ({ ...l, tools: [...tools] }));
                const tab = workspaceTabForTool(name);
                if (tab) onWorkspaceHint?.(tab);
                break;
              }
              case 'tool_call_end': {
                const name = String(data.name ?? '');
                const idx = tools.findIndex((t) => t.name === name && t.success === undefined);
                if (idx >= 0) {
                  tools[idx] = {
                    ...tools[idx],
                    success: Boolean(data.success) || Boolean(data.needsApproval),
                    durationMs:
                      typeof data.durationMs === 'number'
                        ? data.durationMs
                        : Date.now() - tools[idx].startedAt,
                  };
                  setLive((l) => ({ ...l, tools: [...tools] }));
                }
                break;
              }
              case 'artifact':
                setLive((l) => ({
                  ...l,
                  artifacts: [...l.artifacts, data as unknown as ArtifactInfo],
                }));
                break;
              case 'ui':
                if (Array.isArray(data.components)) {
                  const comps = data.components as UiComponent[];
                  setLive((l) => ({ ...l, ui: [...l.ui, ...comps].slice(-8) }));
                }
                break;
              case 'proposal': {
                const p = data as unknown as ProposalInfo;
                setProposals((prev) => [
                  ...prev.filter((x) => x.id !== p.id),
                  { ...p, status: 'pending' },
                ]);
                break;
              }
              case 'action':
                performUiAction(data as unknown as UiAction);
                break;
              case 'done':
                setLive((l) => ({
                  ...l,
                  route: {
                    ...(l.route ?? {}),
                    model: typeof data.model === 'string' ? data.model : undefined,
                  },
                }));
                await loadConversation(convId, { quiet: true });
                setLive(EMPTY_LIVE);
                break;
              case 'error':
                setError({
                  text:
                    typeof data.message === 'string' ? data.message : 'El asistente tuvo un error.',
                  retry: true,
                });
                // Keep whatever the run managed to persist before failing.
                await loadConversation(convId, { quiet: true });
                break;
              default:
                break;
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          // Stopped by the user: show whatever the server persisted.
          if (stoppedRef.current) await loadConversation(convId, { quiet: true });
        } else {
          // The stream was cut (proxy idle limit, phone lock, flaky network): the run keeps
          // going on the server — wait for the persisted answer instead of failing.
          setError({
            text: 'Se perdió la conexión, pero el agente sigue trabajando. Esperando su respuesta…',
            info: true,
          });
          const recovered = await waitForPersistedAnswer(convId, userMsg.createdAt);
          if (recovered) {
            setError(null);
            await loadConversation(convId, { quiet: true });
          } else {
            setError({
              text: 'Se perdió la conexión. Recarga la conversación en unos minutos para ver la respuesta.',
              retry: true,
            });
          }
        }
      } finally {
        streamingRef.current = false;
        setStreaming(false);
        setLive(EMPTY_LIVE);
        abortRef.current = null;
        if (pendingReloadRef.current) {
          pendingReloadRef.current = false;
          void loadConversation(convId, { quiet: true });
        }
      }
    },
    [ensureConversation, loadConversation, waitForPersistedAnswer]
  );

  const stop = useCallback(() => {
    stoppedRef.current = true;
    abortRef.current?.abort();
  }, []);

  const retry = useCallback(() => {
    const last = lastSendRef.current;
    if (!last || streamingRef.current) return;
    // The failed user bubble is already on screen — resend without duplicating it.
    setMessages((prev) => {
      const lastMsg = prev[prev.length - 1];
      return lastMsg && lastMsg.role === 'user' && lastMsg.id.startsWith('temp-')
        ? prev.slice(0, -1)
        : prev;
    });
    void send(last.text, last.opts);
  }, [send]);

  const reload = useCallback(() => {
    if (conversationId) void loadConversation(conversationId, { quiet: true });
  }, [conversationId, loadConversation]);

  /** An approval card changed state; run follow-ups (UI action or self-repair). */
  const onProposalDecided = useCallback(
    (updated: ProposalInfo, execution?: ProposalExecution) => {
      setProposals((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      if (conversationId) void loadConversation(conversationId, { quiet: true });
      if (!execution) return;
      if (execution.success) {
        const action = uiActionFromResult(updated.toolName, execution.result);
        if (action) performUiAction(action);
      } else if (!execution.uncertain) {
        // Let the agent read the error and fix it by itself.
        void send(actionFailedMessage(updated.toolName, execution.error ?? 'La acción falló'), {
          silent: false,
        });
      }
    },
    [conversationId, loadConversation, send]
  );

  return {
    conversationId,
    messages,
    loading,
    streaming,
    live,
    proposals,
    error,
    consolidating,
    thread,
    setError,
    send,
    stop,
    retry,
    reload,
    ensureConversation,
    onProposalDecided,
    canRetry: Boolean(lastSendRef.current),
  };
}

export type ChatStream = ReturnType<typeof useChatStream>;

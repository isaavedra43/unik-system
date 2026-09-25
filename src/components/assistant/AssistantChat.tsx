'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Loader2,
  Check,
  X,
  Flag,
  MessageSquare,
  SlidersHorizontal,
} from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantMessage, type AssistantMessageData, ThinkingBlock } from './AssistantMessage';
import { AssistantInput, type AttachmentDraft } from './AssistantInput';
import { ModelSelector } from './ModelSelector';
import { ArtifactRenderer, type ArtifactData } from './ArtifactRenderer';
import {
  actionFailedMessage,
  performUiAction,
  toolStepLabel,
  uiActionFromResult,
  type UiAction,
} from '@/components/copilot/copilot-types';
import { AssistantSuggestions, getSuggestionsForPage } from './AssistantSuggestions';
import { VoiceMode } from './VoiceMode';
import { AssistantProposalCard, type ProposalData } from './AssistantProposalCard';
import { createConversationAction } from '@/app/app/assistant/actions';
import { GenerativeUi } from './generative/GenerativeUi';
import type { UiComponent } from '@/modules/ai/generative-ui/types';
import { AgentAvatar } from './agents/AgentAvatar';
import { AGENT_SUGGESTIONS } from './agents/NewAgentSheet';
import { PRINCIPAL_AGENT, type AgentInfo } from './agents/agent-types';
import { cn } from '@/lib/utils';

type AgentTemplate = { name: string; purpose: string; icon: string; color: number };

export interface AssistantChatProps {
  conversationId: string | null;
  context?: { page?: string };
  user: CurrentUser;
  onConversationCreated?: (id: string) => void;
  /** Active agent shown in the chat head (defaults to the Principal). */
  agent?: AgentInfo;
  /** Team for the mobile agent strip under the chat head. */
  agents?: AgentInfo[];
  onSelectAgent?: (agentId: string) => void;
  /** Composer default mode — 'mission' maps to plan-first semantics. */
  composerMode?: 'mission' | 'message';
  /** Empty-state suggestion cards open the new-agent sheet pre-filled. */
  onNewAgent?: (template?: AgentTemplate) => void;
  /** Chat head missions button → toggles the ops panel. */
  onToggleOps?: () => void;
}

interface ActiveToolCall {
  name: string;
  args?: unknown;
  success?: boolean;
  durationMs?: number;
}

export function AssistantChat({
  conversationId: externalId,
  context,
  user,
  onConversationCreated,
  agent,
  agents,
  onSelectAgent,
  composerMode = 'message',
  onNewAgent,
  onToggleOps,
}: AssistantChatProps) {
  const [conversationId, setConversationId] = useState<string | null>(externalId);
  const [messages, setMessages] = useState<AssistantMessageData[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactData[]>([]);
  const [proposals, setProposals] = useState<ProposalData[]>([]);
  const [liveUi, setLiveUi] = useState<UiComponent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Composer mode pills: 'mission' = plan-first semantics (la IA propone los
  // pasos y espera confirmación), 'message' = respuesta directa.
  const [planFirst, setPlanFirst] = useState(composerMode === 'mission');
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const router = useRouter();
  const shownAgent = agent ?? PRINCIPAL_AGENT;
  const working = streaming || activeToolCalls.length > 0;

  const canUseVoice = user.permissionKeys.includes('assistant.voice') || user.isSuperAdmin;

  const canUseUpload = user.permissionKeys.includes('assistant.upload') || user.isSuperAdmin;

  useEffect(() => {
    setConversationId(externalId);
  }, [externalId]);

  // The tweaks panel can change the composer's default mode — sync new turns.
  useEffect(() => {
    setPlanFirst(composerMode === 'mission');
  }, [composerMode]);

  const loadConversation = useCallback(async (id: string) => {
    setLoadingConv(true);
    setError(null);
    try {
      const res = await fetch(`/app/assistant/api/conversations/${id}`);
      if (!res.ok) {
        setError('No se pudo cargar la conversación');
        setMessages([]);
        return;
      }
      const data = await res.json();
      // Pending approvals of this conversation survive reloads.
      fetch(`/app/assistant/api/proposals?conversationId=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : { proposals: [] }))
        .then((p) => setProposals((p.proposals ?? []) as ProposalData[]))
        .catch(() => undefined);
      setMessages(
        (data.messages ?? []).map((m: Record<string, unknown>) => ({
          id: m.id as string,
          role: m.role as AssistantMessageData['role'],
          content: (m.content as string) ?? null,
          toolCalls: m.toolCalls as AssistantMessageData['toolCalls'],
          toolCallRecords: m.toolCallRecords as AssistantMessageData['toolCallRecords'],
          attachments: m.attachments as AssistantMessageData['attachments'],
          artifacts: m.artifacts as AssistantMessageData['artifacts'],
          meta: (m.meta as AssistantMessageData['meta']) ?? null,
          feedback: (m.feedback as AssistantMessageData['feedback']) ?? null,
          createdAt: m.createdAt as string,
        }))
      );
    } finally {
      setLoadingConv(false);
    }
  }, []);

  useEffect(() => {
    if (conversationId) {
      loadConversation(conversationId);
    } else {
      setMessages([]);
      setArtifacts([]);
    }
  }, [conversationId, loadConversation]);

  // Auto-scroll to bottom only when user is already near the bottom.
  // During streaming, use instant scroll to avoid janky repeated smooth animations.
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const threshold = 80;
      isNearBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (messages.length === 0 && !streamingContent) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    // Only auto-scroll if the user is near the bottom
    if (!isNearBottomRef.current) return;
    // Use instant scroll during streaming to avoid janky repeated smooth animations
    container.scrollTop = container.scrollHeight;
  }, [messages, streamingContent, activeToolCalls, artifacts, liveUi]);

  async function handleSend(text: string, attachments: AttachmentDraft[] = []) {
    setError(null);
    let convId = conversationId;

    if (!convId) {
      try {
        const { id } = await createConversationAction({});
        convId = id;
        setConversationId(id);
        onConversationCreated?.(id);
      } catch {
        setError('No se pudo crear la conversación');
        return;
      }
    }

    const userMsg: AssistantMessageData = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: text,
      attachments:
        attachments.length > 0
          ? attachments.map((a) => ({
              id: a.id,
              fileName: a.fileName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
            }))
          : undefined,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    setStreaming(true);
    setStreamingContent('');
    setStreamingReasoning('');
    setActiveToolCalls([]);
    setArtifacts([]);
    setLiveUi([]);
    setPlanFirst(composerMode === 'mission');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/app/assistant/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: convId,
          message: text,
          context,
          model: selectedModel ?? undefined,
          // Real agent id (cuid) — the 'principal' sentinel only exists when
          // the agents API/tables are absent, so it's never sent.
          agentId: shownAgent.id !== 'principal' ? shownAgent.id : undefined,
          planFirst: planFirst || undefined,
          // Only ids: the server resolves ownership, conversation and READY state.
          attachments: attachments.length > 0 ? attachments.map((a) => a.id) : undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({ error: 'Error desconocido' }));
        setError(errData.error ?? 'Error en la conexión');
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';
      let reasoningContent = '';
      const toolCalls: ActiveToolCall[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'token' && event.data?.delta) {
              assistantContent += event.data.delta;
              setStreamingContent(assistantContent);
            } else if (event.type === 'reasoning' && event.data?.delta) {
              reasoningContent += event.data.delta;
              setStreamingReasoning(reasoningContent);
            } else if (event.type === 'tool_call_start') {
              toolCalls.push({ name: event.data.name, args: event.data.args });
              setActiveToolCalls([...toolCalls]);
            } else if (event.type === 'tool_call_end') {
              const idx = toolCalls.findIndex(
                (t) => t.name === event.data.name && t.success === undefined
              );
              if (idx >= 0) {
                toolCalls[idx] = {
                  name: event.data.name,
                  args: toolCalls[idx].args,
                  success: event.data.success,
                  durationMs: event.data.durationMs,
                };
                setActiveToolCalls([...toolCalls]);
              }
            } else if (event.type === 'artifact') {
              setArtifacts((prev) => [...prev, event.data as ArtifactData]);
            } else if (event.type === 'ui' && Array.isArray(event.data?.components)) {
              setLiveUi((prev) => [...prev, ...(event.data.components as UiComponent[])].slice(-6));
            } else if (event.type === 'proposal') {
              setProposals((prev) => [
                ...prev.filter((p) => p.id !== event.data.id),
                event.data as ProposalData,
              ]);
            } else if (event.type === 'action') {
              performUiAction(event.data as UiAction);
            } else if (event.type === 'done') {
              setStreamingContent('');
              setStreamingReasoning('');
              setActiveToolCalls([]);
              // Persisted artifacts and tool cards now render inside their message.
              setArtifacts([]);
              setLiveUi([]);
              if (convId) await loadConversation(convId);
            } else if (event.type === 'error') {
              setError(event.data?.message ?? 'Error desconocido');
              setStreamingContent('');
              setStreamingReasoning('');
              setActiveToolCalls([]);
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        // The stream was cut (proxy idle limit, phone lock, flaky network) but the run keeps
        // going on the server and its answer is persisted: wait for it instead of failing.
        if (convId) {
          setError(
            'Se perdió la conexión, pero el asistente sigue trabajando. Esperando la respuesta…'
          );
          const recovered = await waitForPersistedAnswer(convId, userMsg.createdAt);
          if (recovered) {
            setError(null);
            await loadConversation(convId);
          } else {
            setError(
              'Se perdió la conexión. Recarga la conversación en unos minutos para ver la respuesta.'
            );
          }
        } else {
          setError(e instanceof Error ? e.message : 'Error de conexión');
        }
      }
    } finally {
      setStreaming(false);
      setStreamingContent('');
      setStreamingReasoning('');
      setActiveToolCalls([]);
      abortRef.current = null;
    }
  }

  /** Polls the conversation until an assistant answer newer than `sinceIso` exists (up to ~15 min). */
  async function waitForPersistedAnswer(convId: string, sinceIso: string): Promise<boolean> {
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
        // keep waiting
      }
    }
    return false;
  }

  const suggestions = getSuggestionsForPage(context?.page);
  // A proposed plan stays actionable until the user writes something after it.
  const lastUserIndex = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);

  const isEmpty = messages.length === 0 && !streaming;

  return (
    <div className={`assistant-chat ${isEmpty ? 'assistant-chat-empty' : ''}`}>
      {/* Chat head — the agent that owns this thread. */}
      <div className="agent-chat-head">
        <AgentAvatar agent={shownAgent} size="sm" status={working ? 'working' : 'idle'} />
        <div className="agent-chat-head-text">
          <span className="agent-chat-head-name">
            {shownAgent.name}
            {shownAgent.kind === 'principal' && <span className="agent-badge-jefe">Jefe</span>}
          </span>
          <span className={cn('agent-chat-head-status', working && 'is-working')}>
            {working ? 'Trabajando…' : 'Disponible'}
          </span>
        </div>
        <div className="agent-chat-head-actions">
          {onToggleOps && (
            <button
              type="button"
              className="agent-head-btn"
              onClick={onToggleOps}
              aria-label="Ver operación del equipo"
              title="Operación del equipo"
            >
              <Flag size={15} />
            </button>
          )}
          <button
            type="button"
            className="agent-head-btn"
            onClick={() => router.push('/app/assistant?settings=1')}
            aria-label="Configurar el asistente"
            title="Configuración"
          >
            <SlidersHorizontal size={15} />
          </button>
        </div>
        {/* Mobile agent strip — the team stays reachable without the drawer. */}
        {agents && agents.length > 0 && onSelectAgent && (
          <div className="agent-strip" role="tablist" aria-label="Equipo">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={shownAgent.id === a.id}
                className={cn('agent-strip-item', shownAgent.id === a.id && 'is-active')}
                onClick={() => onSelectAgent(a.id)}
                title={a.name}
              >
                <AgentAvatar agent={a} status={a.status ?? 'idle'} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className="assistant-chat-messages"
        ref={scrollContainerRef}
        role="log"
        aria-live="polite"
      >
        {loadingConv && <div className="assistant-chat-loading">Cargando…</div>}
        {!loadingConv && messages.length === 0 && !streaming && (
          <div className="assistant-welcome agent-hero">
            <AgentAvatar agent={shownAgent} size="lg" />
            <h3 className="assistant-welcome-title">{shownAgent.name}</h3>
            <p className="assistant-welcome-text">
              {(agents?.length ?? 1) <= 1
                ? 'Crea tu primer agente — especialistas con su propio chat, misiones y herramientas.'
                : (shownAgent.purpose ??
                  'Tu coordinador: conversa, delega misiones al equipo y te avisa cuando algo necesita tu aprobación.')}
            </p>
            {onNewAgent && (
              <div className="agent-hero-cards">
                {AGENT_SUGGESTIONS.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    className="agent-suggestion"
                    onClick={() => onNewAgent(s)}
                  >
                    <AgentAvatar agent={{ name: s.name, color: s.color, icon: s.icon }} size="xs" />
                    <span>
                      <span className="agent-suggestion-name">{s.name}</span>
                      <span className="agent-suggestion-sub">{s.purpose}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <AssistantMessage
            key={m.id}
            message={m}
            onSendText={(text) => void handleSend(text)}
            isLatest={i > lastUserIndex && !streaming}
          />
        ))}
        {(streaming || streamingContent || streamingReasoning || activeToolCalls.length > 0) && (
          <div className="assistant-msg-row assistant-msg-row-assistant">
            <AgentAvatar
              agent={shownAgent}
              size="sm"
              status="working"
              className="assistant-msg-avatar"
            />
            <div className="assistant-msg assistant-msg-assistant">
              {streamingReasoning && <ThinkingBlock text={streamingReasoning} live />}
              {streamingContent && (
                <div className="assistant-md">
                  <p className="assistant-md-p">{streamingContent}</p>
                </div>
              )}
              {activeToolCalls.length > 0 && (
                <div className="assistant-steps-row">
                  {activeToolCalls.map((tc, idx) => (
                    <span
                      key={idx}
                      className={`assistant-step ${tc.success === undefined ? 'is-running' : tc.success ? 'is-done' : 'is-failed'}`}
                    >
                      {tc.success === undefined ? (
                        <Loader2 size={11} className="copilot-spin" />
                      ) : tc.success ? (
                        <Check size={11} />
                      ) : (
                        <X size={11} />
                      )}
                      {toolStepLabel(
                        tc.name,
                        tc.args,
                        tc.success === undefined ? 'running' : 'done'
                      )}
                    </span>
                  ))}
                </div>
              )}
              {liveUi.length > 0 && (
                <GenerativeUi
                  components={liveUi}
                  onSendText={(text) => void handleSend(text)}
                  interactive
                />
              )}
              {streaming &&
                !streamingContent &&
                !streamingReasoning &&
                activeToolCalls.length === 0 &&
                liveUi.length === 0 && (
                  <div className="assistant-typing">
                    <span className="assistant-typing-dot" />
                    <span className="assistant-typing-dot" />
                    <span className="assistant-typing-dot" />
                  </div>
                )}
            </div>
          </div>
        )}
        {artifacts.length > 0 && (
          <div className="assistant-artifacts">
            {artifacts.map((a) => (
              <ArtifactRenderer key={a.artifactId} artifact={a} />
            ))}
          </div>
        )}
        {proposals.filter((p) => p.status === 'pending' || !p.status).length > 0 && (
          <div className="assistant-artifacts">
            {proposals
              .filter((p) => p.status === 'pending' || !p.status)
              .map((p) => (
                <AssistantProposalCard
                  key={p.id}
                  proposal={p}
                  onDecided={(updated, execution) => {
                    setProposals((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
                    if (conversationId) loadConversation(conversationId);
                    if (!execution) return;
                    if (execution.success) {
                      const action = uiActionFromResult(updated.toolName, execution.result);
                      if (action) performUiAction(action);
                    } else if (!execution.uncertain) {
                      // Let the assistant read the error and fix it by itself.
                      void handleSend(
                        actionFailedMessage(updated.toolName, execution.error ?? 'La acción falló')
                      );
                    }
                  }}
                />
              ))}
          </div>
        )}
        {error && (
          <div className="assistant-error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>
      {messages.length === 0 && !streaming && (
        <AssistantSuggestions suggestions={suggestions} onSelect={handleSend} />
      )}
      <div className="assistant-input-bar">
        <div className="assistant-input-topbar">
          {/* Mode pills — Misión = plan-first semantics, Mensaje = direct. */}
          <div className="composer-modes" role="radiogroup" aria-label="Modo del mensaje">
            <button
              type="button"
              role="radio"
              aria-checked={planFirst}
              className={cn('composer-mode', planFirst && 'is-active')}
              onClick={() => setPlanFirst(true)}
              title="La IA propone un plan o misión y espera tu confirmación antes de ejecutar"
            >
              <Flag size={12} /> Misión
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!planFirst}
              className={cn('composer-mode', !planFirst && 'is-active')}
              onClick={() => setPlanFirst(false)}
              title="Respuesta directa, sin plan"
            >
              <MessageSquare size={12} /> Mensaje
            </button>
          </div>
          <ModelSelector value={selectedModel} onChange={setSelectedModel} />
        </div>
        <AssistantInput
          onSend={handleSend}
          disabled={loadingConv}
          streaming={streaming}
          conversationId={conversationId}
          canUpload={canUseUpload}
          canUseVoice={canUseVoice}
          onVoiceOpen={() => setVoiceModeOpen(true)}
        />
      </div>
      <AnimatePresence>
        {voiceModeOpen && (
          <VoiceMode
            conversationId={conversationId}
            context={context}
            onClose={() => setVoiceModeOpen(false)}
            onConversationCreated={(id) => {
              setConversationId(id);
              onConversationCreated?.(id);
            }}
            user={{
              id: user.id,
              name: user.name,
              username: user.username,
              isSuperAdmin: user.isSuperAdmin,
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

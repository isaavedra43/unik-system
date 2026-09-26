'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  Check,
  Flag,
  Loader2,
  Menu,
  MessageSquare,
  PanelRight,
  SlidersHorizontal,
  SquarePen,
  X,
} from 'lucide-react';
import { AnimatePresence } from 'motion/react';
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
import { getSuggestionsForPage } from './AssistantSuggestions';
import { VoiceMode } from './VoiceMode';
import { AssistantProposalCard, type ProposalData } from './AssistantProposalCard';
import { createConversationAction } from '@/app/app/assistant/actions';
import { GenerativeUi } from './generative/GenerativeUi';
import type { UiComponent } from '@/modules/ai/generative-ui/types';
import { AGENT_TEMPLATES } from '@/modules/agents/agent-templates';
import { AgentAvatar } from './agents/AgentAvatar';
import {
  PRINCIPAL_AGENT,
  workspaceTabForTool,
  type AgentInfo,
  type WorkspaceTab,
} from './agents/agent-types';
import { cn } from '@/lib/utils';

/** Visual seed the empty-state cards hand to the new-agent sheet. */
type AgentTemplateSeed = { name: string; purpose: string; icon: string; color: number };

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
  /** Empty-state cards open the new-agent sheet pre-filled with a template. */
  onNewAgent?: (template?: AgentTemplateSeed) => void;
  /** Chat head button → toggles the workspace column (or, in the widget, opens the full page). */
  onToggleOps?: () => void;
  /** Whether the workspace column/sheet is visible (drives the toggle's active state). */
  workspaceOpen?: boolean;
  /** Something happened in the workspace while it was closed (mobile badge). */
  workspaceBadge?: boolean;
  /** Mobile: opens the team drawer. */
  onOpenSidebar?: () => void;
  /** A tool with a surface started — the page brings that surface up. */
  onWorkspaceHint?: (tab: WorkspaceTab) => void;
  /** Header "new conversation" — clears the active thread. */
  onNewConversation?: () => void;
}

interface ActiveToolCall {
  name: string;
  args?: unknown;
  success?: boolean;
  durationMs?: number;
}

interface ChatError {
  text: string;
  /** Informational (waiting for the server to finish) instead of a failure. */
  info?: boolean;
  /** The last message can be re-sent. */
  retry?: boolean;
}

/** Empty-state chips for the coordinator on /app/assistant. */
const UNIVERSO_CHIPS = [
  'Dame el resumen del día en 5 líneas',
  'Abre el navegador y busca los precios de mi competencia',
  '¿Qué cotizaciones llevan más de 3 días sin respuesta?',
  '¿Qué pedidos tienen saldo pendiente?',
  'Genera una imagen promocional de mi producto estrella',
];

/** Chips for a specialist thread — short, action-first. */
const SPECIALIST_CHIPS = [
  'Empieza con tu tarea principal de hoy',
  'Dame un estado en 3 líneas',
  'Propón una misión para esta semana',
];

function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
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
  workspaceOpen = false,
  workspaceBadge = false,
  onOpenSidebar,
  onWorkspaceHint,
  onNewConversation,
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
  const [error, setError] = useState<ChatError | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Composer mode pills: 'mission' = plan-first semantics (la IA propone los
  // pasos y espera confirmación), 'message' = respuesta directa.
  const [planFirst, setPlanFirst] = useState(composerMode === 'mission');
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const lastSendRef = useRef<{ text: string; attachments: AttachmentDraft[] } | null>(null);
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
        setError({ text: 'No se pudo cargar la conversación' });
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
      setProposals([]);
      setError(null);
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
    lastSendRef.current = { text, attachments };
    stoppedRef.current = false;
    let convId = conversationId;

    if (!convId) {
      try {
        const { id } = await createConversationAction({});
        convId = id;
        setConversationId(id);
        onConversationCreated?.(id);
      } catch {
        setError({ text: 'No se pudo crear la conversación', retry: true });
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
    // A fresh turn always lands the reader at the bottom.
    isNearBottomRef.current = true;

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
        setError({ text: errData.error ?? 'Error en la conexión', retry: true });
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
              // Browser / virtual computer / files: bring that surface up.
              const tab = workspaceTabForTool(String(event.data.name ?? ''));
              if (tab) onWorkspaceHint?.(tab);
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
              setError({ text: event.data?.message ?? 'Error desconocido', retry: true });
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
      if ((e as Error).name === 'AbortError') {
        // The user stopped the answer: show whatever the server persisted so far.
        if (stoppedRef.current && convId) await loadConversation(convId);
      } else {
        // The stream was cut (proxy idle limit, phone lock, flaky network) but the run keeps
        // going on the server and its answer is persisted: wait for it instead of failing.
        if (convId) {
          setError({
            text: 'Se perdió la conexión, pero el asistente sigue trabajando. Esperando la respuesta…',
            info: true,
          });
          const recovered = await waitForPersistedAnswer(convId, userMsg.createdAt);
          if (recovered) {
            setError(null);
            await loadConversation(convId);
          } else {
            setError({
              text: 'Se perdió la conexión. Recarga la conversación en unos minutos para ver la respuesta.',
              retry: true,
            });
          }
        } else {
          setError({ text: e instanceof Error ? e.message : 'Error de conexión', retry: true });
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

  /** Stop the current answer (the server keeps what it already persisted). */
  const handleStop = useCallback(() => {
    stoppedRef.current = true;
    abortRef.current?.abort();
  }, []);

  function retryLast() {
    const last = lastSendRef.current;
    if (!last || streaming) return;
    void handleSend(last.text, last.attachments);
  }

  // Quick actions from the workspace column ("uv:send") land here.
  const sendRef = useRef(handleSend);
  useEffect(() => {
    sendRef.current = handleSend;
  });
  useEffect(() => {
    const onExternalSend = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text === 'string' && text.trim()) void sendRef.current(text.trim());
    };
    window.addEventListener('uv:send', onExternalSend);
    return () => window.removeEventListener('uv:send', onExternalSend);
  }, []);

  const isPrincipal = shownAgent.kind === 'principal';
  const suggestions = isPrincipal
    ? context?.page === '/app/assistant'
      ? UNIVERSO_CHIPS
      : getSuggestionsForPage(context?.page)
    : SPECIALIST_CHIPS;
  // A proposed plan stays actionable until the user writes something after it.
  const lastUserIndex = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);

  const isEmpty = messages.length === 0 && !streaming;
  const runningTool = activeToolCalls.find((t) => t.success === undefined);
  const statusText = !working
    ? 'Disponible'
    : runningTool
      ? toolStepLabel(runningTool.name, runningTool.args, 'running')
      : streamingContent
        ? 'Escribiendo…'
        : 'Pensando…';
  const pendingProposals = proposals.filter((p) => p.status === 'pending' || !p.status);
  const showStream =
    streaming || streamingContent || streamingReasoning || activeToolCalls.length > 0;
  const who = firstName(user.name);

  const modePills = (
    <div className="uv-modes" role="radiogroup" aria-label="Modo del mensaje">
      <button
        type="button"
        role="radio"
        aria-checked={planFirst}
        className={cn('uv-mode', planFirst && 'is-active')}
        onClick={() => setPlanFirst(true)}
        title="La IA propone un plan o misión y espera tu confirmación antes de ejecutar"
      >
        <Flag size={12} /> <span>Misión</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!planFirst}
        className={cn('uv-mode', !planFirst && 'is-active')}
        onClick={() => setPlanFirst(false)}
        title="Respuesta directa, sin plan"
      >
        <MessageSquare size={12} /> <span>Mensaje</span>
      </button>
    </div>
  );

  return (
    <div className={cn('uv-chat', isEmpty && 'is-empty')} data-agent={shownAgent.id}>
      {/* Chat head — the agent that owns this thread. */}
      <header className="uv-chat-head">
        {onOpenSidebar && (
          <button
            type="button"
            className="uv-icon-btn uv-mobile-only"
            onClick={onOpenSidebar}
            aria-label="Abrir el equipo"
            title="Equipo y conversaciones"
          >
            <Menu size={18} />
          </button>
        )}
        <AgentAvatar agent={shownAgent} size="sm" status={working ? 'working' : 'idle'} />
        <div className="uv-chat-head-text">
          <span className="uv-chat-head-name">
            {shownAgent.name}
            {isPrincipal && <span className="uv-badge-jefe">Jefe</span>}
          </span>
          <span className={cn('uv-chat-head-status', working && 'is-working')} aria-live="polite">
            <span className="uv-dot" aria-hidden="true" />
            {statusText}
          </span>
        </div>
        <div className="uv-head-actions">
          {onNewConversation && (
            <button
              type="button"
              className="uv-icon-btn"
              onClick={onNewConversation}
              aria-label="Nueva conversación"
              title="Nueva conversación"
            >
              <SquarePen size={17} />
            </button>
          )}
          {onToggleOps && (
            <button
              type="button"
              className={cn(
                'uv-icon-btn',
                workspaceOpen && 'is-active',
                workspaceBadge && 'has-badge'
              )}
              onClick={onToggleOps}
              aria-label={
                workspaceOpen ? 'Ocultar espacio de trabajo' : 'Mostrar espacio de trabajo'
              }
              aria-pressed={workspaceOpen}
              title="Espacio de trabajo (⌘J)"
            >
              <PanelRight size={17} />
              {workspaceBadge && (
                <span className="uv-badge-n" aria-hidden="true">
                  •
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            className="uv-icon-btn"
            onClick={() => router.push('/app/assistant?settings=1')}
            aria-label="Configurar el asistente"
            title="Configuración"
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>
      </header>
      {/* Mobile agent strip — the team stays reachable without the drawer. */}
      {agents && agents.length > 1 && onSelectAgent && (
        <div className="uv-agent-strip" role="tablist" aria-label="Equipo">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={shownAgent.id === a.id}
              className={cn('uv-agent-strip-item', shownAgent.id === a.id && 'is-active')}
              onClick={() => onSelectAgent(a.id)}
              title={a.name}
            >
              <AgentAvatar agent={a} status={a.status ?? 'idle'} />
            </button>
          ))}
        </div>
      )}

      <div
        className={cn('uv-chat-scroll', isEmpty && !loadingConv && 'is-empty')}
        ref={scrollContainerRef}
        role="log"
        aria-live="polite"
        aria-busy={loadingConv || streaming}
      >
        {loadingConv && (
          <div className="uv-loading">
            <Loader2 size={16} className="copilot-spin" /> Cargando conversación…
          </div>
        )}

        {!loadingConv && isEmpty && (
          <div className="uv-welcome">
            <AgentAvatar agent={shownAgent} size="lg" />
            <h2 className="uv-welcome-title">
              {isPrincipal
                ? who
                  ? `¿En qué trabajamos hoy, ${who}?`
                  : '¿En qué trabajamos hoy?'
                : shownAgent.name}
            </h2>
            <p className="uv-welcome-text">
              {isPrincipal
                ? (agents?.length ?? 1) <= 1
                  ? 'Pregunta, pide una misión o abre la computadora virtual. Crea especialistas para que trabajen por ti, incluso cuando no estés.'
                  : 'Tu coordinador: conversa, delega misiones al equipo y te avisa cuando algo necesita tu aprobación.'
                : (shownAgent.purpose ??
                  'Especialista de tu equipo: dale una tarea o pide un estado.')}
            </p>
            {isPrincipal && onNewAgent && (
              <div className="uv-welcome-grid" aria-label="Crear un especialista">
                {AGENT_TEMPLATES.slice(0, 4).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="uv-welcome-card"
                    onClick={() => onNewAgent(t)}
                    title={`Crear «${t.name}»`}
                  >
                    <AgentAvatar agent={{ name: t.name, color: t.color, icon: t.icon }} size="xs" />
                    <span className="uv-welcome-card-text">
                      <span className="uv-welcome-card-name">{t.name}</span>
                      <span className="uv-welcome-card-sub">{t.purpose}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="uv-chips" aria-label="Sugerencias">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="uv-chip"
                  onClick={() => void handleSend(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isEmpty && (
          <div className="uv-thread-inner">
            {messages.map((m, i) => (
              <AssistantMessage
                key={m.id}
                message={m}
                onSendText={(text) => void handleSend(text)}
                isLatest={i > lastUserIndex && !streaming}
              />
            ))}

            {showStream && (
              <div className="uv-stream" aria-busy="true">
                <AgentAvatar
                  agent={shownAgent}
                  size="sm"
                  status="working"
                  className="assistant-msg-avatar"
                />
                <div className="uv-stream-body">
                  {streamingReasoning && <ThinkingBlock text={streamingReasoning} live />}
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
                  {streamingContent && (
                    <div className="assistant-md uv-stream-text">
                      <p className="assistant-md-p">{streamingContent}</p>
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
                      <div className="uv-typing" aria-label="Pensando">
                        <span />
                        <span />
                        <span />
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

            {pendingProposals.length > 0 && (
              <div className="assistant-artifacts">
                {pendingProposals.map((p) => (
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
                          actionFailedMessage(
                            updated.toolName,
                            execution.error ?? 'La acción falló'
                          )
                        );
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div
            className={cn('uv-error', error.info && 'is-info')}
            role={error.info ? 'status' : 'alert'}
          >
            {error.info ? (
              <Loader2 size={15} className="copilot-spin" />
            ) : (
              <AlertCircle size={15} />
            )}
            <span>{error.text}</span>
            {error.retry && lastSendRef.current && !streaming && (
              <button type="button" onClick={retryLast}>
                Reintentar
              </button>
            )}
            {!error.info && (
              <button
                type="button"
                className="uv-error-close"
                onClick={() => setError(null)}
                aria-label="Cerrar"
              >
                <X size={13} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="uv-composer-wrap">
        <AssistantInput
          onSend={handleSend}
          onStop={handleStop}
          disabled={loadingConv}
          streaming={streaming}
          conversationId={conversationId}
          canUpload={canUseUpload}
          canUseVoice={canUseVoice}
          onVoiceOpen={() => setVoiceModeOpen(true)}
          leading={modePills}
          trailing={<ModelSelector value={selectedModel} onChange={setSelectedModel} />}
          placeholder={
            planFirst
              ? `Describe la misión para ${shownAgent.name}…`
              : `Mensaje a ${shownAgent.name}…`
          }
        />
        <p className="uv-composer-hint" aria-hidden="true">
          Enter envía · Shift+Enter salto de línea · ⌘K buscar · ⌘J espacio de trabajo
        </p>
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

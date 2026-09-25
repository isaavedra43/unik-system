'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AlertCircle, Bot, Loader2, Check, X, ListChecks } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantMessage, type AssistantMessageData } from './AssistantMessage';
import { AssistantInput, type AttachmentDraft } from './AssistantInput';
import { ModelSelector } from './ModelSelector';
import { ArtifactRenderer, type ArtifactData } from './ArtifactRenderer';
import { actionFailedMessage, performUiAction, toolLabel, uiActionFromResult, type UiAction } from '@/components/copilot/copilot-types';
import {
  AssistantSuggestions,
  getSuggestionsForPage,
} from './AssistantSuggestions';
import { VoiceMode } from './VoiceMode';
import { AssistantProposalCard, type ProposalData } from './AssistantProposalCard';
import { createConversationAction } from '@/app/app/assistant/actions';
import { GenerativeUi } from './generative/GenerativeUi';
import type { UiComponent } from '@/modules/ai/generative-ui/types';

export interface AssistantChatProps {
  conversationId: string | null;
  context?: { page?: string };
  user: CurrentUser;
  onConversationCreated?: (id: string) => void;
}

interface ActiveToolCall {
  name: string;
  success?: boolean;
  durationMs?: number;
}

export function AssistantChat({
  conversationId: externalId,
  context,
  user,
  onConversationCreated,
}: AssistantChatProps) {
  const [conversationId, setConversationId] = useState<string | null>(externalId);
  const [messages, setMessages] = useState<AssistantMessageData[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<ActiveToolCall[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactData[]>([]);
  const [proposals, setProposals] = useState<ProposalData[]>([]);
  const [liveUi, setLiveUi] = useState<UiComponent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [planFirst, setPlanFirst] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canUseVoice = user.permissionKeys.includes('assistant.voice') || user.isSuperAdmin;

  const canUseUpload = user.permissionKeys.includes('assistant.upload') || user.isSuperAdmin;

  useEffect(() => {
    setConversationId(externalId);
  }, [externalId]);

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
      attachments: attachments.length > 0
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
    setActiveToolCalls([]);
    setArtifacts([]);
    setLiveUi([]);
    setPlanFirst(false);

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
            } else if (event.type === 'tool_call_start') {
              toolCalls.push({ name: event.data.name });
              setActiveToolCalls([...toolCalls]);
            } else if (event.type === 'tool_call_end') {
              const idx = toolCalls.findIndex(
                (t) => t.name === event.data.name && t.success === undefined
              );
              if (idx >= 0) {
                toolCalls[idx] = {
                  name: event.data.name,
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
              setProposals((prev) => [...prev.filter((p) => p.id !== event.data.id), event.data as ProposalData]);
            } else if (event.type === 'action') {
              performUiAction(event.data as UiAction);
            } else if (event.type === 'done') {
              setStreamingContent('');
              setActiveToolCalls([]);
              // Persisted artifacts and tool cards now render inside their message.
              setArtifacts([]);
              setLiveUi([]);
              if (convId) await loadConversation(convId);
            } else if (event.type === 'error') {
              setError(event.data?.message ?? 'Error desconocido');
              setStreamingContent('');
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
          setError('Se perdió la conexión, pero el asistente sigue trabajando. Esperando la respuesta…');
          const recovered = await waitForPersistedAnswer(convId, userMsg.createdAt);
          if (recovered) {
            setError(null);
            await loadConversation(convId);
          } else {
            setError('Se perdió la conexión. Recarga la conversación en unos minutos para ver la respuesta.');
          }
        } else {
          setError(e instanceof Error ? e.message : 'Error de conexión');
        }
      }
    } finally {
      setStreaming(false);
      setStreamingContent('');
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
        const data = (await res.json()) as { messages?: Array<{ role: string; content: string | null; createdAt: string; toolCalls?: unknown }> };
        const done = (data.messages ?? []).some(
          (m) => m.role === 'assistant' && Date.parse(m.createdAt) > since && typeof m.content === 'string' && m.content.trim().length > 0 && !m.toolCalls
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
      <div className="assistant-chat-messages" ref={scrollContainerRef} role="log" aria-live="polite">
        {loadingConv && <div className="assistant-chat-loading">Cargando…</div>}
        {!loadingConv && messages.length === 0 && !streaming && (
          <div className="assistant-welcome">
            <div className="assistant-welcome-icon">
              <Bot size={40} />
            </div>
            <h3 className="assistant-welcome-title">Asistente de UNIK</h3>
            <p className="assistant-welcome-text">
              Pregúntame sobre tus ventas, productos, vendedores y más.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <AssistantMessage key={m.id} message={m} onSendText={(text) => void handleSend(text)} isLatest={i > lastUserIndex && !streaming} />
        ))}
        {(streaming || streamingContent || activeToolCalls.length > 0) && (
          <div className="assistant-msg-row assistant-msg-row-assistant">
            <div className="assistant-msg-avatar">
              <Bot size={18} />
            </div>
            <div className="assistant-msg assistant-msg-assistant">
              {streamingContent && (
                <div className="assistant-md">
                  <p className="assistant-md-p">{streamingContent}</p>
                </div>
              )}
              {activeToolCalls.length > 0 && (
                <div className="assistant-steps-row">
                  {activeToolCalls.map((tc, idx) => (
                    <span key={idx} className={`assistant-step ${tc.success === undefined ? 'is-running' : tc.success ? 'is-done' : 'is-failed'}`}>
                      {tc.success === undefined ? <Loader2 size={11} className="copilot-spin" /> : tc.success ? <Check size={11} /> : <X size={11} />}
                      {toolLabel(tc.name, tc.success === undefined ? 'running' : 'done')}
                    </span>
                  ))}
                </div>
              )}
              {liveUi.length > 0 && <GenerativeUi components={liveUi} onSendText={(text) => void handleSend(text)} />}
              {streaming && !streamingContent && activeToolCalls.length === 0 && liveUi.length === 0 && (
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
                      void handleSend(actionFailedMessage(updated.toolName, execution.error ?? 'La acción falló'));
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
          <ModelSelector value={selectedModel} onChange={setSelectedModel} />
          <button
            type="button"
            className={`assistant-plan-toggle ${planFirst ? 'is-on' : ''}`}
            onClick={() => setPlanFirst((v) => !v)}
            aria-pressed={planFirst}
            title="La IA propone los pasos y espera tu confirmación antes de ejecutar"
          >
            <ListChecks size={13} /> Planear primero
          </button>
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
            user={{ id: user.id, name: user.name, username: user.username, isSuperAdmin: user.isSuperAdmin }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

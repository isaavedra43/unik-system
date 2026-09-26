'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import {
  AlertCircle,
  ArrowDown,
  Loader2,
  Menu,
  PanelRight,
  RotateCcw,
  SquarePen,
  X,
} from 'lucide-react';
import type { AgentTeamTemplate } from '@/modules/agents/agent-templates';
import { cn } from '@/lib/utils';
import type { AgentInfo, AttachmentInfo, MessageData, TeamTask, WorkspaceTab } from '../lib/types';
import { stepLabel } from '../lib/tools';
import { AgentAvatar, IconButton } from '../ui';
import { useChatStream } from './useChatStream';
import { Message } from './Message';
import { Markdown } from './Markdown';
import { WorkLog, stepsFromLive } from './WorkLog';
import { Composer, type ComposerHandle, type ComposerMode } from './Composer';
import { AUTO_MODEL, loadStoredModel } from './ModelPicker';
import { Welcome } from './Welcome';
import { VoiceMode } from './VoiceMode';
import { Cards } from '../cards/Cards';
import { ArtifactCard } from '../cards/ArtifactCard';
import { ApprovalCard, TeamRunCard } from '../cards/Agentic';

/**
 * The conversation column: head (who, what they're doing right now), the
 * thread, the live answer (work log → cards → prose), approvals, team work
 * and the composer. Used by the full page and by the floating widget.
 */

export interface ChatUser {
  id: string;
  name: string;
  username: string;
  isSuperAdmin: boolean;
  permissionKeys: string[];
}

export interface ChatProps {
  user: ChatUser;
  conversationId: string | null;
  onConversationCreated?: (id: string) => void;
  agent: AgentInfo;
  /** Team strip on small screens. */
  agents?: AgentInfo[];
  onSelectAgent?: (id: string) => void;
  context?: { page?: string };
  title?: string | null;
  onOpenSidebar?: () => void;
  onNewConversation?: () => void;
  workspaceOpen?: boolean;
  workspaceBadge?: boolean;
  onToggleWorkspace?: () => void;
  onWorkspaceHint?: (tab: WorkspaceTab) => void;
  onOpenWorkspace?: (tab: WorkspaceTab) => void;
  onTeach?: () => void;
  onNewTeam?: (team: AgentTeamTemplate) => void;
  /** Delegated tasks of this conversation (live, from the app shell). */
  teamTasks?: TeamTask[];
  agentName?: (id?: string | null) => string | null;
  defaultMode?: ComposerMode;
  /** The thread's agent became busy / idle (sidebar status). */
  onWorkingChange?: (working: boolean) => void;
  /** The thread's messages changed (the workspace rebuilds its history). */
  onMessages?: (messages: MessageData[]) => void;
  /** The opened thread belongs to this agent (null = principal). */
  onThreadAgent?: (agentId: string | null) => void;
}

export function Chat({
  user,
  conversationId: externalId,
  onConversationCreated,
  agent,
  agents,
  onSelectAgent,
  context,
  title,
  onOpenSidebar,
  onNewConversation,
  workspaceOpen,
  workspaceBadge,
  onToggleWorkspace,
  onWorkspaceHint,
  onOpenWorkspace,
  onTeach,
  onNewTeam,
  teamTasks = [],
  agentName,
  defaultMode = 'message',
  onWorkingChange,
  onMessages,
  onThreadAgent,
}: ChatProps) {
  const [mode, setMode] = useState<ComposerMode>(defaultMode);
  const [model, setModel] = useState<string>(AUTO_MODEL);
  const [voice, setVoice] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const composerRef = useRef<ComposerHandle>(null);

  useEffect(() => setModel(loadStoredModel()), []);
  useEffect(() => setMode(defaultMode), [defaultMode]);

  const chat = useChatStream({
    conversationId: externalId,
    onConversationCreated,
    agentId: agent.id,
    model: model === AUTO_MODEL ? AUTO_MODEL : model,
    context,
    onWorkspaceHint,
  });
  const { messages, streaming, live, loading, proposals, error, consolidating, thread } = chat;

  useEffect(() => {
    onMessages?.(messages);
  }, [messages, onMessages]);
  useEffect(() => {
    if (thread) onThreadAgent?.(thread.agentId);
  }, [thread, onThreadAgent]);

  const canUpload = user.isSuperAdmin || user.permissionKeys.includes('assistant.upload');
  const canUseVoice = user.isSuperAdmin || user.permissionKeys.includes('assistant.voice');

  const send = useCallback(
    (text: string, attachments?: AttachmentInfo[]) => {
      nearBottomRef.current = true;
      void chat.send(text, { attachments, planFirst: mode === 'mission' });
      // A mission is a one-shot choice: the next message goes back to the default.
      if (mode === 'mission' && defaultMode !== 'mission') setMode(defaultMode);
    },
    [chat, mode, defaultMode]
  );

  // Quick actions from the workspace / sidebar land here.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    const onSend = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text === 'string' && text.trim()) sendRef.current(text.trim());
    };
    const onPrefill = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text === 'string') composerRef.current?.setText(text);
    };
    window.addEventListener('uv:send', onSend);
    window.addEventListener('uv:prefill', onPrefill);
    return () => {
      window.removeEventListener('uv:send', onSend);
      window.removeEventListener('uv:prefill', onPrefill);
    };
  }, []);

  const liveSteps = useMemo(() => stepsFromLive(live.tools), [live.tools]);
  const runningStep = liveSteps.find((s) => s.status === 'running');
  const convTasks = useMemo(
    () => teamTasks.filter((t) => t.conversationId && t.conversationId === chat.conversationId),
    [teamTasks, chat.conversationId]
  );
  const teamBusy = convTasks.some((t) => ['queued', 'pending', 'running'].includes(t.status));
  const working = streaming || consolidating;

  useEffect(() => {
    onWorkingChange?.(working || teamBusy);
  }, [working, teamBusy, onWorkingChange]);

  // Keep the reader at the bottom while they are there; offer a jump otherwise.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
      nearBottomRef.current = near;
      setAtBottom(near);
      setScrolled(el.scrollTop > 4);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, live, proposals, convTasks, error]);
  // Opening another thread starts at its end.
  useEffect(() => {
    nearBottomRef.current = true;
  }, [chat.conversationId]);

  const jumpToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const lastUserIndex = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
  const lastUserText = lastUserIndex >= 0 ? (messages[lastUserIndex].content ?? '') : '';
  const pending = useMemo(
    () => proposals.filter((p) => !p.status || p.status === 'pending'),
    [proposals]
  );
  // Each approval sits under the answer that asked for it (matched by the tool
  // record that is waiting); ones from the live turn go after the live answer.
  const placed = useMemo(() => {
    const byMessage = new Map<string, typeof pending>();
    const loose: typeof pending = [];
    const used = new Set<string>();
    for (const p of pending) {
      let ok = false;
      for (let i = messages.length - 1; i >= 0 && !ok; i--) {
        const m = messages[i];
        if (m.role !== 'assistant') continue;
        const rec = (m.toolCallRecords ?? []).find(
          (r) => r.errorCode === 'needs_approval' && r.toolName === p.toolName && !used.has(r.id)
        );
        if (rec) {
          used.add(rec.id);
          byMessage.set(m.id, [...(byMessage.get(m.id) ?? []), p]);
          ok = true;
        }
      }
      if (!ok) loose.push(p);
    }
    return { byMessage, loose };
  }, [pending, messages]);
  // The team card follows the answer that delegated (the latest one with a
  // delegateTask); work delegated in the live turn shows after the live answer.
  const delegatedAt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m.role === 'assistant' &&
        (m.toolCallRecords ?? []).some((r) => r.toolName === 'delegateTask')
      )
        return m.id;
    }
    return null;
  }, [messages]);
  const liveDelegated = live.tools.some((t) => t.name === 'delegateTask');
  const teamCard =
    convTasks.length > 0 ? (
      <TeamRunCard
        tasks={convTasks}
        agentName={agentName}
        onOpenTask={onOpenWorkspace ? () => onOpenWorkspace('team') : undefined}
      />
    ) : null;
  const approvalCards = (list: typeof pending) =>
    list.length > 0 ? (
      <div className="uv-cards">
        {list.map((p) => (
          <ApprovalCard
            key={p.id}
            proposal={p}
            onDecided={chat.onProposalDecided}
            onHandoff={(text) => composerRef.current?.setText(text)}
          />
        ))}
      </div>
    ) : null;
  const isEmpty = messages.length === 0 && !streaming && !loading;
  const principal = agent.kind === 'principal';

  const status = streaming
    ? runningStep
      ? stepLabel(runningStep.name, runningStep.args, true)
      : live.content
        ? 'Escribiendo…'
        : live.reasoning
          ? 'Pensando…'
          : 'Trabajando…'
    : consolidating
      ? 'Revisando las entregas del equipo…'
      : teamBusy
        ? `Tu equipo trabaja en ${convTasks.filter((t) => ['queued', 'pending', 'running'].includes(t.status)).length} tarea(s)`
        : pending.length > 0
          ? `${pending.length} acción${pending.length > 1 ? 'es' : ''} por aprobar`
          : (title ??
            thread?.title ??
            (principal ? 'Dirige a tu equipo' : (agent.purpose ?? 'Especialista')));

  const composer = (
    <Composer
      ref={composerRef}
      onSend={(text, files) => send(text, files)}
      onStop={chat.stop}
      streaming={streaming}
      disabled={loading}
      ensureConversation={chat.ensureConversation}
      conversationId={chat.conversationId}
      canUpload={canUpload}
      canUseVoice={canUseVoice}
      onVoiceMode={() => setVoice(true)}
      placeholder={
        mode === 'mission'
          ? `Describe la misión para ${agent.name}…`
          : `Pídele algo a ${agent.name}…`
      }
      mode={mode}
      onModeChange={setMode}
      model={model}
      onModelChange={setModel}
      onTeach={onTeach}
      autoFocus={isEmpty}
    />
  );

  return (
    <section
      className="uv-chat"
      aria-label={`Conversación con ${agent.name}`}
      data-agent={agent.id}
    >
      <header className={cn('uv-chat-head', scrolled && 'is-scrolled')}>
        {onOpenSidebar && (
          <IconButton
            label="Equipo y conversaciones"
            className="uv-only-mobile"
            onClick={onOpenSidebar}
          >
            <Menu size={18} />
          </IconButton>
        )}
        <AgentAvatar
          agent={agent}
          size="sm"
          status={working || teamBusy ? 'working' : (agent.status ?? 'idle')}
        />
        <div className="uv-chat-title">
          <span className="uv-chat-title-name">
            {agent.name}
            {principal && <span className="uv-tag-chief">Director</span>}
          </span>
          <span
            className={cn('uv-chat-status', (working || teamBusy) && 'is-working')}
            aria-live="polite"
          >
            {(working || teamBusy) && (
              <span className="uv-live-dot is-working" aria-hidden="true" />
            )}
            <span>{status}</span>
          </span>
        </div>
        <div className="uv-head-actions">
          {onNewConversation && (
            <IconButton label="Nueva conversación" onClick={onNewConversation}>
              <SquarePen size={17} />
            </IconButton>
          )}
          {onToggleWorkspace && (
            <IconButton
              label={
                workspaceOpen ? 'Ocultar el espacio de trabajo' : 'Abrir el espacio de trabajo'
              }
              tip={
                <>
                  Espacio de trabajo <span style={{ opacity: 0.6 }}>⌘J</span>
                </>
              }
              on={workspaceOpen}
              aria-pressed={workspaceOpen}
              onClick={onToggleWorkspace}
            >
              <PanelRight size={17} />
              {workspaceBadge && <span className="uv-dot-badge" aria-hidden="true" />}
            </IconButton>
          )}
        </div>
      </header>

      {agents && agents.length > 1 && onSelectAgent && (
        <div className="uv-agent-strip" role="tablist" aria-label="Tu equipo">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={a.id === agent.id}
              className={cn(a.id === agent.id && 'is-active')}
              onClick={() => onSelectAgent(a.id)}
            >
              <AgentAvatar agent={a} size="xs" status={a.status} />
              {a.name}
            </button>
          ))}
        </div>
      )}

      <div
        className="uv-scroll"
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={loading || streaming}
      >
        {loading && (
          <div className="uv-thread" aria-label="Cargando conversación">
            <div
              className="uv-skel"
              style={{ height: 40, width: '46%', alignSelf: 'flex-end', borderRadius: 18 }}
            />
            <div className="uv-skel" style={{ height: 16, width: '30%' }} />
            <div className="uv-skel" style={{ height: 88 }} />
            <div
              className="uv-skel"
              style={{ height: 40, width: '38%', alignSelf: 'flex-end', borderRadius: 18 }}
            />
          </div>
        )}

        {isEmpty && (
          <Welcome
            agent={agent}
            userName={user.name}
            composer={composer}
            onSend={(t) => send(t)}
            onTeam={onNewTeam}
            teamSize={agents?.length ?? 1}
          />
        )}

        {!loading && !isEmpty && (
          <div className="uv-thread">
            {messages.map((m, i) => (
              <React.Fragment key={m.id}>
                <Message
                  message={m}
                  agent={agent}
                  isLatest={i > lastUserIndex && !streaming}
                  onSendText={(t) => send(t)}
                  onEdit={(t) => composerRef.current?.setText(t)}
                  onRegenerate={
                    lastUserText && !lastUserText.startsWith('⟦')
                      ? () => send(lastUserText)
                      : undefined
                  }
                  onOpenWorkspace={onOpenWorkspace}
                />
                {approvalCards(placed.byMessage.get(m.id) ?? [])}
                {m.id === delegatedAt && !liveDelegated && teamCard}
              </React.Fragment>
            ))}

            {!delegatedAt && !liveDelegated && teamCard}

            {consolidating && !streaming && (
              <div className="uv-event" role="status">
                <Loader2 size={14} className="uv-spin" />
                <span>
                  El director está revisando las entregas del equipo y preparando el resultado…
                </span>
              </div>
            )}

            {streaming && (
              <article
                className="uv-msg uv-msg-ai"
                aria-busy="true"
                aria-label={`${agent.name} está respondiendo`}
              >
                <div className="uv-msg-author">
                  <AgentAvatar agent={agent} size="xs" status="working" />
                  <span>{agent.name}</span>
                </div>
                <div className="uv-msg-body">
                  <WorkLog
                    live
                    reasoning={live.reasoning}
                    steps={liveSteps}
                    elapsedMs={live.startedAt ? Date.now() - live.startedAt : undefined}
                    onOpenWorkspace={onOpenWorkspace}
                  />
                  {live.ui.length > 0 && (
                    <Cards components={live.ui} onSendText={(t) => send(t)} interactive />
                  )}
                  {live.content && <Markdown content={live.content} streaming />}
                  {live.artifacts.length > 0 && (
                    <div className="uv-cards">
                      {live.artifacts.map((a) => (
                        <ArtifactCard key={a.artifactId} artifact={a} />
                      ))}
                    </div>
                  )}
                  {!live.content &&
                    !live.reasoning &&
                    liveSteps.length === 0 &&
                    live.ui.length === 0 && (
                      <div className="uv-typing" aria-label="Pensando">
                        <i />
                        <i />
                        <i />
                      </div>
                    )}
                </div>
              </article>
            )}

            {liveDelegated && teamCard}

            {approvalCards(placed.loose)}

            {error && (
              <div
                className={cn('uv-banner', error.info && 'is-info')}
                role={error.info ? 'status' : 'alert'}
              >
                {error.info ? <Loader2 size={15} className="uv-spin" /> : <AlertCircle size={15} />}
                <span>{error.text}</span>
                {error.retry && !streaming && (
                  <button type="button" className="uv-btn is-secondary is-sm" onClick={chat.retry}>
                    <RotateCcw size={13} /> Reintentar
                  </button>
                )}
                {!error.info && (
                  <IconButton
                    label="Cerrar aviso"
                    size="sm"
                    tip={false}
                    onClick={() => chat.setError(null)}
                  >
                    <X size={14} />
                  </IconButton>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {!isEmpty && (
        <div className="uv-composer-dock">
          {!atBottom && (
            <button type="button" className="uv-jump" onClick={jumpToEnd}>
              <ArrowDown size={14} /> Ir al final
            </button>
          )}
          {composer}
          <p className="uv-composer-hint">
            Los agentes piden tu aprobación antes de enviar, pagar o cambiar algo. Verifica la
            información importante.
          </p>
        </div>
      )}

      <AnimatePresence>
        {voice && (
          <VoiceMode
            conversationId={chat.conversationId}
            context={context}
            onClose={() => {
              setVoice(false);
              chat.reload();
            }}
            onConversationCreated={(id) => onConversationCreated?.(id)}
            user={{
              id: user.id,
              name: user.name,
              username: user.username,
              isSuperAdmin: user.isSuperAdmin,
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

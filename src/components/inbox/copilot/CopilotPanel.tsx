'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Flag,
  Hand,
  Import,
  ListChecks,
  Loader2,
  MessageSquareReply,
  Pause,
  Search,
  SendHorizontal,
  ShieldAlert,
  Sparkles,
  Square,
  StickyNote,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { AssistantMarkdown } from '@/components/assistant/AssistantMarkdown';
import { apiJson, type CommConversationDTO, type InboxUserInfo } from '../inbox-types';
import {
  autoKind,
  MODE_META,
  parseDraft,
  parseSuggestedActions,
  toolLabel,
  type ActionKind,
  type CopilotMessage,
  type CopilotMode,
  type CopilotProposal,
  type DraftData,
  type LiveStep,
  type SuggestedActionsData,
} from './copilot-types';

interface Props {
  conversation: CommConversationDTO;
  user: InboxUserInfo;
  onInsertDraft: (text: string) => void;
  onRefreshConversation: () => void;
  onBack?: () => void;
}

type TurnPayload = { message: string } | { trigger: 'open' | 'inbound' };

const STARTERS = [
  'Analiza esta conversación',
  '¿Qué le respondo?',
  'Resume lo que pide el cliente',
  'Revisa su expediente en Zoho',
];

const KIND_ICON: Record<ActionKind, React.ReactNode> = {
  reply: <MessageSquareReply size={13} />,
  task: <ListChecks size={13} />,
  lookup: <Search size={13} />,
  status: <Flag size={13} />,
  note: <StickyNote size={13} />,
  escalate: <ArrowUpRight size={13} />,
  send: <SendHorizontal size={13} />,
  other: <Sparkles size={13} />,
};

const EFFECT_LABELS: Record<string, string> = {
  external_send: 'Envío al cliente',
  business_write: 'Cambio comercial',
  destructive: 'Acción destructiva',
  internal_task: 'Tarea interna',
};

const spring = { type: 'spring', stiffness: 420, damping: 32, mass: 0.6 } as const;

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function Orb({ state }: { state: 'idle' | 'thinking' | 'paused' }) {
  return (
    <span className={cn('copilot-orb', `is-${state}`)} aria-hidden="true">
      <Sparkles size={14} />
    </span>
  );
}

function ModeSwitch({
  mode,
  onChange,
  busy,
}: {
  mode: CopilotMode;
  onChange: (m: CopilotMode) => void;
  busy: boolean;
}) {
  const items: Array<{ value: CopilotMode; icon: React.ReactNode }> = [
    { value: 'active', icon: <Zap size={13} /> },
    { value: 'on_demand', icon: <Hand size={13} /> },
    { value: 'paused', icon: <Pause size={13} /> },
  ];
  return (
    <div className="copilot-mode" role="radiogroup" aria-label="Modo del copiloto">
      {items.map((it) => {
        const active = it.value === mode;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${MODE_META[it.value].label} — ${MODE_META[it.value].hint}`}
            className={cn('copilot-mode-btn', active && 'is-active', `is-${it.value}`)}
            disabled={busy}
            onClick={() => onChange(it.value)}
          >
            {active && (
              <motion.span layoutId="copilot-mode-pill" className="copilot-mode-pill" transition={spring} />
            )}
            <span className="copilot-mode-icon">{it.icon}</span>
            {active && <span className="copilot-mode-label">{MODE_META[it.value].label}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ActionChips({
  data,
  onPick,
  disabled,
  muted,
}: {
  data: SuggestedActionsData;
  onPick: (instruction: string) => void;
  disabled: boolean;
  muted?: boolean;
}) {
  return (
    <div className={cn('copilot-actions', muted && 'is-muted')}>
      {data.situation && (
        <div className="copilot-situation">
          <span className={cn('copilot-urgency', `is-${data.urgency}`)} title={`Urgencia ${data.urgency}`} />
          <span>{data.situation}</span>
          <span className={cn('copilot-sentiment', `is-${data.sentiment}`)}>{data.sentiment}</span>
        </div>
      )}
      <div className="copilot-chips">
        {data.actions.map((a, i) => (
          <motion.button
            key={`${i}-${a.label}`}
            type="button"
            className={cn('copilot-chip', `is-${a.kind}`)}
            disabled={disabled}
            onClick={() => onPick(a.instruction)}
            title={a.instruction}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ ...spring, delay: i * 0.045 }}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
          >
            <span className="copilot-chip-icon">{KIND_ICON[a.kind] ?? KIND_ICON.other}</span>
            {a.label}
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function DraftCard({ draft, onInsert }: { draft: DraftData; onInsert: (text: string) => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft.draft);
      toast.success('Borrador copiado');
    } catch {
      toast.error('No se pudo copiar');
    }
  };
  return (
    <motion.div
      className="copilot-draft"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
      <div className="copilot-draft-head">
        <MessageSquareReply size={13} />
        <span>Respuesta propuesta</span>
        {draft.rationale && <span className="copilot-draft-rationale">· {draft.rationale}</span>}
      </div>
      <div className="copilot-draft-body">{draft.draft}</div>
      <div className="copilot-draft-actions">
        <button type="button" className="copilot-btn copilot-btn-ghost" onClick={copy}>
          <Copy size={13} /> Copiar
        </button>
        <button
          type="button"
          className="copilot-btn copilot-btn-primary"
          onClick={() => {
            onInsert(draft.draft);
            toast.success('Insertado en el redactor');
          }}
        >
          <Import size={13} /> Insertar en el redactor
        </button>
      </div>
    </motion.div>
  );
}

function Steps({ steps }: { steps: LiveStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="copilot-steps">
      {steps.map((s) => (
        <motion.span
          key={s.id}
          className={cn('copilot-step', `is-${s.status}`)}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={spring}
        >
          {s.status === 'running' ? (
            <Loader2 size={11} className="copilot-spin" />
          ) : s.status === 'done' ? (
            <Check size={11} />
          ) : (
            <X size={11} />
          )}
          {toolLabel(s.name, s.status)}
        </motion.span>
      ))}
    </div>
  );
}

function ProposalCard({
  proposal,
  onDecided,
}: {
  proposal: CopilotProposal;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [open, setOpen] = useState(false);
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    try {
      const data = await apiJson<{
        proposal: CopilotProposal;
        execution?: { success: boolean; error?: string; uncertain?: boolean };
      }>(`/app/inbox/api/copilot/proposals/${proposal.id}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      if (decision === 'approve') {
        if (data.execution?.success) toast.success('Acción ejecutada');
        else if (data.execution?.uncertain) toast.warning('Sin confirmación del proveedor; se actualizará solo');
        else toast.error(data.execution?.error ?? 'La acción falló');
      } else {
        toast.message('Propuesta rechazada');
      }
      onDecided();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo procesar');
      onDecided();
    } finally {
      setBusy(null);
    }
  };
  return (
    <motion.div
      className="copilot-proposal"
      role="group"
      aria-label="Acción pendiente de aprobación"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
      <div className="copilot-proposal-head">
        <ShieldAlert size={14} />
        <span>Necesita tu aprobación</span>
        <span className="copilot-proposal-effect">{EFFECT_LABELS[proposal.effect] ?? proposal.effect}</span>
      </div>
      <div className="copilot-proposal-summary">{proposal.summary}</div>
      {proposal.args !== undefined && (
        <button type="button" className="copilot-link" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Ver detalle exacto
        </button>
      )}
      {open && <pre className="copilot-pre">{JSON.stringify(proposal.args, null, 2)}</pre>}
      <div className="copilot-draft-actions">
        <button
          type="button"
          className="copilot-btn copilot-btn-ghost"
          disabled={busy !== null}
          onClick={() => decide('reject')}
        >
          {busy === 'reject' ? <Loader2 size={13} className="copilot-spin" /> : <X size={13} />} Rechazar
        </button>
        <button
          type="button"
          className="copilot-btn copilot-btn-primary"
          disabled={busy !== null}
          onClick={() => decide('approve')}
        >
          {busy === 'approve' ? <Loader2 size={13} className="copilot-spin" /> : <Check size={13} />} Aprobar
        </button>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function CopilotPanel({ conversation, user, onInsertDraft, onRefreshConversation, onBack }: Props) {
  const [mode, setMode] = useState<CopilotMode>('active');
  const [modeBusy, setModeBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [proposals, setProposals] = useState<CopilotProposal[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [liveActions, setLiveActions] = useState<SuggestedActionsData | null>(null);
  const [liveDraft, setLiveDraft] = useState<DraftData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingTrigger = useRef<'open' | 'inbound' | null>(null);
  const streamingRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const conversationId = conversation.id;

  const loadThread = useCallback(async () => {
    const data = await apiJson<{
      conversationId: string;
      mode: CopilotMode;
      messages: CopilotMessage[];
      proposals: CopilotProposal[];
    }>(`/app/inbox/api/conversations/${conversationId}/copilot`);
    setMessages(data.messages);
    setProposals(data.proposals);
    setMode(data.mode);
    return data;
  }, [conversationId]);

  const runTurn = useCallback(
    async (payload: TurnPayload) => {
      if (streamingRef.current) {
        if ('trigger' in payload) pendingTrigger.current = payload.trigger;
        return;
      }
      setError(null);
      if ('message' in payload) {
        setMessages((prev) => [
          ...prev,
          { id: `temp-${Date.now()}`, role: 'user', content: payload.message, createdAt: new Date().toISOString() },
        ]);
      }
      streamingRef.current = true;
      setStreaming(true);
      setStreamText('');
      setLiveSteps([]);
      setLiveActions(null);
      setLiveDraft(null);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/app/inbox/api/conversations/${conversationId}/copilot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
          if (data.code === 'paused') setMode('paused');
          else setError(data.error ?? `Error ${res.status}`);
          return;
        }
        if (!type.includes('text/event-stream') || !res.body) {
          // Skipped trigger (up to date / mode) — nothing to render.
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';
        let stepSeq = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (!frame.startsWith('data: ')) continue;
            let event: { type: string; data?: Record<string, unknown> };
            try {
              event = JSON.parse(frame.slice(6));
            } catch {
              continue;
            }
            const d = event.data ?? {};
            if (event.type === 'token' && typeof d.delta === 'string') {
              text += d.delta;
              setStreamText(text);
            } else if (event.type === 'tool_call_start') {
              const name = String(d.name ?? '');
              stepSeq += 1;
              const id = `${name}-${stepSeq}`;
              if (name === 'suggestNextActions') {
                const parsed = parseSuggestedActions(d.args);
                if (parsed) setLiveActions(parsed);
              } else if (name === 'proposeInboxDraft') {
                const parsed = parseDraft(d.args);
                if (parsed) setLiveDraft(parsed);
              }
              if (name !== 'suggestNextActions') {
                setLiveSteps((prev) => [...prev, { id, name, status: 'running' }]);
              }
            } else if (event.type === 'tool_call_end') {
              const name = String(d.name ?? '');
              setLiveSteps((prev) => {
                const idx = prev.findIndex((s) => s.name === name && s.status === 'running');
                if (idx < 0) return prev;
                const next = [...prev];
                next[idx] = { ...next[idx], status: d.success ? 'done' : 'failed' };
                return next;
              });
              if (name === 'proposeInboxDraft' && !d.success) setLiveDraft(null);
            } else if (event.type === 'proposal') {
              const p = d as unknown as CopilotProposal;
              setProposals((prev) => [...prev.filter((x) => x.id !== p.id), p]);
            } else if (event.type === 'error') {
              setError(typeof d.message === 'string' ? d.message : 'Error desconocido');
            }
          }
        }
        await loadThread().catch(() => undefined);
        onRefreshConversation();
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError(e instanceof Error ? e.message : 'Error de conexión');
        }
      } finally {
        streamingRef.current = false;
        setStreaming(false);
        setStreamText('');
        setLiveSteps([]);
        setLiveActions(null);
        setLiveDraft(null);
        abortRef.current = null;
        const queued = pendingTrigger.current;
        pendingTrigger.current = null;
        if (queued && modeRef.current === 'active') void runTurn({ trigger: queued });
      }
    },
    [conversationId, loadThread, onRefreshConversation]
  );

  // Latest callbacks in refs so the mount/inbound effects run exactly once per event.
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;
  const loadThreadRef = useRef(loadThread);
  loadThreadRef.current = loadThread;

  // Load the thread on open; in active mode, analyze right away (once).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setMessages([]);
    setProposals([]);
    loadThreadRef
      .current()
      .then((data) => {
        if (!alive) return;
        if (data.mode === 'active') void runTurnRef.current({ trigger: 'open' });
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : 'No se pudo cargar el copiloto'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, [conversationId]);

  // A new customer message arrived while this conversation is open.
  const lastInbound = conversation.lastInboundAt;
  const seenInbound = useRef(lastInbound);
  useEffect(() => {
    if (seenInbound.current === lastInbound) return;
    seenInbound.current = lastInbound;
    if (lastInbound && modeRef.current === 'active') void runTurnRef.current({ trigger: 'inbound' });
  }, [lastInbound]);

  // Keep the thread pinned to the bottom while it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, liveSteps, liveActions, liveDraft, proposals]);

  const changeMode = async (next: CopilotMode) => {
    if (next === mode) return;
    setModeBusy(true);
    try {
      const data = await apiJson<{ mode: CopilotMode }>('/app/inbox/api/copilot/mode', {
        method: 'PATCH',
        body: JSON.stringify({ mode: next }),
      });
      setMode(data.mode);
      if (data.mode === 'paused') abortRef.current?.abort();
      if (data.mode === 'active') void runTurn({ trigger: 'open' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cambiar el modo');
    } finally {
      setModeBusy(false);
    }
  };

  const send = (text: string) => {
    const clean = text.trim();
    if (!clean || mode === 'paused') return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void runTurn({ message: clean });
  };

  const stop = () => abortRef.current?.abort();

  /* ---------------- derived view model ---------------- */

  const items = useMemo(() => {
    let lastActionsIdx = -1;
    messages.forEach((m, i) => {
      if (m.role === 'assistant' && m.toolCallRecords?.some((r) => r.toolName === 'suggestNextActions')) {
        lastActionsIdx = i;
      }
    });
    return messages
      .map((m, i) => {
        if (m.role === 'tool') return null;
        if (m.role === 'system') return { kind: 'system' as const, id: m.id, text: m.content ?? '' };
        if (m.role === 'user') {
          const auto = autoKind(m.content);
          if (auto) return { kind: 'event' as const, id: m.id, auto };
          return { kind: 'user' as const, id: m.id, text: m.content ?? '' };
        }
        const records = m.toolCallRecords ?? [];
        const actionsRecord = records.find((r) => r.toolName === 'suggestNextActions');
        const actions = actionsRecord ? parseSuggestedActions(actionsRecord.args) : null;
        const drafts = records
          .filter((r) => r.toolName === 'proposeInboxDraft' && r.success)
          .map((r) => parseDraft(r.args))
          .filter((d): d is DraftData => Boolean(d));
        const steps: LiveStep[] = records
          .filter((r) => r.toolName !== 'suggestNextActions' && r.toolName !== 'proposeInboxDraft')
          .map((r) => ({ id: r.id, name: r.toolName, status: r.success ? 'done' : 'failed' }));
        const text = (m.content ?? '').trim();
        if (!text && !actions && drafts.length === 0 && steps.length === 0) return null;
        return {
          kind: 'assistant' as const,
          id: m.id,
          text,
          steps,
          actions,
          actionsCurrent: i === lastActionsIdx,
          drafts,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [messages]);

  const pendingProposals = proposals.filter((p) => !p.status || p.status === 'pending');
  const isEmpty = items.length === 0 && !streaming && !loading;
  const orbState: 'idle' | 'thinking' | 'paused' = mode === 'paused' ? 'paused' : streaming ? 'thinking' : 'idle';
  const statusText =
    mode === 'paused'
      ? 'En pausa'
      : streaming
        ? liveSteps.some((s) => s.status === 'running')
          ? toolLabel(liveSteps.filter((s) => s.status === 'running').slice(-1)[0]!.name, 'running')
          : 'Pensando…'
        : mode === 'active'
          ? 'Atento a la conversación'
          : 'Listo cuando me necesites';

  return (
    <div className={cn('copilot', `mode-${mode}`)}>
      <header className="copilot-header">
        {onBack && (
          <button type="button" className="copilot-iconbtn" onClick={onBack} aria-label="Volver a la conversación">
            <ArrowLeft size={16} />
          </button>
        )}
        <Orb state={orbState} />
        <div className="copilot-title">
          <strong>Copiloto</strong>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={statusText}
              className="copilot-status"
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.18 }}
            >
              {statusText}
            </motion.span>
          </AnimatePresence>
        </div>
        <ModeSwitch mode={mode} onChange={changeMode} busy={modeBusy} />
      </header>

      <div ref={scrollRef} className="copilot-thread" role="log" aria-live="polite">
        {loading && <div className="copilot-muted copilot-center">Cargando…</div>}

        {isEmpty && mode === 'paused' && (
          <div className="copilot-empty">
            <Pause size={22} />
            <p>Copiloto en pausa. No analizaré ni haré nada hasta que lo reactives.</p>
          </div>
        )}
        {isEmpty && mode === 'on_demand' && (
          <div className="copilot-empty">
            <Sparkles size={22} />
            <p>Estoy aquí. Pídeme que analice, dime qué responder o dame instrucciones.</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {items.map((it) => {
            if (it.kind === 'event') {
              return (
                <motion.div
                  key={it.id}
                  className="copilot-event"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                >
                  <span />
                  {it.auto === 'open' ? 'Analicé la conversación al abrirla' : 'El cliente escribió · reanalicé'}
                  <span />
                </motion.div>
              );
            }
            if (it.kind === 'system') {
              return (
                <motion.div key={it.id} className="copilot-event" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <span />
                  {it.text.replace(/^\[Sistema\]\s*/, '')}
                  <span />
                </motion.div>
              );
            }
            if (it.kind === 'user') {
              return (
                <motion.div
                  key={it.id}
                  className="copilot-row is-user"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={spring}
                >
                  <div className="copilot-bubble is-user">{it.text}</div>
                </motion.div>
              );
            }
            return (
              <motion.div
                key={it.id}
                className="copilot-row is-assistant"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring}
              >
                <Steps steps={it.steps} />
                {it.text && (
                  <div className="copilot-bubble is-assistant">
                    <AssistantMarkdown content={it.text} />
                  </div>
                )}
                {it.drafts.map((d, i) => (
                  <DraftCard key={`${it.id}-draft-${i}`} draft={d} onInsert={onInsertDraft} />
                ))}
                {it.actions && (
                  <ActionChips
                    data={it.actions}
                    onPick={send}
                    disabled={streaming || mode === 'paused'}
                    muted={!it.actionsCurrent}
                  />
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>

        {streaming && (
          <motion.div className="copilot-row is-assistant" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Steps steps={liveSteps} />
            {streamText ? (
              <div className="copilot-bubble is-assistant copilot-streaming">{streamText}</div>
            ) : liveSteps.length === 0 ? (
              <div className="copilot-bubble is-assistant copilot-typing">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {liveDraft && <DraftCard draft={liveDraft} onInsert={onInsertDraft} />}
            {liveActions && <ActionChips data={liveActions} onPick={send} disabled />}
          </motion.div>
        )}

        {pendingProposals.map((p) => (
          <ProposalCard key={p.id} proposal={p} onDecided={() => void loadThread().catch(() => undefined)} />
        ))}

        {error && (
          <div className="copilot-error" role="alert">
            {error}
          </div>
        )}
      </div>

      <div className="copilot-footer">
        {isEmpty && mode !== 'paused' && (
          <div className="copilot-starters">
            {STARTERS.map((s, i) => (
              <motion.button
                key={s}
                type="button"
                className="copilot-chip is-starter"
                onClick={() => send(s)}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring, delay: 0.05 + i * 0.04 }}
              >
                {s}
              </motion.button>
            ))}
          </div>
        )}
        <div className={cn('copilot-composer', mode === 'paused' && 'is-disabled')}>
          <textarea
            ref={textareaRef}
            className="copilot-input"
            rows={1}
            value={input}
            disabled={mode === 'paused'}
            placeholder={
              mode === 'paused'
                ? 'Copiloto en pausa'
                : `Dime qué hacer, ${user.name.split(' ')[0]}… (Enter para enviar)`
            }
            aria-label="Mensaje para el copiloto"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          {streaming ? (
            <button type="button" className="copilot-send is-stop" onClick={stop} aria-label="Detener">
              <Square size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="copilot-send"
              onClick={() => send(input)}
              disabled={!input.trim() || mode === 'paused'}
              aria-label="Enviar"
            >
              <SendHorizontal size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

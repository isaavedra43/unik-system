'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock,
  Copy,
  Flag,
  Import,
  ListChecks,
  Loader2,
  MessageSquareReply,
  Pause,
  Search,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Square,
  StickyNote,
  X,
  Pencil,
  Phone,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { AssistantMarkdown } from '@/components/assistant/AssistantMarkdown';
import { ArtifactRenderer, type ArtifactData } from '@/components/assistant/ArtifactRenderer';
import { ProposalCard } from './ProposalCard';
import { PlanCard } from './PlanCard';
import { ConfidenceBadge } from './ConfidenceBadge';
import { MessageFeedback } from './MessageFeedback';
import { parseConfidence } from '@/modules/ai/confidence';
import { VoiceDictationButton } from '@/components/voice/VoiceDictationButton';
import {
  AI_SETTINGS_HREF,
  autoKind,
  MODE_META,
  parseDraft,
  parseSuggestedActions,
  toolLabel,
  type ActionKind,
  type CopilotMessage,
  parsePlan,
  AUTO_EVENT_LABELS,
  extractFailureReason,
  extractResultAction,
  performUiAction,
  uiActionFromResult,
  type UiAction,
  type CopilotMode,
  type CopilotProposal,
  type DraftData,
  type LiveStep,
  type SuggestedActionsData,
} from './copilot-types';

/**
 * ONE copilot panel for every surface (inbox conversation, internal chat
 * channel…). The host only says where its API lives, what it sits next to and
 * how to insert a draft into its composer. Mode is configured in
 * "Asistente IA → Preferencias y memoria" and shown here read-only.
 */
export interface CopilotSurfaceConfig {
  surfaceId: string;
  /** Unified preference that stores this surface's proactivity (one config for every surface). */
  preferenceKey: 'inboxCopilotMode' | 'chatCopilotMode';
  endpoints: {
    thread: string;
    proposal: (proposalId: string) => string;
  };
  activityAt: string | null;
  draftTool: string;
  starters: string[];
  copy: {
    eventOpen: string;
    eventInbound: string;
    statusActive: string;
    emptyOnDemand: string;
    emptyPaused: string;
  };
}

export interface CopilotPanelProps {
  surface: CopilotSurfaceConfig;
  user: { id: string; name: string };
  onInsertDraft?: (text: string) => void;
  /** Sends the (possibly edited) draft straight from the card — the click is the approval. */
  onSendDraft?: (text: string) => Promise<void>;
  onAfterTurn?: () => void;
  onBack?: () => void;
}

type TurnPayload = { message: string } | { trigger: 'open' | 'inbound' } | { trigger: 'action_failed'; detail: { tool: string; error: string } };

async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return data;
}

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

const spring = { type: 'spring', stiffness: 420, damping: 32, mass: 0.6 } as const;

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Orb({ state }: { state: 'idle' | 'thinking' | 'paused' }) {
  return (
    <span className={cn('copilot-orb', `is-${state}`)} aria-hidden="true">
      <Sparkles size={15} />
    </span>
  );
}

/**
 * Mode badge with an in-place menu. It writes the SAME unified preference the
 * "Asistente IA → Preferencias y memoria" screen edits, so there is still one
 * configuration — this is only a shortcut for this surface.
 */
function ModeBadge({ mode, onChange, busy }: { mode: CopilotMode; onChange: (mode: CopilotMode) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className="copilot-mode-menu" ref={ref}>
      <button
        type="button"
        className={cn('copilot-mode-badge', `is-${mode}`)}
        title={`${MODE_META[mode].label} — ${MODE_META[mode].hint} Clic para cambiar.`}
        aria-label="Cambiar el modo del copiloto"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        {mode === 'paused' ? <Pause size={12} /> : <Settings2 size={12} />}
        <span>{MODE_META[mode].label}</span>
      </button>
      {open && (
        <div className="copilot-mode-pop" role="menu" aria-label="Modo del copiloto en esta superficie">
          {(Object.keys(MODE_META) as CopilotMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              className={cn('copilot-mode-option', m === mode && 'is-current')}
              onClick={() => {
                setOpen(false);
                if (m !== mode) onChange(m);
              }}
            >
              <span className="copilot-mode-option-label">{MODE_META[m].label}</span>
              <span className="copilot-mode-option-hint">{MODE_META[m].hint}</span>
            </button>
          ))}
          <Link href={AI_SETTINGS_HREF} className="copilot-mode-more">
            <Settings2 size={12} /> Todas las preferencias de la IA
          </Link>
        </div>
      )}
    </div>
  );
}

function ActionChips({ data, onPick, disabled, muted }: { data: SuggestedActionsData; onPick: (instruction: string) => void; disabled: boolean; muted?: boolean }) {
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

function DraftCard({ draft, onInsert, onSend }: { draft: DraftData; onInsert?: (text: string) => void; onSend?: (text: string) => Promise<void> }) {
  const [text, setText] = useState(draft.draft);
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Borrador copiado');
    } catch {
      toast.error('No se pudo copiar');
    }
  };
  const send = async () => {
    if (!onSend || !text.trim()) return;
    setSending(true);
    try {
      await onSend(text.trim());
      setSent(true);
      toast.success('Mensaje enviado');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo enviar');
    } finally {
      setSending(false);
    }
  };
  return (
    <motion.div className={cn('copilot-draft', sent && 'is-sent')} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className="copilot-draft-head">
        <MessageSquareReply size={13} />
        <span>{sent ? 'Enviado al cliente' : 'Respuesta propuesta'}</span>
        {draft.rationale && !sent && <span className="copilot-draft-rationale">· {draft.rationale}</span>}
      </div>
      {editing && !sent ? (
        <textarea className="copilot-draft-edit" value={text} rows={Math.min(12, Math.max(3, text.split('\n').length + 1))} onChange={(e) => setText(e.target.value)} aria-label="Editar borrador" />
      ) : (
        <div className="copilot-draft-body">{text}</div>
      )}
      {!sent && (
        <div className="copilot-draft-actions">
          <button type="button" className="copilot-btn copilot-btn-ghost" onClick={copy}>
            <Copy size={13} /> Copiar
          </button>
          <button type="button" className="copilot-btn copilot-btn-ghost" onClick={() => setEditing((v) => !v)}>
            <Pencil size={13} /> {editing ? 'Listo' : 'Editar'}
          </button>
          {onInsert && (
            <button
              type="button"
              className="copilot-btn copilot-btn-ghost"
              onClick={() => {
                onInsert(text);
                toast.success('Insertado en el redactor');
              }}
            >
              <Import size={13} /> Al redactor
            </button>
          )}
          {onSend && (
            <button type="button" className="copilot-btn copilot-btn-primary" disabled={sending || !text.trim()} onClick={() => void send()}>
              {sending ? <Loader2 size={13} className="copilot-spin" /> : <SendHorizontal size={13} />} Enviar
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

function Steps({ steps }: { steps: LiveStep[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (steps.length === 0) return null;
  const detail = open ? steps.find((s) => s.id === open)?.detail : null;
  return (
    <div className="copilot-steps">
      {steps.map((s) => (
        <motion.span
          key={s.id}
          className={cn('copilot-step', `is-${s.status}`, s.detail && 'has-detail', open === s.id && 'is-open')}
          title={s.detail ?? undefined}
          role={s.detail ? 'button' : undefined}
          tabIndex={s.detail ? 0 : undefined}
          onClick={() => s.detail && setOpen((v) => (v === s.id ? null : s.id))}
          onKeyDown={(e) => {
            if (s.detail && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              setOpen((v) => (v === s.id ? null : s.id));
            }
          }}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          transition={spring}
        >
          {s.status === 'running' ? <Loader2 size={11} className="copilot-spin" /> : s.status === 'done' ? <Check size={11} /> : s.status === 'pending' ? <Clock size={11} /> : <X size={11} />}
          {s.status === 'pending' ? `${toolLabel(s.name, 'done')} · esperando tu aprobación` : toolLabel(s.name, s.status === 'running' ? 'running' : 'done')}
        </motion.span>
      ))}
      {detail && <div className="copilot-step-detail">{detail}</div>}
    </div>
  );
}

/** "[Sistema] El usuario APROBÓ la propuesta … : ejecutada correctamente. Acción: … Resultado: {…}" → human event. */
function parseSystemEvent(text: string): { kind: 'approved' | 'rejected' | 'other'; title: string; detail: string | null; failed: boolean } {
  const clean = text.replace(/^\[Sistema\]\s*/, '');
  const approved = /APROBÓ/.test(clean);
  const rejected = /RECHAZÓ/.test(clean);
  const failed = /fall[oó]:/i.test(clean);
  const action = /Acción:\s*([^]*?)(?:\s+Resultado:|$)/.exec(clean)?.[1]?.trim() ?? null;
  const reason = failed ? extractFailureReason(clean) : null;
  if (approved) return { kind: 'approved', title: failed ? 'Aprobaste la acción, pero falló' : /incierto/.test(clean) ? 'Aprobaste la acción · resultado por confirmar' : 'Aprobaste la acción · ejecutada', detail: failed && reason ? `${reason}${action ? ` — ${action}` : ''}` : action, failed };
  if (rejected) return { kind: 'rejected', title: 'Rechazaste la acción', detail: /RECHAZÓ la propuesta [^\s]+ \([^)]+\)(?::\s*(.*))?/.exec(clean)?.[1] ?? null, failed: false };
  return { kind: 'other', title: clean, detail: null, failed: false };
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function CopilotPanel({ surface, user, onInsertDraft, onSendDraft, onAfterTurn, onBack }: CopilotPanelProps) {
  const [mode, setMode] = useState<CopilotMode>('active');
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [proposals, setProposals] = useState<CopilotProposal[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [liveActions, setLiveActions] = useState<SuggestedActionsData | null>(null);
  const [liveDraft, setLiveDraft] = useState<DraftData | null>(null);
  const [liveArtifacts, setLiveArtifacts] = useState<ArtifactData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingTrigger = useRef<'open' | 'inbound' | null>(null);
  const streamingRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const threadUrl = surface.endpoints.thread;
  const draftTool = surface.draftTool;
  const onAfterTurnRef = useRef(onAfterTurn);
  onAfterTurnRef.current = onAfterTurn;

  const loadThread = useCallback(async () => {
    const data = await apiJson<{ conversationId: string; mode: CopilotMode; messages: CopilotMessage[]; proposals: CopilotProposal[] }>(threadUrl);
    setMessages(data.messages);
    setProposals(data.proposals);
    setMode(data.mode);
    return data;
  }, [threadUrl]);

  const runTurn = useCallback(
    async (payload: TurnPayload) => {
      if (streamingRef.current) {
        if ('trigger' in payload && payload.trigger !== 'action_failed') pendingTrigger.current = payload.trigger;
        return;
      }
      setError(null);
      if ('message' in payload) {
        setMessages((prev) => [...prev, { id: `temp-${Date.now()}`, role: 'user', content: payload.message, createdAt: new Date().toISOString() }]);
      }
      streamingRef.current = true;
      setStreaming(true);
      setStreamText('');
      setLiveSteps([]);
      setLiveActions(null);
      setLiveDraft(null);
      setLiveArtifacts([]);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(threadUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
          if (data.code === 'paused') setMode('paused');
          else setError(data.error ?? `Error ${res.status}`);
          return;
        }
        if (!type.includes('text/event-stream') || !res.body) return;
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
              } else if (name === draftTool) {
                const parsed = parseDraft(d.args);
                if (parsed) setLiveDraft(parsed);
              }
              if (name !== 'suggestNextActions') setLiveSteps((prev) => [...prev, { id, name, status: 'running' }]);
            } else if (event.type === 'tool_call_end') {
              const name = String(d.name ?? '');
              const pending = d.needsApproval === true;
              setLiveSteps((prev) => {
                const idx = prev.findIndex((s) => s.name === name && s.status === 'running');
                if (idx < 0) return prev;
                const next = [...prev];
                next[idx] = { ...next[idx], status: pending ? 'pending' : d.success ? 'done' : 'failed', detail: typeof d.error === 'string' ? d.error : next[idx].detail ?? null };
                return next;
              });
              if (name === draftTool && !d.success) setLiveDraft(null);
            } else if (event.type === 'artifact') {
              const a = d as unknown as ArtifactData;
              if (a.artifactId) setLiveArtifacts((prev) => [...prev.filter((x) => x.artifactId !== a.artifactId), a]);
            } else if (event.type === 'proposal') {
              const p = d as unknown as CopilotProposal;
              setProposals((prev) => [...prev.filter((x) => x.id !== p.id), p]);
            } else if (event.type === 'action') {
              performUiAction(d as unknown as UiAction);
            } else if (event.type === 'error') {
              setError(typeof d.message === 'string' ? d.message : 'Error desconocido');
            }
          }
        }
        await loadThread().catch(() => undefined);
        onAfterTurnRef.current?.();
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        streamingRef.current = false;
        setStreaming(false);
        setStreamText('');
        setLiveSteps([]);
        setLiveActions(null);
        setLiveDraft(null);
        setLiveArtifacts([]);
        abortRef.current = null;
        const queued = pendingTrigger.current;
        pendingTrigger.current = null;
        if (queued && modeRef.current === 'active') void runTurn({ trigger: queued });
      }
    },
    [threadUrl, draftTool, loadThread]
  );

  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;
  const loadThreadRef = useRef(loadThread);
  loadThreadRef.current = loadThread;

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
  }, [surface.surfaceId]);

  const activityAt = surface.activityAt;
  const seenActivity = useRef(activityAt);
  useEffect(() => {
    if (seenActivity.current === activityAt) return;
    seenActivity.current = activityAt;
    if (activityAt && modeRef.current === 'active') void runTurnRef.current({ trigger: 'inbound' });
  }, [activityAt]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, liveSteps, liveActions, liveDraft, liveArtifacts, proposals]);

  const send = (text: string) => {
    const clean = text.trim();
    if (!clean || mode === 'paused') return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void runTurn({ message: clean });
  };

  const stop = () => abortRef.current?.abort();

  const decideProposal = useCallback(
    async (proposal: CopilotProposal, decision: 'approve' | 'reject') => {
      const data = await apiJson<{ proposal: CopilotProposal; execution?: { success: boolean; error?: string; uncertain?: boolean; result?: unknown } }>(surface.endpoints.proposal(proposal.id), { method: 'POST', body: JSON.stringify({ decision }) });
      let failedError: string | null = null;
      if (decision === 'approve') {
        if (data.execution?.success) {
          toast.success('Acción ejecutada');
          const action = uiActionFromResult(proposal.toolName, data.execution.result);
          if (action) performUiAction(action);
        } else if (data.execution?.uncertain) toast.warning('Sin confirmación del proveedor; se actualizará solo');
        else {
          failedError = data.execution?.error ?? 'La acción falló';
          toast.error(failedError);
        }
      } else {
        toast.message('Propuesta rechazada');
      }
      setProposals((prev) => prev.filter((p) => p.id !== proposal.id));
      await loadThread().catch(() => undefined);
      onAfterTurnRef.current?.();
      // The copilot reads the error and fixes it on its own (search the right product, adjust data, re-propose).
      if (failedError) void runTurnRef.current({ trigger: 'action_failed', detail: { tool: proposal.toolName, error: failedError } });
      return data.execution;
    },
    [surface.endpoints, loadThread]
  );

  const [modeBusy, setModeBusy] = useState(false);
  const changeMode = useCallback(
    async (next: CopilotMode) => {
      setModeBusy(true);
      try {
        await apiJson('/app/assistant/api/preferences', { method: 'PATCH', body: JSON.stringify({ [surface.preferenceKey]: next }) });
        setMode(next);
        toast.success(`Copiloto: ${MODE_META[next].label}`);
        if (next === 'active') void runTurnRef.current({ trigger: 'open' });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'No se pudo cambiar el modo');
      } finally {
        setModeBusy(false);
      }
    },
    [surface.preferenceKey]
  );

  // Preferences can change in another tab/screen: refresh the mode when the user comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !streamingRef.current) void loadThreadRef.current().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  const items = useMemo(() => {
    let lastActionsIdx = -1;
    messages.forEach((m, i) => {
      if (m.role === 'assistant' && m.toolCallRecords?.some((r) => r.toolName === 'suggestNextActions')) lastActionsIdx = i;
    });
    return messages
      .map((m, i) => {
        if (m.role === 'tool') return null;
        if (m.role === 'system') return { kind: 'system' as const, id: m.id, event: parseSystemEvent(m.content ?? ''), action: extractResultAction(m.content ?? '') };
        if (m.role === 'user') {
          const auto = autoKind(m.content);
          if (auto) return { kind: 'event' as const, id: m.id, auto };
          return { kind: 'user' as const, id: m.id, text: m.content ?? '' };
        }
        const records = m.toolCallRecords ?? [];
        const actionsRecord = records.find((r) => r.toolName === 'suggestNextActions');
        const actions = actionsRecord ? parseSuggestedActions(actionsRecord.args) : null;
        const drafts = records.filter((r) => r.toolName === draftTool && r.success).map((r) => parseDraft(r.args)).filter((d): d is DraftData => Boolean(d));
        const planRecord = records.find((r) => r.toolName === 'proposePlan' && r.success);
        const plan = planRecord ? parsePlan(planRecord.args) : null;
        const steps: LiveStep[] = records
          .filter((r) => r.toolName !== 'suggestNextActions' && r.toolName !== draftTool && r.toolName !== 'proposePlan')
          .map((r) => {
            const resultError = r.result && typeof r.result === 'object' ? (r.result as { error?: unknown }).error : null;
            const detail = !r.success && r.errorCode !== 'needs_approval' ? (typeof resultError === 'string' ? resultError : r.errorCode) : typeof resultError === 'string' ? resultError : null;
            return { id: r.id, name: r.toolName, status: r.errorCode === 'needs_approval' ? 'pending' : r.success && !resultError ? 'done' : r.success ? 'failed' : 'failed', detail } as LiveStep;
          });
        const parsedText = parseConfidence(m.content);
        const text = parsedText.content.trim();
        const artifacts = m.artifacts ?? [];
        if (!text && !actions && drafts.length === 0 && steps.length === 0 && artifacts.length === 0 && !plan) return null;
        return {
          kind: 'assistant' as const,
          id: m.id,
          text,
          steps,
          actions,
          actionsCurrent: i === lastActionsIdx,
          drafts,
          artifacts,
          plan,
          meta: m.meta ?? null,
          feedback: m.feedback ?? null,
          confidence: m.meta?.confidence ?? parsedText.level ?? null,
          confidenceNote: m.meta?.confidenceNote ?? parsedText.note ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [messages, draftTool]);

  const pendingProposals = proposals.filter((p) => !p.status || p.status === 'pending');
  // A proposed plan stays actionable until the user writes something after it.
  const lastUserIndex = items.reduce((acc, it, i) => (it.kind === 'user' ? i : acc), -1);
  const isEmpty = items.length === 0 && !streaming && !loading;
  const orbState: 'idle' | 'thinking' | 'paused' = mode === 'paused' ? 'paused' : streaming ? 'thinking' : 'idle';
  const statusText =
    mode === 'paused'
      ? 'Apagado en esta superficie'
      : streaming
        ? liveSteps.some((s) => s.status === 'running')
          ? toolLabel(liveSteps.filter((s) => s.status === 'running').slice(-1)[0]!.name, 'running')
          : 'Pensando…'
        : mode === 'active'
          ? surface.copy.statusActive
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
            <motion.span key={statusText} className="copilot-status" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18 }}>
              {statusText}
            </motion.span>
          </AnimatePresence>
        </div>
        <ModeBadge mode={mode} onChange={(m) => void changeMode(m)} busy={modeBusy} />
      </header>

      <div ref={scrollRef} className="copilot-thread" role="log" aria-live="polite">
        {loading && <div className="copilot-muted copilot-center">Cargando…</div>}

        {isEmpty && mode === 'paused' && (
          <div className="copilot-empty">
            <Pause size={22} />
            <p>{surface.copy.emptyPaused}</p>
            <Link href={AI_SETTINGS_HREF} className="copilot-link">
              <Settings2 size={12} /> Configurar en Asistente IA
            </Link>
          </div>
        )}
        {isEmpty && mode === 'on_demand' && (
          <div className="copilot-empty">
            <Sparkles size={22} />
            <p>{surface.copy.emptyOnDemand}</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {items.map((it, itemIndex) => {
            if (it.kind === 'event') {
              return (
                <motion.div key={it.id} className="copilot-event" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
                  <span />
                  {it.auto === 'open' ? surface.copy.eventOpen : it.auto === 'inbound' ? surface.copy.eventInbound : AUTO_EVENT_LABELS[it.auto]}
                  <span />
                </motion.div>
              );
            }
            if (it.kind === 'system') {
              const ev = it.event;
              return (
                <motion.div key={it.id} className={cn('copilot-sysevent', `is-${ev.kind}`, ev.failed && 'is-failed')} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                  {ev.kind === 'approved' ? (ev.failed ? <ShieldX size={14} /> : <ShieldCheck size={14} />) : ev.kind === 'rejected' ? <ShieldX size={14} /> : <Sparkles size={14} />}
                  <div>
                    <div className="copilot-sysevent-title">{ev.title}</div>
                    {ev.detail && <div className="copilot-sysevent-detail">{ev.detail}</div>}
                    {ev.kind === 'approved' && !ev.failed && it.action && (
                      <button type="button" className="copilot-btn copilot-btn-primary copilot-sysevent-btn" onClick={() => performUiAction(it.action as UiAction)}>
                        {it.action.kind === 'join_call' ? <><Phone size={13} /> Abrir la llamada</> : <><ExternalLink size={13} /> Abrir</>}
                      </button>
                    )}
                  </div>
                </motion.div>
              );
            }
            if (it.kind === 'user') {
              return (
                <motion.div key={it.id} className="copilot-row is-user" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
                  <div className="copilot-bubble is-user">{it.text}</div>
                </motion.div>
              );
            }
            return (
              <motion.div key={it.id} className="copilot-row is-assistant" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
                <Steps steps={it.steps} />
                {it.text && (
                  <div className="copilot-bubble is-assistant">
                    <AssistantMarkdown content={it.text} />
                  </div>
                )}
                {it.plan && (
                  <PlanCard
                    plan={it.plan}
                    active={itemIndex > lastUserIndex && !streaming && mode !== 'paused'}
                    onRun={send}
                    onAdjust={() => {
                      setInput('Ajusta el plan: ');
                      textareaRef.current?.focus();
                    }}
                  />
                )}
                {it.artifacts.length > 0 && (
                  <div className="copilot-artifacts">
                    {it.artifacts.map((a) => (
                      <ArtifactRenderer key={a.artifactId} artifact={a as ArtifactData} compact />
                    ))}
                  </div>
                )}
                {it.drafts.map((d, i) => (
                  <DraftCard key={`${it.id}-draft-${i}`} draft={d} onInsert={onInsertDraft} onSend={onSendDraft} />
                ))}
                {it.actions && <ActionChips data={it.actions} onPick={send} disabled={streaming || mode === 'paused'} muted={!it.actionsCurrent} />}
                {it.text && (
                  <div className="copilot-msgfoot">
                    <ConfidenceBadge level={it.confidence} note={it.confidenceNote} meta={it.meta} compact />
                    <MessageFeedback messageId={it.id} initial={it.feedback} compact />
                  </div>
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
            {liveArtifacts.length > 0 && (
              <div className="copilot-artifacts">
                {liveArtifacts.map((a) => (
                  <ArtifactRenderer key={a.artifactId} artifact={a} compact />
                ))}
              </div>
            )}
            {liveDraft && <DraftCard draft={liveDraft} onInsert={onInsertDraft} onSend={onSendDraft} />}
            {liveActions && <ActionChips data={liveActions} onPick={send} disabled />}
          </motion.div>
        )}

        {pendingProposals.map((p) => (
          <ProposalCard key={p.id} proposal={p} decide={(decision) => decideProposal(p, decision)} />
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
            {surface.starters.map((s, i) => (
              <motion.button key={s} type="button" className="copilot-chip is-starter" onClick={() => send(s)} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.05 + i * 0.04 }}>
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
            placeholder={mode === 'paused' ? 'Copiloto apagado en esta superficie' : `Dime qué hacer, ${user.name.split(' ')[0]}… (Enter para enviar)`}
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
          {mode !== 'paused' && !streaming && (
            <VoiceDictationButton
              className="copilot-dictate"
              iconSize={15}
              title="Dictar por voz"
              onFinalTranscript={(t) => setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${t}` : t))}
              onStart={() => textareaRef.current?.focus()}
            />
          )}
          {streaming ? (
            <button type="button" className="copilot-send is-stop" onClick={stop} aria-label="Detener">
              <Square size={14} />
            </button>
          ) : (
            <button type="button" className="copilot-send" onClick={() => send(input)} disabled={!input.trim() || mode === 'paused'} aria-label="Enviar">
              <SendHorizontal size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

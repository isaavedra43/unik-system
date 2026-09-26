'use client';

import React, { memo, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Cpu,
  ExternalLink,
  FileText,
  HelpCircle,
  Image as ImageIcon,
  Loader2,
  PencilLine,
  Phone,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldX,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  AUTO_EVENT_LABELS,
  autoKind,
  extractFailureReason,
  extractResultAction,
  parseMission,
  parsePlan,
  performUiAction,
} from '@/components/copilot/copilot-types';
import { parseConfidence, CONFIDENCE_META } from '@/modules/ai/confidence';
import { parseFollowUps } from '@/modules/ai/followups';
import { buildUiComponents } from '@/modules/ai/generative-ui/build-ui';
import type { AgentInfo, MessageData, WorkspaceTab } from '../lib/types';
import { clockTime, formatBytes, formatDuration } from '../lib/format';
import { EFFORT_LEVELS } from '@/modules/ai/effort-levels';
import { AgentAvatar } from '../ui';
import { Markdown } from './Markdown';
import { WorkLog, stepsFromRecords } from './WorkLog';
import { Cards } from '../cards/Cards';
import { ArtifactCard } from '../cards/ArtifactCard';
import { AgentReportCard, MissionCard, PlanCard, RoutineNote } from '../cards/Agentic';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/shadcn/tooltip';

/**
 * One message of the thread. User: a bubble. Agent: author line → work log
 * (reasoning + steps) → cards drawn from real tool results → prose → plan /
 * mission / files → follow-ups → actions (copy, 👍/👎, retry) and provenance.
 */

export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="uv-icon-btn"
          aria-label={label}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setDone(true);
              window.setTimeout(() => setDone(false), 1400);
            } catch {
              /* clipboard blocked */
            }
          }}
        >
          {done ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{done ? 'Copiado' : label}</TooltipContent>
    </Tooltip>
  );
}

function Feedback({
  messageId,
  initial,
}: {
  messageId: string;
  initial?: MessageData['feedback'];
}) {
  const [rating, setRating] = useState<number | null>(initial?.rating ?? null);
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  if (messageId.startsWith('temp-')) return null;

  const submit = async (next: 1 | -1 | null, text?: string) => {
    setBusy(true);
    setSaved(null);
    try {
      if (next === null) {
        await fetch(`/app/assistant/api/messages/${messageId}/feedback`, { method: 'DELETE' });
        setRating(null);
        setAsk(false);
      } else {
        const res = await fetch(`/app/assistant/api/messages/${messageId}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: next, comment: text ?? null }),
        });
        if (!res.ok) throw new Error('fail');
        setRating(next);
        if (next === -1 && text === undefined) setAsk(true);
        else {
          setAsk(false);
          setSaved(next === 1 ? 'Gracias' : 'Anotado, lo usaremos para mejorar');
          window.setTimeout(() => setSaved(null), 1800);
        }
      }
    } catch {
      setSaved('No se pudo guardar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn('uv-icon-btn', rating === 1 && 'is-on')}
            aria-label="Respuesta útil"
            aria-pressed={rating === 1}
            disabled={busy}
            onClick={() => void submit(rating === 1 ? null : 1)}
          >
            <ThumbsUp size={15} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Útil</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn('uv-icon-btn', rating === -1 && 'is-on')}
            aria-label="Respuesta no útil"
            aria-pressed={rating === -1}
            disabled={busy}
            onClick={() => void submit(rating === -1 ? null : -1)}
          >
            <ThumbsDown size={15} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">No útil</TooltipContent>
      </Tooltip>
      {busy && <Loader2 size={13} className="uv-spin" aria-hidden="true" />}
      {saved && (
        <span className="uv-step-meta" role="status">
          {saved}
        </span>
      )}
      {ask && (
        <form
          className="uv-feedback-note"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(-1, comment);
          }}
        >
          <input
            value={comment}
            maxLength={1000}
            placeholder="¿Qué faltó o qué estuvo mal? (opcional)"
            onChange={(e) => setComment(e.target.value)}
            aria-label="Comentario sobre la respuesta"
            autoFocus
          />
          <button type="submit" className="uv-btn is-secondary is-sm" disabled={busy}>
            Enviar
          </button>
        </form>
      )}
    </>
  );
}

function Provenance({
  message,
  confidence,
  note,
}: {
  message: MessageData;
  confidence: string | null;
  note: string | null;
}) {
  const meta = message.meta;
  const info =
    confidence && confidence in CONFIDENCE_META
      ? CONFIDENCE_META[confidence as keyof typeof CONFIDENCE_META]
      : null;
  const Icon =
    confidence === 'verified' ? ShieldCheck : confidence === 'estimate' ? TrendingUp : HelpCircle;
  return (
    <>
      {info && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('uv-foot-sources', `is-${confidence}`)} tabIndex={0}>
              <Icon size={12} />
              {info.label}
              {note ? ` · ${note}` : ''}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {info.hint}
          </TooltipContent>
        </Tooltip>
      )}
      {!info && note && <span className="uv-foot-sources">{note}</span>}
      {meta?.model && (
        <ModelChip
          label={meta.modelLabel ?? meta.model}
          effort={meta.effort}
          reason={meta.routing?.reason}
          jev={meta.routing?.jev}
          durationMs={meta.durationMs}
          costUsd={meta.costUsd}
          fallbacks={meta.fallbacks?.map((f) => ({
            fromLabel: f.fromLabel ?? f.from,
            toLabel: f.toLabel ?? f.to,
            reason: f.reason,
          }))}
        />
      )}
    </>
  );
}

const EFFORT_NAMES: Record<string, string> = Object.fromEntries(
  EFFORT_LEVELS.map((l) => [l.id, l.label])
);

function formatCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/** "GPT-5 · Alto · 12 s · $0.02" — which model answered, at what effort, how long, how much. */
export function ModelChip({
  label,
  effort,
  reason,
  jev,
  durationMs,
  costUsd,
  fallbacks,
  live = false,
}: {
  label: string;
  effort?: string;
  reason?: string;
  jev?: boolean;
  durationMs?: number;
  costUsd?: number | null;
  fallbacks?: Array<{ fromLabel: string; toLabel: string; reason: string }>;
  live?: boolean;
}) {
  const effortName = effort ? EFFORT_NAMES[effort] : undefined;
  const parts = [label, effortName, !live && durationMs ? formatDuration(durationMs) : null];
  if (!live && typeof costUsd === 'number') parts.push(formatCost(costUsd));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('uv-foot-model', fallbacks && fallbacks.length > 0 && 'has-fallback')}
          tabIndex={0}
        >
          {fallbacks && fallbacks.length > 0 ? <RefreshCw size={11} /> : <Cpu size={11} />}
          {parts.filter(Boolean).join(' · ')}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <span style={{ display: 'block' }}>{reason ?? 'Modelo de este turno'}</span>
        {jev && (
          <span style={{ display: 'block', opacity: 0.75 }}>JEV decidió la ruta del turno.</span>
        )}
        {fallbacks?.map((f, i) => (
          <span key={i} style={{ display: 'block', opacity: 0.85 }}>
            {f.fromLabel} {f.reason} → siguió {f.toLabel}
          </span>
        ))}
        {!live && typeof costUsd === 'number' && (
          <span style={{ display: 'block', opacity: 0.75 }}>
            Costo estimado con los precios del catálogo.
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function parseSystemEvent(text: string): {
  kind: 'approved' | 'rejected' | 'other';
  title: string;
  detail: string | null;
  failed: boolean;
} {
  const clean = text.replace(/^\[Sistema\]\s*/, '');
  const approved = /APROBÓ/.test(clean);
  const rejected = /RECHAZÓ/.test(clean);
  const failed = /fall[oó]:/i.test(clean);
  const action = /Acción:\s*([^]*?)(?:\s+Resultado:|$)/.exec(clean)?.[1]?.trim() ?? null;
  const reason = failed ? extractFailureReason(clean) : null;
  if (approved)
    return {
      kind: 'approved',
      title: failed
        ? 'Aprobaste la acción, pero falló'
        : /incierto/.test(clean)
          ? 'Aprobaste la acción · resultado por confirmar'
          : 'Aprobaste la acción · ejecutada',
      detail: failed && reason ? `${reason}${action ? ` — ${action}` : ''}` : action,
      failed,
    };
  if (rejected)
    return {
      kind: 'rejected',
      title: 'Rechazaste la acción',
      detail: /RECHAZÓ la propuesta [^\s]+ \([^)]+\)(?::\s*(.*))?/.exec(clean)?.[1] ?? null,
      failed: false,
    };
  return { kind: 'other', title: clean, detail: null, failed: false };
}

function SystemEvent({ content }: { content: string }) {
  const ev = parseSystemEvent(content);
  const action = ev.kind === 'approved' && !ev.failed ? extractResultAction(content) : null;
  const long = Boolean(ev.detail && ev.detail.length > 60) || Boolean(action);
  return (
    <div
      className={cn(
        'uv-event',
        ev.failed || ev.kind === 'rejected' ? 'is-bad' : ev.kind === 'approved' ? 'is-ok' : '',
        long && 'is-long'
      )}
      role="status"
    >
      {ev.kind === 'approved' && !ev.failed ? (
        <ShieldCheck size={14} />
      ) : ev.kind === 'other' ? (
        <Sparkles size={14} />
      ) : (
        <ShieldX size={14} />
      )}
      <span>
        {ev.title}
        {ev.detail && <span className="uv-event-detail">{ev.detail}</span>}
        {action && (
          <button
            type="button"
            className="uv-btn is-secondary is-sm"
            onClick={() => performUiAction(action)}
          >
            {action.kind === 'join_call' ? (
              <>
                <Phone size={13} /> Abrir la llamada
              </>
            ) : (
              <>
                <ExternalLink size={13} /> Abrir
              </>
            )}
          </button>
        )}
      </span>
    </div>
  );
}

function FileChip({
  att,
}: {
  att: { id: string; fileName: string; mimeType: string; sizeBytes: number; previewUrl?: string };
}) {
  return (
    <span className="uv-file-chip" title={att.fileName}>
      <span className={cn('uv-file-chip-icon', att.previewUrl && 'has-thumb')}>
        {att.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
          <img src={att.previewUrl} alt="" />
        ) : att.mimeType.startsWith('image/') ? (
          <ImageIcon size={14} />
        ) : (
          <FileText size={14} />
        )}
      </span>
      <span className="uv-file-chip-text">
        <span className="uv-file-chip-name">{att.fileName}</span>
        <span className="uv-file-chip-meta">{formatBytes(att.sizeBytes)}</span>
      </span>
    </span>
  );
}

export interface MessageProps {
  message: MessageData;
  /** The agent that owns the thread (fallback author). */
  agent: AgentInfo;
  /** Latest agent answer: plan/follow-ups stay actionable only there. */
  isLatest?: boolean;
  onSendText?: (text: string) => void;
  onEdit?: (text: string) => void;
  onRegenerate?: () => void;
  onOpenWorkspace?: (tab: WorkspaceTab) => void;
}

const EXPLICIT_VISUAL_TOOLS = new Set([
  'renderUi',
  'renderView',
  'generateTable',
  'generateChart',
  'generateReportImage',
]);
const DATA_LOOKUP = /^(query|get|list|search|universalSearch|lookup)/;

export const Message = memo(function Message({
  message,
  agent,
  isLatest = false,
  onSendText,
  onEdit,
  onRegenerate,
  onOpenWorkspace,
}: MessageProps) {
  const records = useMemo(() => message.toolCallRecords ?? [], [message.toolCallRecords]);
  const isUser = message.role === 'user';

  const derived = useMemo(() => {
    if (isUser) return null;
    const steps = stepsFromRecords(records);
    // When the agent drew the answer itself (dashboard, table, chart), the raw
    // lookups behind it are not shown again as cards.
    const drewVisual = records.some((r) => r.success && EXPLICIT_VISUAL_TOOLS.has(r.toolName));
    const cards = records.flatMap((r) =>
      r.success && !(drewVisual && DATA_LOOKUP.test(r.toolName))
        ? buildUiComponents({ toolName: r.toolName, args: r.args, result: r.result, success: true })
        : []
    );
    const planRecord = records.find((r) => r.toolName === 'proposePlan' && r.success);
    const missionRecord = records.find((r) => r.toolName === 'proposeMission' && r.success);
    const parsed = parseConfidence(message.content);
    const follow = parseFollowUps(parsed.content);
    const followUps =
      message.meta?.followUps && message.meta.followUps.length > 0
        ? message.meta.followUps
        : follow.followUps;
    const toolMs = records.reduce((acc, r) => acc + (r.durationMs || 0), 0);
    return {
      steps,
      cards,
      plan: planRecord ? parsePlan(planRecord.args) : null,
      mission: missionRecord ? parseMission(missionRecord.args, missionRecord.result) : null,
      content: follow.content,
      followUps,
      confidence: message.meta?.confidence ?? parsed.level ?? null,
      note: message.meta?.sourcesLabel ?? message.meta?.confidenceNote ?? parsed.note ?? null,
      toolMs,
    };
  }, [isUser, records, message.content, message.meta]);

  if (message.role === 'tool') return null;
  if (message.role === 'system') return <SystemEvent content={message.content ?? ''} />;

  if (isUser) {
    const auto = autoKind(message.content);
    if (auto) {
      return (
        <div
          className={cn(
            'uv-event',
            auto === 'action_failed' && 'is-bad',
            auto === 'team' && 'is-team'
          )}
          role="status"
        >
          {auto === 'team' ? <Users size={14} /> : <Sparkles size={14} />}
          <span>{AUTO_EVENT_LABELS[auto]}</span>
        </div>
      );
    }
    const text = message.content ?? '';
    return (
      <div className="uv-msg uv-msg-user">
        {message.attachments && message.attachments.length > 0 && (
          <div className="uv-msg-files">
            {message.attachments.map((a) => (
              <FileChip key={a.id} att={a} />
            ))}
          </div>
        )}
        {text && <div className="uv-bubble">{text}</div>}
        {text && (
          <div className="uv-msg-hover">
            <CopyButton text={text} />
            {onEdit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="uv-icon-btn"
                    aria-label="Editar y reenviar"
                    onClick={() => onEdit(text)}
                  >
                    <PencilLine size={15} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Editar y reenviar</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    );
  }

  if (!derived) return null;
  const author = message.meta?.agent?.name
    ? {
        name: message.meta.agent.name,
        color: message.meta.agent.color,
        icon: message.meta.agent.icon,
      }
    : agent;
  const hasBody =
    derived.content ||
    derived.steps.length > 0 ||
    derived.cards.length > 0 ||
    derived.plan ||
    derived.mission ||
    (message.artifacts?.length ?? 0) > 0 ||
    message.meta?.reasoning ||
    message.meta?.agentMessages;
  if (!hasBody) return null;

  return (
    <article className="uv-msg uv-msg-ai" aria-label={`Respuesta de ${author.name}`}>
      <div className="uv-msg-author">
        <AgentAvatar agent={author} size="xs" />
        <span>{author.name}</span>
        <time dateTime={message.createdAt}>{clockTime(message.createdAt)}</time>
      </div>
      <div className="uv-msg-body">
        <WorkLog
          reasoning={message.meta?.reasoning}
          steps={derived.steps}
          elapsedMs={derived.toolMs}
          onOpenWorkspace={onOpenWorkspace}
        />
        {message.meta?.agentMessages && <AgentReportCard data={message.meta.agentMessages} />}
        {derived.cards.length > 0 && (
          <Cards components={derived.cards} onSendText={onSendText} interactive={isLatest} />
        )}
        {derived.content && <Markdown content={derived.content} />}
        {message.meta?.routineCreated && <RoutineNote data={message.meta.routineCreated} />}
        {derived.plan && onSendText && (
          <PlanCard
            plan={derived.plan}
            active={isLatest}
            onRun={onSendText}
            onAdjust={onEdit ? () => onEdit('Ajusta el plan: ') : undefined}
          />
        )}
        {derived.mission && <MissionCard mission={derived.mission} active={isLatest} />}
        {message.artifacts && message.artifacts.length > 0 && (
          <div className="uv-cards">
            {message.artifacts.map((a) => (
              <ArtifactCard key={a.artifactId} artifact={a} />
            ))}
          </div>
        )}
        {isLatest && onSendText && derived.followUps.length > 0 && (
          <div className="uv-followups" aria-label="Siguientes pasos sugeridos">
            {derived.followUps.map((f) => (
              <button key={f} type="button" className="uv-chip" onClick={() => onSendText(f)}>
                <Sparkles size={13} />
                {f}
              </button>
            ))}
          </div>
        )}
      </div>
      {derived.content && (
        <div className="uv-msg-foot">
          <CopyButton text={derived.content} label="Copiar respuesta" />
          <Feedback messageId={message.id} initial={message.feedback} />
          {isLatest && onRegenerate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="uv-icon-btn"
                  aria-label="Volver a intentar"
                  onClick={onRegenerate}
                >
                  <RotateCcw size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Volver a intentar</TooltipContent>
            </Tooltip>
          )}
          <Provenance message={message} confidence={derived.confidence} note={derived.note} />
        </div>
      )}
    </article>
  );
});

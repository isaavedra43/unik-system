'use client';

import React, { useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Clock, Database, FileText, Image as ImageIcon, ShieldCheck, ShieldX, Sparkles, User as UserIcon, X } from 'lucide-react';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ArtifactRenderer, type ArtifactData } from './ArtifactRenderer';
import { AUTO_EVENT_LABELS, autoKind, extractFailureReason, extractResultAction, parsePlan, performUiAction, toolLabel, type MessageFeedbackData, type TurnMeta } from '@/components/copilot/copilot-types';
import { ExternalLink, Phone } from 'lucide-react';
import { ConfidenceBadge } from '@/components/copilot/ConfidenceBadge';
import { parseFollowUps } from '@/modules/ai/followups';
import { MessageFeedback } from '@/components/copilot/MessageFeedback';
import { PlanCard } from '@/components/copilot/PlanCard';
import { parseConfidence } from '@/modules/ai/confidence';

export interface AttachmentDisplay {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ToolCallRecordDisplay {
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs: number;
  success: boolean;
  errorCode: string | null;
}

export interface AssistantMessageData {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallRecords?: ToolCallRecordDisplay[];
  attachments?: AttachmentDisplay[];
  artifacts?: ArtifactData[];
  meta?: TurnMeta | null;
  feedback?: MessageFeedbackData | null;
  createdAt: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

function wasCached(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as { cached?: unknown }).cached === true);
}

/** Compact, human step chips with an optional exact detail (args/result). */
function ToolSteps({ records }: { records: ToolCallRecordDisplay[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (records.length === 0) return null;
  return (
    <div className="assistant-steps">
      <div className="assistant-steps-row">
        {records.map((r) => {
          const pending = r.errorCode === 'needs_approval';
          const status = pending ? 'pending' : r.success ? 'done' : 'failed';
          const cached = wasCached(r.result);
          return (
            <button
              key={r.id}
              type="button"
              className={`assistant-step is-${status} ${open === r.id ? 'is-open' : ''}`}
              onClick={() => setOpen((v) => (v === r.id ? null : r.id))}
              title={`${r.toolName} · ${r.durationMs} ms${cached ? ' · desde caché' : ''}`}
            >
              {status === 'done' ? cached ? <Database size={11} /> : <Check size={11} /> : status === 'pending' ? <Clock size={11} /> : <X size={11} />}
              {pending ? `${toolLabel(r.toolName, 'done')} · esperando aprobación` : toolLabel(r.toolName, 'done')}
              {open === r.id ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          );
        })}
      </div>
      {open && (
        <div className="assistant-step-detail">
          {(() => {
            const r = records.find((x) => x.id === open);
            if (!r) return null;
            return (
              <>
                <div className="assistant-step-detail-label">{r.toolName} · argumentos</div>
                <pre>{JSON.stringify(r.args, null, 2)}</pre>
                {r.result !== undefined && r.result !== null && (
                  <>
                    <div className="assistant-step-detail-label">resultado</div>
                    <pre>{JSON.stringify(r.result, null, 2).slice(0, 6000)}</pre>
                  </>
                )}
                {r.errorCode && r.errorCode !== 'needs_approval' && (
                  <>
                    <div className="assistant-step-detail-label">error</div>
                    <pre>{r.errorCode}</pre>
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

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

export interface AssistantMessageProps {
  message: AssistantMessageData;
  /** Lets cards inside the message (plan) send a message on the user's behalf. */
  onSendText?: (text: string) => void;
  /** True for the latest assistant message: plan buttons stay enabled only there. */
  isLatest?: boolean;
}

export function AssistantMessage({ message, onSendText, isLatest = false }: AssistantMessageProps) {
  if (message.role === 'tool') return null;

  if (message.role === 'system') {
    const ev = parseSystemEvent(message.content ?? '');
    const action = ev.kind === 'approved' && !ev.failed ? extractResultAction(message.content ?? '') : null;
    return (
      <div className={`assistant-sysevent is-${ev.kind} ${ev.failed ? 'is-failed' : ''}`}>
        {ev.kind === 'approved' ? (ev.failed ? <ShieldX size={14} /> : <ShieldCheck size={14} />) : ev.kind === 'rejected' ? <ShieldX size={14} /> : <Sparkles size={14} />}
        <div>
          <div className="assistant-sysevent-title">{ev.title}</div>
          {ev.detail && <div className="assistant-sysevent-detail">{ev.detail}</div>}
          {action && (
            <button type="button" className="proposal-btn proposal-btn-primary copilot-sysevent-btn" onClick={() => performUiAction(action)}>
              {action.kind === 'join_call' ? <><Phone size={13} /> Abrir la llamada</> : <><ExternalLink size={13} /> Abrir</>}
            </button>
          )}
        </div>
      </div>
    );
  }

  const isUser = message.role === 'user';
  const auto = isUser ? autoKind(message.content) : null;
  if (auto) {
    return (
      <div className={`assistant-sysevent is-other ${auto === 'action_failed' ? 'is-failed' : ''}`}>
        <Sparkles size={14} />
        <div>
          <div className="assistant-sysevent-title">{AUTO_EVENT_LABELS[auto]}</div>
        </div>
      </div>
    );
  }
  const records = message.toolCallRecords ?? [];
  const artifacts = message.artifacts ?? [];
  const planRecord = !isUser ? records.find((r) => r.toolName === 'proposePlan' && r.success) : undefined;
  const plan = planRecord ? parsePlan(planRecord.args) : null;
  const parsed = !isUser ? parseConfidence(message.content) : null;
  const followParsed = parsed ? parseFollowUps(parsed.content) : null;
  const content = followParsed ? followParsed.content : parsed ? parsed.content : message.content;
  const followUps = !isUser ? (message.meta?.followUps && message.meta.followUps.length > 0 ? message.meta.followUps : followParsed?.followUps ?? []) : [];
  const confidence = message.meta?.confidence ?? parsed?.level ?? null;
  const confidenceNote = message.meta?.confidenceNote ?? parsed?.note ?? null;

  return (
    <div className={`assistant-msg-row ${isUser ? 'assistant-msg-row-user' : 'assistant-msg-row-assistant'}`}>
      <div className="assistant-msg-avatar">{isUser ? <UserIcon size={18} /> : <Bot size={18} />}</div>
      <div className={`assistant-msg ${isUser ? 'assistant-msg-user' : 'assistant-msg-assistant'}`}>
        {message.attachments && message.attachments.length > 0 && (
          <div className="assistant-msg-attachments">
            {message.attachments.map((att) => (
              <div key={att.id} className="assistant-msg-attachment">
                {isImage(att.mimeType) ? <ImageIcon size={14} className="assistant-msg-attachment-icon" /> : <FileText size={14} className="assistant-msg-attachment-icon" />}
                <span className="assistant-msg-attachment-name" title={att.fileName}>
                  {att.fileName}
                </span>
                <span className="assistant-msg-attachment-size">{formatSize(att.sizeBytes)}</span>
              </div>
            ))}
          </div>
        )}
        {!isUser && <ToolSteps records={records.filter((r) => r.toolName !== 'proposePlan')} />}
        {content && (
          <div className="assistant-msg-content">
            <AssistantMarkdown content={content} />
          </div>
        )}
        {plan && onSendText && <PlanCard plan={plan} active={isLatest} onRun={onSendText} />}
        {artifacts.length > 0 && (
          <div className="assistant-artifacts assistant-artifacts-inline">
            {artifacts.map((a) => (
              <ArtifactRenderer key={a.artifactId} artifact={a} />
            ))}
          </div>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && records.length === 0 && (
          <div className="assistant-steps-row">
            {message.toolCalls.map((tc) => (
              <span key={tc.id} className="assistant-step is-running">
                {toolLabel(tc.name, 'running')}
              </span>
            ))}
          </div>
        )}
        {!isUser && isLatest && onSendText && followUps.length > 0 && (
          <div className="assistant-followups" aria-label="Sugerencias de siguiente paso">
            {followUps.map((f) => (
              <button key={f} type="button" className="assistant-followup-chip" onClick={() => onSendText(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
        {!isUser && content && (
          <div className="assistant-msg-foot">
            <ConfidenceBadge level={confidence} note={confidenceNote} meta={message.meta} />
            <MessageFeedback messageId={message.id} initial={message.feedback} />
          </div>
        )}
      </div>
    </div>
  );
}

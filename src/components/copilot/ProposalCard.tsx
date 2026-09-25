'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Import,
  Loader2,
  MessageCircle,
  Phone,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { listItem } from '@/lib/motion';
import type { CopilotProposal } from './copilot-types';

/**
 * ONE approval card for every surface. The host provides `decide` (its own API
 * call); the card owns the visuals: what will happen, to whom, with what, and
 * two clear buttons. Nothing runs until the user approves.
 */

export interface ProposalDecisionResult {
  success?: boolean;
  error?: string;
  uncertain?: boolean;
}

export interface ProposalCardProps {
  proposal: CopilotProposal;
  decide: (decision: 'approve' | 'reject') => Promise<ProposalDecisionResult | void>;
  onDecided?: (decision: 'approve' | 'reject', result: ProposalDecisionResult | void) => void;
  /** Hand the message (and its files) to the host's composer so the user sends it manually. */
  onHandoff?: () => void;
}

const EFFECT_META: Record<string, { label: string; tone: string; icon: React.ReactNode }> = {
  external_send: { label: 'Envío / llamada', tone: 'send', icon: <Send size={13} /> },
  business_write: { label: 'Cambio comercial', tone: 'write', icon: <FileText size={13} /> },
  destructive: { label: 'Acción destructiva', tone: 'danger', icon: <Trash2 size={13} /> },
  internal_task: { label: 'Tarea interna', tone: 'task', icon: <Sparkles size={13} /> },
  draft: { label: 'Borrador', tone: 'task', icon: <FileText size={13} /> },
};

const TOOL_ICON: Record<string, React.ReactNode> = {
  sendInboxMessage: <MessageCircle size={16} />,
  sendMessageToContact: <MessageCircle size={16} />,
  sendBulkMessages: <MessageCircle size={16} />,
  sendQuoteToContact: <FileText size={16} />,
  sendInternalChatMessage: <MessageCircle size={16} />,
  callContact: <Phone size={16} />,
  startOutboundCall: <Phone size={16} />,
  createQuote: <FileText size={16} />,
  updateQuote: <FileText size={16} />,
};

const TOOL_TITLE: Record<string, string> = {
  sendInboxMessage: 'Enviar mensaje al cliente',
  sendMessageToContact: 'Enviar mensaje al contacto',
  sendBulkMessages: 'Envío a varios contactos',
  sendQuoteToContact: 'Enviar cotización con PDF de Zoho',
  sendInternalChatMessage: 'Enviar por chat interno',
  callContact: 'Llamada telefónica',
  startOutboundCall: 'Llamada telefónica',
  createQuote: 'Crear cotización en Zoho Books',
  updateQuote: 'Editar cotización en Zoho Books',
  approveCampaign: 'Aprobar campaña',
  cleanupArtifacts: 'Limpiar archivos generados',
};

const DECIDED_LABEL: Record<string, string> = {
  executed: 'Ejecutada',
  rejected: 'Rechazada',
  expired: 'Expirada',
  invalidated: 'Ya no es válida',
  failed: 'Falló',
};

function extractPreview(args: unknown): {
  body: string | null;
  recipients: string[];
  attachments: number;
} {
  const a = (args && typeof args === 'object' ? (args as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const body =
    typeof a.body === 'string'
      ? a.body
      : typeof a.content === 'string'
        ? a.content
        : typeof a.message === 'string'
          ? a.message
          : typeof a.brief === 'string'
            ? a.brief
            : null;
  const recipients: string[] = [];
  if (typeof a.contact === 'string') recipients.push(a.contact);
  if (typeof a.toNumber === 'string') recipients.push(a.toNumber);
  if (Array.isArray(a.recipients))
    for (const r of a.recipients as Array<{ contact?: string }>)
      if (r?.contact) recipients.push(r.contact);
  const att = a.attachments as
    { artifactIds?: unknown[]; knowledgeSourceIds?: unknown[] } | undefined;
  const attachments = (att?.artifactIds?.length ?? 0) + (att?.knowledgeSourceIds?.length ?? 0);
  return { body, recipients, attachments };
}

export function ProposalCard({ proposal, decide, onDecided, onHandoff }: ProposalCardProps) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = EFFECT_META[proposal.effect] ?? EFFECT_META.internal_task;
  const preview = extractPreview(proposal.args);
  const title =
    TOOL_TITLE[proposal.toolName] ?? proposal.toolName.replace(/([a-z])([A-Z])/g, '$1 $2');
  const expires = new Date(proposal.expiresAt);
  const minutesLeft = Math.max(0, Math.round((expires.getTime() - Date.now()) / 60_000));
  const expiresLabel =
    minutesLeft >= 1440
      ? `${Math.round(minutesLeft / 1440)} d`
      : minutesLeft >= 60
        ? `${Math.round(minutesLeft / 60)} h`
        : `${minutesLeft} min`;
  const decided =
    proposal.status && proposal.status !== 'pending'
      ? (DECIDED_LABEL[proposal.status] ?? proposal.status)
      : null;

  const run = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      const result = await decide(decision);
      onDecided?.(decision, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo procesar');
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.div
      className={cn('approval-card', `tone-${meta.tone}`, decided && 'is-done')}
      role="group"
      aria-label="Acción pendiente de aprobación"
      variants={listItem}
      initial="initial"
      animate="animate"
    >
      <div className="approval-head">
        <span className="approval-icon">
          {decided ? (
            decided === 'Rechazada' ? (
              <XCircle size={16} />
            ) : (
              <CheckCircle2 size={16} />
            )
          ) : (
            (TOOL_ICON[proposal.toolName] ?? <ShieldAlert size={16} />)
          )}
        </span>
        <div className="approval-title">
          <strong>{decided ?? 'Aprobación requerida'}</strong>
          <span className="approval-subtitle">
            {title}
            {!decided && ` · caduca en ${expiresLabel}`}
          </span>
        </div>
        <span className={cn('approval-effect', `is-${meta.tone}`)}>
          {meta.icon}
          {meta.label}
        </span>
      </div>

      {preview.recipients.length > 0 && (
        <div className="approval-row">
          <span className="approval-label">Para</span>
          <span className="approval-value">
            {preview.recipients.slice(0, 4).join(', ')}
            {preview.recipients.length > 4 ? ` y ${preview.recipients.length - 4} más` : ''}
          </span>
        </div>
      )}
      {proposal.recipient && preview.recipients.length === 0 && (
        <div className="approval-row">
          <span className="approval-label">Destino</span>
          <span className="approval-value">{proposal.recipient}</span>
        </div>
      )}
      {preview.body ? (
        <div className="approval-message">{preview.body}</div>
      ) : (
        <div className="approval-summary">{proposal.summary}</div>
      )}
      {preview.attachments > 0 && (
        <div className="approval-row">
          <span className="approval-label">Adjuntos</span>
          <span className="approval-value">{preview.attachments} archivo(s)</span>
        </div>
      )}

      {proposal.args !== undefined && !decided && (
        <button type="button" className="approval-detail-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Ver detalle exacto
        </button>
      )}
      {open && <pre className="approval-pre">{JSON.stringify(proposal.args, null, 2)}</pre>}

      {error && (
        <div className="approval-error" role="alert">
          {error}
        </div>
      )}

      {!decided && (
        <div className="approval-actions">
          {onHandoff && (
            <button
              type="button"
              className="proposal-btn proposal-btn-ghost"
              disabled={busy !== null}
              onClick={onHandoff}
              title="Pasar el mensaje y los archivos al redactor para enviarlo tú"
            >
              <Import size={14} /> Al redactor
            </button>
          )}
          <button
            type="button"
            className="proposal-btn proposal-btn-ghost"
            disabled={busy !== null}
            onClick={() => run('reject')}
          >
            {busy === 'reject' ? <Loader2 size={14} className="copilot-spin" /> : <X size={14} />}{' '}
            Rechazar
          </button>
          <button
            type="button"
            className={cn(
              'proposal-btn proposal-btn-primary',
              meta.tone === 'danger' && 'is-danger'
            )}
            disabled={busy !== null}
            onClick={() => run('approve')}
          >
            {busy === 'approve' ? (
              <Loader2 size={14} className="copilot-spin" />
            ) : (
              <Check size={14} />
            )}{' '}
            Aprobar y ejecutar
          </button>
        </div>
      )}
    </motion.div>
  );
}

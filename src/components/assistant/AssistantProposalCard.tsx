'use client';

import React, { useState } from 'react';
import { ShieldAlert, Check, X, Loader2 } from 'lucide-react';

/**
 * Approval card for a side-effecting action proposed by the assistant.
 * Shows EXACTLY what will run (tool, effect, recipient, arguments) and lets
 * the user approve or reject. Approval executes the stored arguments only.
 */
export interface ProposalData {
  id: string;
  toolName: string;
  summary: string;
  effect: string;
  expiresAt: string;
  args?: unknown;
  recipient?: string | null;
  status?: string;
  result?: unknown;
  error?: string | null;
}

const EFFECT_LABELS: Record<string, string> = {
  external_send: 'Envío externo',
  business_write: 'Cambio comercial',
  destructive: 'Acción destructiva',
  internal_task: 'Tarea interna',
  draft: 'Borrador',
  read: 'Consulta',
};

export function AssistantProposalCard({
  proposal,
  onDecided,
}: {
  proposal: ProposalData;
  onDecided: (updated: ProposalData) => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArgs, setShowArgs] = useState(false);

  async function decide(action: 'approve' | 'reject') {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/app/assistant/api/proposals/${proposal.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: action === 'reject' ? JSON.stringify({}) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? 'No se pudo procesar');
        if (res.status === 409 || res.status === 410)
          onDecided({ ...proposal, status: 'invalidated' });
        return;
      }
      const updated = (
        data as {
          proposal: ProposalData;
          execution?: { success: boolean; error?: string; uncertain?: boolean };
        }
      ).proposal;
      onDecided({ ...proposal, ...updated });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setBusy(null);
    }
  }

  const expires = new Date(proposal.expiresAt);

  return (
    <div
      className="artifact-card artifact-file-card"
      role="group"
      aria-label="Acción pendiente de aprobación"
    >
      <div className="artifact-file-icon">
        <ShieldAlert size={20} />
      </div>
      <div className="artifact-file-info">
        <div className="artifact-file-title">
          Requiere tu aprobación · {EFFECT_LABELS[proposal.effect] ?? proposal.effect}
        </div>
        <div className="artifact-file-meta">{proposal.summary}</div>
        {proposal.recipient && (
          <div className="artifact-file-meta">Destinatario: {proposal.recipient}</div>
        )}
        <div className="artifact-file-meta">
          Herramienta: {proposal.toolName} · vence {expires.toLocaleString('es-MX')}
          {proposal.args !== undefined && (
            <>
              {' · '}
              <button
                type="button"
                className="artifact-download-btn"
                onClick={() => setShowArgs((v) => !v)}
              >
                {showArgs ? 'Ocultar detalle' : 'Ver detalle exacto'}
              </button>
            </>
          )}
        </div>
        {showArgs && (
          <pre className="assistant-admin-msg-preview">
            {JSON.stringify(proposal.args, null, 2)}
          </pre>
        )}
        {error && <div className="assistant-upload-error">{error}</div>}
      </div>
      <div className="assistant-input-actions">
        <button
          type="button"
          className="artifact-download-btn"
          disabled={busy !== null}
          onClick={() => decide('reject')}
          aria-label="Rechazar"
        >
          {busy === 'reject' ? <Loader2 size={16} className="spin" /> : <X size={16} />} Rechazar
        </button>
        <button
          type="button"
          className="artifact-download-btn"
          disabled={busy !== null}
          onClick={() => decide('approve')}
          aria-label="Aprobar y ejecutar"
        >
          {busy === 'approve' ? <Loader2 size={16} className="spin" /> : <Check size={16} />}{' '}
          Aprobar
        </button>
      </div>
    </div>
  );
}

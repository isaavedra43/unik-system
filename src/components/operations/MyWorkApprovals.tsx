'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { ProposalCard, type ProposalDecisionResult } from '@/components/copilot/ProposalCard';
import { Alert, Badge, Button, FormField, Textarea } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import { OPERATIONS_COPILOT_ENDPOINTS, operationsCaseHref } from './copilot-starters';
import {
  buildApprovalDecisionCommand,
  describeProposalDecision,
  formatDateTime,
  formatMoney,
  interpretProposalDecisionResponse,
  type MyWorkApproval,
  type MyWorkProposal,
} from './mywork-model';

interface Props {
  approvals: MyWorkApproval[];
  proposals: MyWorkProposal[];
  onSubmit: (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => Promise<boolean>;
  onChanged: () => void;
}

/**
 * Pending decisions of the user: AI proposals from any surface (the scope route
 * decides who may approve) and business approvals (`approval.decide`).
 */
export function MyWorkApprovals({ approvals, proposals, onSubmit, onChanged }: Props) {
  const total = approvals.length + proposals.length;
  return (
    <section id="aprobaciones" className="card grid scroll-mt-4 gap-3" aria-labelledby="mywork-approvals-title">
      <div className="card-header">
        <h2 id="mywork-approvals-title" className="card-title">
          Aprobaciones pendientes{total > 0 ? ` (${total})` : ''}
        </h2>
        <p className="card-subtitle">
          Propuestas de la IA y aprobaciones de negocio que te toca decidir. Nada se ejecuta sin tu aprobación.
        </p>
      </div>
      {total === 0 ? <p className="text-muted text-sm">No tienes aprobaciones pendientes.</p> : null}
      {proposals.length > 0 ? (
        <div className="grid gap-3">
          {proposals.map((proposal) => (
            <ProposalItem key={proposal.id} proposal={proposal} onChanged={onChanged} />
          ))}
        </div>
      ) : null}
      {approvals.length > 0 ? (
        <ul className="grid gap-3" aria-label="Aprobaciones de negocio">
          {approvals.map((approval) => (
            <ApprovalItem key={approval.id} approval={approval} onSubmit={onSubmit} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ProposalItem({ proposal, onChanged }: { proposal: MyWorkProposal; onChanged: () => void }) {
  const [closedNotice, setClosedNotice] = useState<string | null>(null);
  const lastOutcome = React.useRef<ReturnType<typeof interpretProposalDecisionResponse> | null>(null);

  async function decide(decision: 'approve' | 'reject'): Promise<ProposalDecisionResult> {
    const res = await fetch(OPERATIONS_COPILOT_ENDPOINTS.proposal(proposal.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (data as { error?: unknown }).error;
      throw new Error(typeof message === 'string' ? message : `Error ${res.status}`);
    }
    const outcome = interpretProposalDecisionResponse(data);
    lastOutcome.current = outcome;
    return outcome.result;
  }

  function onDecided(decision: 'approve' | 'reject') {
    const outcome = lastOutcome.current ?? { awaitingSecondApproval: false, result: { success: true } };
    const feedback = describeProposalDecision(decision, outcome);
    if (feedback.kind === 'success') toast.success(feedback.message);
    else if (feedback.kind === 'info') toast.info(feedback.message);
    else if (feedback.kind === 'warning') toast.warning(feedback.message);
    else toast.error(feedback.message);
    // A failed or uncertain execution stays visible (closed) until the next reload.
    if (feedback.closedNotice) setClosedNotice(feedback.closedNotice);
    onChanged();
  }

  if (closedNotice) {
    return (
      <Alert variant="warning" title={proposal.summary}>
        {closedNotice}
      </Alert>
    );
  }
  return (
    <ProposalCard
      proposal={proposal}
      decide={decide}
      onDecided={onDecided}
      readOnlyNotice={proposal.signedByMe ? 'Ya firmaste · falta la segunda firma de otra persona con permiso' : null}
    />
  );
}

function ApprovalItem({
  approval,
  onSubmit,
}: {
  approval: MyWorkApproval;
  onSubmit: Props['onSubmit'];
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const noteId = `approval-note-${approval.id}`;

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    try {
      const ok = await onSubmit(
        buildApprovalDecisionCommand(approval, decision, decision === 'reject' ? note : undefined),
        decision === 'approve' ? 'Aprobación registrada' : 'Rechazo registrado'
      );
      if (ok) {
        setRejecting(false);
        setNote('');
      }
    } finally {
      setBusy(null);
    }
  }

  const meta = [
    approval.requestedByName ? `Pidió ${approval.requestedByName}` : null,
    approval.areaLabel,
    approval.expiresAt ? `Vence ${formatDateTime(approval.expiresAt)}` : null,
  ].filter(Boolean);

  return (
    <li className="grid gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {approval.scopeLabel} · {formatMoney(approval.amount, approval.currency)}
          </p>
          <p className="text-muted text-xs">
            {meta.join(' · ')}
            {approval.caseId ? (
              <>
                {meta.length > 0 ? ' · ' : ''}
                {operationsCaseHref(approval.caseId) ? (
                  <Link href={operationsCaseHref(approval.caseId)!}>{approval.caseNumber ?? 'Ver expediente'}</Link>
                ) : (
                  <span>{approval.caseNumber ? `Expediente ${approval.caseNumber}` : 'Expediente'}</span>
                )}
              </>
            ) : null}
          </p>
        </div>
        <Badge variant="info">
          {approval.approvals}/{approval.requiredApprovals} firmas
        </Badge>
      </div>
      {rejecting ? (
        <FormField label="Motivo del rechazo (opcional)" htmlFor={noteId}>
          <Textarea id={noteId} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {rejecting ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="danger"
              icon={<X size={14} />}
              isLoading={busy === 'reject'}
              disabled={busy !== null}
              onClick={() => void decide('reject')}
            >
              Confirmar rechazo
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setRejecting(false)}>
              Cancelar
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              icon={<Check size={14} />}
              isLoading={busy === 'approve'}
              disabled={busy !== null}
              onClick={() => void decide('approve')}
            >
              Aprobar
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              icon={<X size={14} />}
              disabled={busy !== null}
              onClick={() => setRejecting(true)}
            >
              Rechazar
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

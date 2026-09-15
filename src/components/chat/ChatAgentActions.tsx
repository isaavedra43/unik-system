'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Ban, Check, CircleAlert, CircleCheck, FolderOpen, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Label } from '@/components/shadcn/label';
import { Textarea } from '@/components/shadcn/textarea';
import { ProposalCard, type ProposalDecisionResult } from '@/components/copilot/ProposalCard';
import type { CopilotProposal } from '@/components/copilot/copilot-types';
import { cn } from '@/lib/utils';
import { operationsCaseHref } from '@/components/operations/copilot-starters';
import type { ChatAgentProposalMeta, ChatAgentRequestMeta } from '@/modules/chat/chat-events';

/**
 * Quick actions rendered under AI (bot) posts in area channels and sales
 * rooms. The server validates who may act (responsible, backup, approver
 * scope); the client only hides what does not apply.
 */

const REQUEST_STATUS_LABELS: Record<string, string> = {
  sent: 'Enviada',
  acknowledged: 'Recibida',
  accepted: 'Aceptada',
  blocked: 'Bloqueada',
  resolved: 'Resuelta',
  rejected: 'Rechazada',
  cancelled: 'Cancelada',
  expired: 'Vencida',
};

const REQUEST_CLOSED_STATUSES = new Set(['resolved', 'rejected', 'cancelled', 'expired']);

const BLOCK_REASON_MIN = 3;
const BLOCK_REASON_MAX = 500;

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty or non-JSON body
  }
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : 'No se pudo completar la acción');
  }
  return data;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'No se pudo completar la acción';
}


function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'accepted' || status === 'resolved'
      ? 'bg-success/10 text-success'
      : status === 'blocked' || status === 'rejected' || status === 'expired'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', tone)}
    >
      {REQUEST_STATUS_LABELS[status] ?? status}
    </span>
  );
}

// =====================================================
// agent_request → Aceptar / Bloquear / Ver expediente
// =====================================================

export interface ChatAgentActionsProps {
  meta: ChatAgentRequestMeta;
  currentUserId: string;
}

export function ChatAgentActions({ meta, currentUserId }: ChatAgentActionsProps) {
  const [status, setStatus] = useState<string | null>(meta.status);
  const [busy, setBusy] = useState<'accept' | 'block' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonId = useId();
  const reasonHintId = useId();
  const requestUrl = `/app/operations/api/requests/${encodeURIComponent(meta.requestId)}`;

  // The meta was written when the card was posted: the room stream updates it on every change of the
  // request, and the live status is read once when the card is shown (older history).
  useEffect(() => {
    if (meta.status) setStatus(meta.status);
  }, [meta.status]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(requestUrl, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { request?: { status?: unknown } };
      if (typeof data.request?.status === 'string') setStatus(data.request.status);
    } catch {
      // Keep the last known status.
    }
  }, [requestUrl]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // The copy in the area channel informs; the decision is taken on the room card.
  const isCopy = Boolean(meta.copyOf);
  const canAct = !isCopy && (!meta.actorUserIds || meta.actorUserIds.includes(currentUserId));
  const closed = status !== null && REQUEST_CLOSED_STATUSES.has(status);
  const showAccept =
    canAct && !closed && status !== 'accepted' && meta.quickActions.includes('accept');
  const showBlock = canAct && !closed && status !== 'blocked' && meta.quickActions.includes('block');
  const caseLink = meta.quickActions.includes('open_case') ? operationsCaseHref(meta.caseId) : null;
  const respondUrl = `${requestUrl}/respond`;

  if (!showAccept && !showBlock && !caseLink && !status) return null;

  const accept = async () => {
    setBusy('accept');
    setError(null);
    try {
      await postJson(respondUrl, { action: 'accept' });
      setStatus('accepted');
      toast.success('Solicitud aceptada');
    } catch (err) {
      // One announcement only (inline alert); the latest status explains a stale card.
      setError(errorText(err));
      void refreshStatus();
    } finally {
      setBusy(null);
    }
  };

  const block = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < BLOCK_REASON_MIN) {
      setReasonError(`Escribe al menos ${BLOCK_REASON_MIN} caracteres`);
      return;
    }
    setBusy('block');
    setReasonError(null);
    try {
      await postJson(respondUrl, { action: 'block', reason: trimmed });
      setStatus('blocked');
      setBlockOpen(false);
      setReason('');
      setError(null);
      toast.success('Solicitud bloqueada');
    } catch (err) {
      setReasonError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5" role="group" aria-label="Acciones de la solicitud">
      <div className="flex flex-wrap items-center gap-1.5">
        {showAccept && (
          <Button type="button" size="sm" onClick={accept} disabled={busy !== null}>
            {busy === 'accept' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
            Aceptar
          </Button>
        )}
        {showBlock && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setReasonError(null);
              setBlockOpen(true);
            }}
            disabled={busy !== null}
          >
            <Ban aria-hidden="true" />
            Bloquear
          </Button>
        )}
        {caseLink && (
          <Button asChild size="sm" variant="ghost">
            <Link href={caseLink}>
              <FolderOpen aria-hidden="true" />
              Ver expediente
            </Link>
          </Button>
        )}
        {status && (
          <span aria-live="polite">
            <StatusChip status={status} />
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <Dialog
        open={blockOpen}
        onOpenChange={(open) => {
          if (busy === null) setBlockOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Bloquear solicitud</DialogTitle>
            <DialogDescription>
              Explica qué impide atenderla. El motivo queda en el expediente y lo verá el área que la
              pidió.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void block();
            }}
          >
            <Label htmlFor={reasonId}>Motivo del bloqueo</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (reasonError) setReasonError(null);
              }}
              maxLength={BLOCK_REASON_MAX}
              rows={4}
              placeholder="Ej. No hay unidad disponible hasta el jueves"
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonHintId}
              autoFocus
            />
            <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
              <span
                id={reasonHintId}
                role={reasonError ? 'alert' : undefined}
                className={cn(reasonError && 'text-destructive')}
              >
                {reasonError ?? `Mínimo ${BLOCK_REASON_MIN} caracteres`}
              </span>
              <span aria-hidden="true">
                {reason.length}/{BLOCK_REASON_MAX}
              </span>
            </div>
            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setBlockOpen(false)}
                disabled={busy !== null}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={busy !== null || reason.trim().length < BLOCK_REASON_MIN}
              >
                {busy === 'block' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Ban aria-hidden="true" />}
                Bloquear
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =====================================================
// agent_proposal → the existing ProposalCard
// =====================================================

const PROPOSAL_OPEN_STATUSES = new Set(['pending', 'awaiting_second_approval']);

const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  approved: 'Propuesta aprobada',
  executed: 'Propuesta aprobada y ejecutada',
  rejected: 'Propuesta rechazada',
  expired: 'Propuesta caducada',
  failed: 'La acción aprobada falló',
  uncertain: 'Aprobada; no se pudo confirmar el resultado',
  awaiting_second_approval: 'Aprobada; falta la segunda firma',
};

export interface ChatAgentProposalProps {
  meta: ChatAgentProposalMeta;
  /** Message text, used as summary when the meta does not carry one. */
  fallbackSummary: string | null;
  /** Message timestamp, used to show an expiry when the meta does not carry one. */
  createdAt: string;
  /** Viewer: only the listed approvers see the buttons (the server validates the scope anyway). */
  currentUserId: string;
}

export function ChatAgentProposal({ meta, fallbackSummary, createdAt, currentUserId }: ChatAgentProposalProps) {
  const [decided, setDecided] = useState<{ status: string; detail: string | null } | null>(null);
  const responseStatus = useRef<string | null>(null);

  const proposal = useMemo<CopilotProposal>(
    () => ({
      id: meta.proposalId,
      toolName: meta.toolName ?? 'Propuesta de la IA',
      summary: meta.summary ?? fallbackSummary ?? 'Acción propuesta por la IA',
      effect: meta.effect ?? 'business_write',
      expiresAt:
        meta.expiresAt ?? new Date(new Date(createdAt).getTime() + 24 * 3_600_000).toISOString(),
      args: meta.args,
      requiresSecondApproval: meta.requiresSecondApproval,
      awaitingSecondApproval: meta.status === 'awaiting_second_approval',
    }),
    [meta, fallbackSummary, createdAt]
  );

  const initialStatus = meta.status && !PROPOSAL_OPEN_STATUSES.has(meta.status) ? meta.status : null;
  const closedStatus = decided?.status ?? initialStatus;

  if (closedStatus) {
    const ok = closedStatus === 'approved' || closedStatus === 'executed';
    const failed = closedStatus === 'failed' || closedStatus === 'rejected' || closedStatus === 'expired';
    return (
      <div
        role="status"
        className={cn(
          'mt-2 flex items-start gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs',
          ok ? 'text-success' : failed ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {ok ? (
          <CircleCheck size={14} aria-hidden="true" className="mt-px shrink-0" />
        ) : failed ? (
          <XCircle size={14} aria-hidden="true" className="mt-px shrink-0" />
        ) : (
          <CircleAlert size={14} aria-hidden="true" className="mt-px shrink-0" />
        )}
        <span>
          {PROPOSAL_STATUS_LABELS[closedStatus] ?? `Propuesta: ${closedStatus}`}
          {decided?.detail ? ` · ${decided.detail}` : ''}
        </span>
      </div>
    );
  }

  const decide = async (decision: 'approve' | 'reject'): Promise<ProposalDecisionResult> => {
    const data = await postJson(`/app/operations/api/proposals/${encodeURIComponent(meta.proposalId)}`, {
      decision,
    });
    const returned = data.proposal as { status?: unknown } | undefined;
    responseStatus.current = typeof returned?.status === 'string' ? returned.status : null;
    const execution = data.execution as ProposalDecisionResult | undefined;
    return execution ?? { success: true };
  };

  const onDecided = (decision: 'approve' | 'reject', result: ProposalDecisionResult | void) => {
    if (decision === 'reject') {
      setDecided({ status: 'rejected', detail: null });
      toast.success('Propuesta rechazada');
      return;
    }
    if (responseStatus.current === 'awaiting_second_approval') {
      setDecided({ status: 'awaiting_second_approval', detail: null });
      toast.success('Aprobación registrada; falta la segunda firma');
      return;
    }
    if (result && result.success === false) {
      setDecided({ status: 'failed', detail: result.error ?? null });
      toast.error(result.error ?? 'La acción aprobada falló');
      return;
    }
    if (result && result.uncertain) {
      setDecided({ status: 'uncertain', detail: 'revisa el expediente' });
      return;
    }
    setDecided({ status: 'executed', detail: null });
    toast.success('Propuesta aprobada');
  };

  // Room members outside the approver scope see who decides instead of buttons that would fail.
  const listedApprover = !meta.approverUserIds || meta.approverUserIds.includes(currentUserId);
  if (!listedApprover) {
    return (
      <div className="mt-2 flex flex-col gap-1">
        <ProposalCard
          proposal={proposal}
          decide={decide}
          onDecided={onDecided}
          readOnlyNotice="Espera la aprobación del responsable o suplente del área"
        />
        <Link href="/app/mywork#aprobaciones" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          Si te toca decidirla por permiso, aparece en Mi trabajo
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <ProposalCard proposal={proposal} decide={decide} onDecided={onDecided} />
    </div>
  );
}

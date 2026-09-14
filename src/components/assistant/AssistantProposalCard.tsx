'use client';

import React from 'react';
import { ProposalCard } from '@/components/copilot/ProposalCard';

/**
 * Approval card inside the main assistant. Same visuals as the copilots
 * (shared ProposalCard); only the API endpoints differ.
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

export interface ProposalExecution {
  success?: boolean;
  error?: string;
  uncertain?: boolean;
  result?: unknown;
}

export function AssistantProposalCard({ proposal, onDecided }: { proposal: ProposalData; onDecided: (updated: ProposalData, execution?: ProposalExecution) => void }) {
  return (
    <ProposalCard
      proposal={proposal}
      decide={async (action) => {
        const res = await fetch(`/app/assistant/api/proposals/${proposal.id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: action === 'reject' ? JSON.stringify({}) : undefined,
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; proposal?: ProposalData; execution?: ProposalExecution };
        if (!res.ok) {
          if (res.status === 409 || res.status === 410) onDecided({ ...proposal, status: 'invalidated' });
          throw new Error(data.error ?? 'No se pudo procesar');
        }
        onDecided({ ...(data.proposal ?? proposal), status: data.proposal?.status ?? (action === 'approve' ? 'executed' : 'rejected') }, action === 'approve' ? data.execution : undefined);
        return data.execution;
      }}
    />
  );
}

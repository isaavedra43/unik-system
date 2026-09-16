'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { MyWorkApprovals } from '@/components/operations/MyWorkApprovals';
import { operationsCaseHref } from '@/components/operations/copilot-starters';
import {
  describeSubmitOutcome,
  formatDueLabel,
  type MyWorkApproval,
  type MyWorkProposal,
} from '@/components/operations/mywork-model';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { Alert, Badge } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';

/**
 * What is waiting for a signature (plan 7.7 `aprobaciones`): the AI proposals
 * of every surface and the business approvals this person may decide, plus the
 * `approval` work items that are still open across the company.
 *
 * The deciding UI is the SAME one "Mi trabajo" uses (`MyWorkApprovals`): one
 * card, one route, one set of rules. The Control Tower only adds the company
 * wide list of open approval work items, which is read-only on purpose — the
 * signature belongs to the person who owns it, not to whoever is watching.
 */

export interface ApprovalWorkItemView {
  id: string;
  title: string;
  areaLabel: string;
  status: string;
  ownerName: string | null;
  dueAt: string;
  overdue: boolean;
  caseId: string | null;
  caseNumber: string | null;
}

export interface ApprovalsPanelProps {
  user: { id: string; name: string };
  approvals: MyWorkApproval[];
  proposals: MyWorkProposal[];
  workItems: ApprovalWorkItemView[];
  /** Spanish notes when a block could not be loaded. */
  warnings: string[];
  nowIso: string;
}

export function ApprovalsPanel({
  user,
  approvals,
  proposals,
  workItems,
  warnings,
  nowIso,
}: ApprovalsPanelProps) {
  const router = useRouter();
  const { submit } = useOfflineCommandQueue(user.id);
  const now = useMemo(() => new Date(Date.parse(nowIso) || Date.now()), [nowIso]);

  const runCommand = useCallback(
    async (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => {
      const outcome = await submit<Record<string, unknown>>(input);
      const feedback = describeSubmitOutcome(outcome, successMessage);
      if (feedback.kind === 'success') toast.success(feedback.message);
      else if (feedback.kind === 'queued') toast.info(feedback.message);
      else if (feedback.kind === 'conflict') toast.warning(feedback.message);
      else toast.error(feedback.message);
      if (feedback.refresh) router.refresh();
      return feedback.kind === 'success' || feedback.kind === 'queued';
    },
    [submit, router]
  );

  return (
    <div className="ct-approvals">
      {warnings.map((warning) => (
        <Alert key={warning} variant="warning">
          {warning}
        </Alert>
      ))}

      <MyWorkApprovals
        approvals={approvals}
        proposals={proposals}
        onSubmit={runCommand}
        onChanged={() => router.refresh()}
      />

      <ChartCard
        title={`Aprobaciones abiertas en la empresa${workItems.length > 0 ? ` (${workItems.length})` : ''}`}
        description="Firmas que siguen esperando, sin importar a quién le tocan. Sólo lectura: la decide su responsable."
        height="auto"
        state={workItems.length === 0 ? 'empty' : undefined}
        emptyText="No hay aprobaciones abiertas en ninguna área."
      >
        <ul className="ct-approval-list">
          {workItems.map((item) => {
            const due = formatDueLabel(item.dueAt, now);
            const caseHref = item.caseId ? operationsCaseHref(item.caseId) : null;
            return (
              <li key={item.id} className="ct-approval-item">
                <div className="ct-approval-head">
                  <div>
                    <p className="ct-cell-strong">{item.title}</p>
                    <p className="ct-cell-sub">
                      {item.areaLabel}
                      {item.ownerName ? ` · ${item.ownerName}` : ' · sin responsable'}
                      {item.caseNumber ? ' · ' : ''}
                      {item.caseNumber ? (
                        caseHref ? (
                          <Link href={caseHref}>{item.caseNumber}</Link>
                        ) : (
                          <span>{item.caseNumber}</span>
                        )
                      ) : null}
                    </p>
                  </div>
                  <span title={due.title}>
                    <Badge variant={item.overdue ? 'danger' : 'info'}>{due.label}</Badge>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </ChartCard>
    </div>
  );
}

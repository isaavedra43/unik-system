'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { describeSubmitOutcome } from '@/components/operations/mywork-model';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';

/**
 * Sends the finance commands of the Contabilidad panels through the shared
 * offline queue (`POST /app/operations/api/commands`), reports the outcome in
 * Spanish and refreshes the server data when something actually changed.
 *
 * Nothing about the business lives here: the engine validates the permission,
 * the schema, the state and the optimistic version of every command again.
 */

export interface RunCommandResult<D> {
  ok: boolean;
  /** The command was kept on the device (offline, network, another session). */
  queued: boolean;
  data?: D;
}

export interface FinanceCommandRunner {
  run: <D = Record<string, unknown>>(
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<RunCommandResult<D>>;
  busy: boolean;
  online: boolean;
}

export function useFinanceCommand(userId: string): FinanceCommandRunner {
  const router = useRouter();
  const { submit, online } = useOfflineCommandQueue(userId);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <D = Record<string, unknown>>(
      input: OfflineCommandInput<Record<string, unknown>>,
      successMessage: string
    ): Promise<RunCommandResult<D>> => {
      setBusy(true);
      try {
        const outcome = await submit<Record<string, unknown>, D>(input);
        const feedback = describeSubmitOutcome(outcome, successMessage);
        if (feedback.kind === 'success') toast.success(feedback.message);
        else if (feedback.kind === 'queued') toast.info(feedback.message);
        else if (feedback.kind === 'conflict') toast.warning(feedback.message);
        else toast.error(feedback.message);
        if (feedback.refresh) router.refresh();
        if (outcome.queued) return { ok: true, queued: true };
        return {
          ok: feedback.kind === 'success',
          queued: false,
          ...(outcome.result.data === undefined ? {} : { data: outcome.result.data }),
        };
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'No se pudo enviar la acción');
        return { ok: false, queued: false };
      } finally {
        setBusy(false);
      }
    },
    [router, submit]
  );

  return { run, busy, online };
}

'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ActionResult } from '@/app/app/manufacturing/actions';

/**
 * Runs one manufacturing server action from a client panel: keeps the button
 * busy, shows the outcome as a toast and reloads the server data when it worked.
 *
 * The action itself goes through `executeCommand`, so a failure here is the
 * engine's answer (a rule, a permission, a version conflict), never a guess of
 * the UI: its message is shown as it comes, in Spanish.
 */
export function useOrderAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const runAction = useCallback(
    async (execute: () => Promise<ActionResult>, options: { onDone?: () => void } = {}) => {
      setError(null);
      let result: ActionResult;
      try {
        result = await execute();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'No se pudo completar la acción';
        setError(message);
        toast.error(message);
        return false;
      }
      if (!result.ok) {
        setError(result.message);
        toast.error(result.message);
        return false;
      }
      toast.success(result.message);
      options.onDone?.();
      startTransition(() => router.refresh());
      return true;
    },
    [router]
  );

  return { runAction, pending, error, setError };
}

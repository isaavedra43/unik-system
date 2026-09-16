'use client';

import { useEffect, useState } from 'react';
import { LoadingState } from '@/components/patterns/LoadingState';
import { getAreaClient, type AreaDetailExtrasProps } from './area-client-registry';
import { ensureAreaClientRegistrations } from './register-all-client';

type LoadState = 'loading' | 'ready' | 'missing';

/**
 * Management panel of one row of an area, inside its detail page (plan 7.1).
 *
 * It is the extension point the domain flows that need a real form hang from —
 * a receipt with accepted and rejected quantities, the review of an RFQ over
 * its scored comparison, the resolution of a difference — because the shared
 * dialog of the work centre only knows how to collect a note or a reason.
 *
 * An area that has not written one renders NOTHING (not a placeholder): the
 * facts, the timeline, the evidence and the actions of the page are complete on
 * their own, so this may only add.
 */
export function AreaDetailExtras(props: AreaDetailExtrasProps) {
  const { areaKey } = props;
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    ensureAreaClientRegistrations(areaKey)
      .then((registered) => {
        if (cancelled) return;
        setState(registered && getAreaClient(areaKey).DetailExtras ? 'ready' : 'missing');
      })
      .catch(() => {
        // The page keeps working without the panel; the browser console already
        // carries the import failure from `ensureAreaClientRegistrations`.
        if (!cancelled) setState('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [areaKey]);

  if (state === 'missing') return null;
  if (state === 'loading') {
    return <LoadingState variant="list" rows={2} label="Cargando el panel de gestión…" />;
  }

  const Panel = getAreaClient(areaKey).DetailExtras;
  if (!Panel) return null;
  return <Panel {...props} />;
}

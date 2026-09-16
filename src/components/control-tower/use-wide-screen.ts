'use client';

import { useCallback, useSyncExternalStore } from 'react';

const WIDE_QUERY = '(min-width: 1280px)';

/**
 * `null` while the server renders and during hydration, then the real answer.
 * The three-state result matters: a component must not decide "narrow" before
 * the browser answered, or the copilot aside would flash on every load.
 *
 * Same breakpoint as `control-tower.css` (`@media (max-width: 1279px)` hides the
 * aside): change both together or the copilot becomes unreachable on a tablet.
 */
export function useWideScreen(): boolean | null {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(WIDE_QUERY);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return useSyncExternalStore<boolean | null>(
    subscribe,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => null
  );
}

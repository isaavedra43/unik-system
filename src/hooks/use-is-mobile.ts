'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * True below `maxWidth` (one column at a time). Shared by the inbox and the
 * area work centres, so "móvil" means the same width everywhere.
 *
 * The server (and the hydration pass) always answers `false`: the desktop
 * layout is the one that renders on the server. `useSyncExternalStore` then
 * commits the real value right after hydration, without an extra effect round
 * trip, so a phone swaps to the mobile surface in the same commit.
 */
export function useIsMobile(maxWidth = 768): boolean {
  const query = `(max-width: ${maxWidth}px)`;

  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query]
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}

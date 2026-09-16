'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** Shared 1280px boundary for desktop copilot asides. */
export function useWideScreen(): boolean | null {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia('(min-width: 1280px)');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return useSyncExternalStore<boolean | null>(
    subscribe,
    () => window.matchMedia('(min-width: 1280px)').matches,
    () => null
  );
}

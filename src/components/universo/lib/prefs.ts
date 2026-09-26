'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Interface preferences of UNIVERSO (per browser): density, animations, the
 * composer's default mode and whether the workspace column is open. Account
 * preferences (tone, memory, autonomy) live on the server — see the
 * preferences panel.
 */

export interface UniversoPrefs {
  density: 'comfortable' | 'compact';
  animations: boolean;
  composerMode: 'mission' | 'message';
  workspaceOpen: boolean;
}

const DEFAULTS: UniversoPrefs = {
  density: 'comfortable',
  animations: true,
  composerMode: 'message',
  workspaceOpen: true,
};

const KEY = 'unik.universo.prefs.v1';

function load(): UniversoPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<UniversoPrefs>;
    return {
      density: p.density === 'compact' ? 'compact' : 'comfortable',
      animations: p.animations !== false,
      composerMode: p.composerMode === 'mission' ? 'mission' : 'message',
      workspaceOpen: p.workspaceOpen !== false,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useUniversoPrefs() {
  const [prefs, setState] = useState<UniversoPrefs>(DEFAULTS);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setState(load());
    setReady(true);
  }, []);
  const setPrefs = useCallback((patch: Partial<UniversoPrefs>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);
  return { prefs, setPrefs, ready };
}

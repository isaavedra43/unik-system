'use client';

import { useCallback, useEffect, useState } from 'react';

export interface AssistantTweaks {
  density: 'normal' | 'compact';
  opsVisible: boolean;
  animations: boolean;
  composerMode: 'mission' | 'message';
}

const DEFAULTS: AssistantTweaks = {
  density: 'normal',
  opsVisible: true,
  animations: true,
  composerMode: 'message',
};

const KEY = 'unik.assistant.tweaks';

function load(): AssistantTweaks {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AssistantTweaks>;
    return {
      density: parsed.density === 'compact' ? 'compact' : 'normal',
      opsVisible: parsed.opsVisible !== false,
      animations: parsed.animations !== false,
      composerMode: parsed.composerMode === 'mission' ? 'mission' : 'message',
    };
  } catch {
    return DEFAULTS;
  }
}

/** UI tweaks for /app/assistant — persisted locally until a settings API exists. */
export function useAssistantTweaks(): {
  tweaks: AssistantTweaks;
  setTweaks: (patch: Partial<AssistantTweaks>) => void;
  hydrated: boolean;
} {
  const [tweaks, setState] = useState<AssistantTweaks>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(load());
    setHydrated(true);
  }, []);

  const setTweaks = useCallback((patch: Partial<AssistantTweaks>) => {
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

  return { tweaks, setTweaks, hydrated };
}

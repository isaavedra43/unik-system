'use client';

import { useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SavedTemplate {
  id: string;
  label: string;
  contentSid: string;
  body?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'unik.inbox.templates';

function loadTemplates(): SavedTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is SavedTemplate =>
        typeof t.id === 'string' &&
        typeof t.label === 'string' &&
        typeof t.contentSid === 'string'
    );
  } catch {
    return [];
  }
}

function saveTemplates(templates: SavedTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // storage unavailable or quota exceeded
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSavedTemplatesResult {
  templates: SavedTemplate[];
  addTemplate: (label: string, contentSid: string, body?: string) => SavedTemplate;
  removeTemplate: (id: string) => void;
  updateTemplate: (id: string, patch: Partial<Omit<SavedTemplate, 'id' | 'createdAt'>>) => void;
}

/**
 * Persists WhatsApp approved templates (Content SID + label + optional body)
 * in the browser's localStorage so the user doesn't have to copy-paste the
 * SID every time they start a new conversation.
 */
export function useSavedTemplates(): UseSavedTemplatesResult {
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);

  useEffect(() => {
    setTemplates(loadTemplates());
  }, []);

  const addTemplate = useCallback(
    (label: string, contentSid: string, body?: string): SavedTemplate => {
      const template: SavedTemplate = {
        id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: label.trim() || contentSid,
        contentSid: contentSid.trim(),
        body: body?.trim() || undefined,
        createdAt: Date.now(),
      };
      setTemplates((prev) => {
        const next = [template, ...prev].slice(0, 50);
        saveTemplates(next);
        return next;
      });
      return template;
    },
    []
  );

  const removeTemplate = useCallback((id: string) => {
    setTemplates((prev) => {
      const next = prev.filter((t) => t.id !== id);
      saveTemplates(next);
      return next;
    });
  }, []);

  const updateTemplate = useCallback(
    (id: string, patch: Partial<Omit<SavedTemplate, 'id' | 'createdAt'>>) => {
      setTemplates((prev) => {
        const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
        saveTemplates(next);
        return next;
      });
    },
    []
  );

  return { templates, addTemplate, removeTemplate, updateTemplate };
}

'use client';

import React, { useState, useEffect } from 'react';
import { Bot, X } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantChat } from './AssistantChat';

export interface AssistantWidgetProps {
  user: CurrentUser;
  context?: { page?: string };
}

export function AssistantWidget({ user, context }: AssistantWidgetProps) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);

  // Persist open state
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('assistant-widget-open') : null;
    if (stored === 'true') setOpen(true);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('assistant-widget-open', String(open));
    }
  }, [open]);

  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {open && (
        <>
          <div className="assistant-widget-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="assistant-widget-drawer" role="dialog" aria-label="Asistente IA">
            <div className="assistant-widget-header">
              <div className="assistant-widget-header-title">
                <Bot size={18} />
                <span>Asistente IA</span>
              </div>
              <button
                type="button"
                className="assistant-widget-close"
                onClick={() => setOpen(false)}
                aria-label="Cerrar asistente"
              >
                <X size={18} />
              </button>
            </div>
            <div className="assistant-widget-body">
              <AssistantChat
                conversationId={conversationId}
                context={context}
                user={user}
                onConversationCreated={setConversationId}
              />
            </div>
          </div>
        </>
      )}
      <button
        type="button"
        className="assistant-widget-btn"
        onClick={() => setOpen(!open)}
        aria-label={open ? 'Cerrar asistente' : 'Abrir asistente IA'}
      >
        {open ? <X size={24} /> : <Bot size={24} />}
      </button>
    </>
  );
}

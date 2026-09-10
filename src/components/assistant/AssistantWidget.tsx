'use client';

import React, { useState, useEffect } from 'react';
import { Bot, X, EyeOff, Sparkles } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantChat } from './AssistantChat';

export interface AssistantWidgetProps {
  user: CurrentUser;
  context?: { page?: string };
}

export function AssistantWidget({ user, context }: AssistantWidgetProps) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);

  // Persist open state
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedOpen = localStorage.getItem('assistant-widget-open');
    const storedHidden = localStorage.getItem('assistant-widget-hidden');
    if (storedOpen === 'true') setOpen(true);
    if (storedHidden === 'true') setHidden(true);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('assistant-widget-open', String(open));
    }
  }, [open]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('assistant-widget-hidden', String(hidden));
    }
  }, [hidden]);

  // ESC to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function handleHide() {
    setOpen(false);
    setHidden(true);
  }

  function handleShow() {
    setHidden(false);
    setOpen(true);
  }

  // When hidden, show a small discrete tab to bring it back
  if (hidden) {
    return (
      <button
        type="button"
        className="assistant-widget-show-tab"
        onClick={handleShow}
        aria-label="Mostrar asistente IA"
        title="Mostrar asistente IA"
      >
        <Sparkles size={16} />
        <span>IA</span>
      </button>
    );
  }

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
              <div className="assistant-widget-header-actions">
                <button
                  type="button"
                  className="assistant-widget-hide"
                  onClick={handleHide}
                  aria-label="Ocultar esfera del asistente"
                  title="Ocultar esfera"
                >
                  <EyeOff size={16} />
                </button>
                <button
                  type="button"
                  className="assistant-widget-close"
                  onClick={() => setOpen(false)}
                  aria-label="Cerrar asistente"
                >
                  <X size={18} />
                </button>
              </div>
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

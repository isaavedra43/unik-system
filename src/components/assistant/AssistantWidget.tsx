'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bot, ExternalLink, X } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantChat } from './AssistantChat';
import { AgentAvatar } from './agents/AgentAvatar';
import {
  PRINCIPAL_AGENT,
  agentFromRecord,
  type AgentInfo,
  type AgentRecordDTO,
} from './agents/agent-types';

export interface AssistantWidgetProps {
  user: CurrentUser;
}

/**
 * Floating agent entry point: a FAB on every app page that opens a compact
 * drawer with the real agent chat (same API, same conversation flow — the
 * conversation is created lazily on the first send). Hidden on /app/assistant,
 * where the full experience already lives.
 */
export function AssistantWidget({ user }: AssistantWidgetProps) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentInfo>(PRINCIPAL_AGENT);
  const pathname = usePathname();
  const router = useRouter();

  // Real principal agent for the drawer head (falls back to the sentinel).
  useEffect(() => {
    let active = true;
    fetch('/app/assistant/api/agents')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { agents?: AgentRecordDTO[] } | null) => {
        if (!active) return;
        const principal = d?.agents?.find((a) => a.kind === 'principal') ?? d?.agents?.[0];
        if (principal) setAgent(agentFromRecord(principal));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // ESC closes the drawer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const goFull = useCallback(() => {
    setOpen(false);
    router.push('/app/assistant');
  }, [router]);

  return (
    <>
      {open && (
        <div className="agent-widget-drawer" role="dialog" aria-label={`Chat con ${agent.name}`}>
          <div className="agent-widget-head">
            <AgentAvatar agent={agent} size="sm" status={agent.status} />
            <div className="agent-widget-head-text">
              <span className="agent-widget-head-name">{agent.name}</span>
              <span className="agent-widget-head-sub">
                {agent.status === 'working' ? 'Trabajando…' : 'Disponible'}
              </span>
            </div>
            <button
              type="button"
              className="agent-widget-icon-btn"
              onClick={goFull}
              aria-label="Abrir el asistente completo"
              title="Abrir el asistente completo"
            >
              <ExternalLink size={15} />
            </button>
            <button
              type="button"
              className="agent-widget-icon-btn"
              onClick={() => setOpen(false)}
              aria-label="Cerrar chat"
            >
              <X size={16} />
            </button>
          </div>
          <div className="agent-widget-body">
            <AssistantChat
              conversationId={conversationId}
              context={{ page: pathname }}
              user={user}
              agent={agent}
              onConversationCreated={setConversationId}
              onToggleOps={goFull}
            />
          </div>
        </div>
      )}

      <button
        type="button"
        className="agent-widget-fab"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Cerrar el chat del agente' : 'Abrir el chat del agente'}
        aria-expanded={open}
      >
        {open ? <X size={20} /> : <Bot size={22} />}
      </button>
    </>
  );
}

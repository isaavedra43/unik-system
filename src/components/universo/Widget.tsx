'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Maximize2, Orbit, SquarePen, X } from 'lucide-react';
import type { AgentInfo, AgentRecordDTO } from './lib/types';
import { PRINCIPAL_AGENT, agentFromRecord } from './lib/agents';
import { AgentAvatar, IconButton } from './ui';
import { Chat, type ChatUser } from './chat/Chat';

/**
 * The agent on every page: a floating button that opens the same chat as
 * /app/assistant (same API, cards, approvals) with the page as context. The
 * full experience (workspace, team) is one click away.
 */
export function AssistantWidget({ user }: { user: ChatUser }) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentInfo>(PRINCIPAL_AGENT);
  const [working, setWorking] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch('/app/assistant/api/agents')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { agents?: AgentRecordDTO[] } | null) => {
        if (!alive) return;
        const principal = d?.agents?.find((a) => a.kind === 'principal') ?? d?.agents?.[0];
        if (principal) setAgent(agentFromRecord(principal));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const goFull = useCallback(() => {
    setOpen(false);
    router.push(conversationId ? `/app/assistant?c=${conversationId}` : '/app/assistant');
  }, [router, conversationId]);

  return (
    <>
      {open && (
        <div
          className="agent-widget-drawer uv-scope"
          role="dialog"
          aria-label={`Chat con ${agent.name}`}
        >
          <div className="agent-widget-head">
            <AgentAvatar agent={agent} size="sm" status={working ? 'working' : 'idle'} />
            <div className="agent-widget-head-text">
              <span className="agent-widget-head-name">{agent.name}</span>
              <span className="agent-widget-head-sub">
                {working ? 'Trabajando…' : 'Con el contexto de esta página'}
              </span>
            </div>
            <IconButton
              label="Nueva conversación"
              size="sm"
              onClick={() => setConversationId(null)}
            >
              <SquarePen size={15} />
            </IconButton>
            <IconButton label="Abrir UNIVERSO completo" size="sm" onClick={goFull}>
              <Maximize2 size={15} />
            </IconButton>
            <IconButton label="Cerrar" size="sm" onClick={() => setOpen(false)}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="agent-widget-body">
            <Chat
              user={user}
              conversationId={conversationId}
              onConversationCreated={setConversationId}
              agent={agent}
              context={{ page: pathname }}
              onOpenWorkspace={goFull}
              onToggleWorkspace={goFull}
              onWorkingChange={setWorking}
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
        {open ? <X size={20} /> : <Orbit size={22} />}
      </button>
    </>
  );
}

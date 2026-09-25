'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, MessagesSquare } from 'lucide-react';

/**
 * Folded inter-agent chatter inside the Principal's chat: "Mensajes de
 * Investigador y Cobranza". Renders only when the turn's meta carries real
 * agentMessages data — nothing emits it yet, so it stays hidden until then.
 */
export function AgentMessageCard({ data }: { data: { agents?: string[]; summary?: string } }) {
  const [open, setOpen] = useState(false);
  const agents = (data.agents ?? []).filter((a) => typeof a === 'string' && a.trim());
  if (agents.length === 0 || !data.summary) return null;
  const title = `Mensajes de ${agents.slice(0, 2).join(' y ')}${agents.length > 2 ? ` +${agents.length - 2}` : ''}`;
  return (
    <div className="agent-msg-card">
      <button
        type="button"
        className="agent-msg-card-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <MessagesSquare size={13} />
        <span>{title}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && <div className="agent-msg-card-body">{data.summary}</div>}
    </div>
  );
}

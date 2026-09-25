'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MotionConfig } from 'motion/react';
import { Menu, Monitor, X } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import { AssistantChat } from './AssistantChat';
import { AgentSidebar } from './agents/AgentSidebar';
import { OpsPanel } from './agents/OpsPanel';
import { TweaksPanel } from './agents/TweaksPanel';
import { useAssistantTweaks } from './agents/useAssistantTweaks';
import {
  PRINCIPAL_AGENT,
  agentFromRecord,
  type AgentInfo,
  type AgentRecordDTO,
} from './agents/agent-types';

export interface AssistantPageClientProps {
  user: CurrentUser;
}

type AgentTemplate = { name: string; purpose: string; icon: string; color: number } | null;

export function AssistantPageClient({ user }: AssistantPageClientProps) {
  const searchParams = useSearchParams();
  const requestedId = searchParams.get('c');
  const [activeId, setActiveId] = useState<string | null>(requestedId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The team — GET /api/agents does not exist yet, so the Principal (the
  // assistant itself, which is real) is always present and the rest degrades.
  const [agents, setAgents] = useState<AgentInfo[]>([PRINCIPAL_AGENT]);
  const [agentsSupported, setAgentsSupported] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState(PRINCIPAL_AGENT.id);
  const [newAgent, setNewAgent] = useState<{ open: boolean; template: AgentTemplate }>({
    open: false,
    template: null,
  });
  const { tweaks, setTweaks } = useAssistantTweaks();

  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? PRINCIPAL_AGENT;
  const workspaceOpen = tweaks.opsVisible;

  // Deep link from a notification ("the assistant finished"): open that thread.
  useEffect(() => {
    if (requestedId) setActiveId(requestedId);
  }, [requestedId]);

  // Team — degrades to just the Principal while the agents tables do not exist
  // (the API answers 200 with an empty list until the migration lands).
  useEffect(() => {
    let cancelled = false;
    fetch('/app/assistant/api/agents')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const d = (await res.json()) as { agents?: AgentRecordDTO[] };
        const list = (d.agents ?? [])
          .map(agentFromRecord)
          .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
        const principal = list.find((a) => a.kind === 'principal') ?? PRINCIPAL_AGENT;
        const rest = list.filter((a) => a.id !== principal.id);
        setAgents([principal, ...rest]);
        setAgentsSupported(list.length > 0);
        setActiveAgentId((cur) => (list.some((a) => a.id === cur) ? cur : principal.id));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Force-open the ops panel when the agent requests a secure input or starts
  // driving the virtual browser — the user must see the live screen / form.
  useEffect(() => {
    if (!activeId) return;
    const es = new EventSource(
      `/app/realtime/api/stream?channels=${encodeURIComponent(`assistant:${activeId}`)}`
    );
    const open = () => setTweaks({ opsVisible: true });
    es.addEventListener('workspace.secure_input', open);
    es.addEventListener('workspace.screen', open);
    return () => es.close();
  }, [activeId, setTweaks]);

  return (
    // MotionConfig propagates the "animations off" tweak to every motion/react
    // component below; the data-anim attr does the same for pure-CSS animation.
    <MotionConfig reducedMotion={tweaks.animations ? 'user' : 'always'}>
      <div
        className="assistant-page-body"
        data-density={tweaks.density}
        data-anim={tweaks.animations ? 'on' : 'off'}
      >
        {/* Mobile sidebar toggle */}
        <button
          type="button"
          className="assistant-sidebar-toggle"
          onClick={() => setSidebarOpen(true)}
          aria-label="Ver equipo y conversaciones"
        >
          <Menu size={18} />
          <span>Equipo</span>
        </button>

        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div
            className="assistant-sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar — becomes drawer on mobile */}
        <div className={`assistant-sidebar-wrapper ${sidebarOpen ? 'open' : ''}`}>
          <div className="assistant-sidebar-header-mobile">
            <span>Tu equipo</span>
            <button type="button" onClick={() => setSidebarOpen(false)} aria-label="Cerrar">
              <X size={20} />
            </button>
          </div>
          <AgentSidebar
            userId={user.id}
            activeId={activeId}
            onSelect={(id) => {
              setActiveId(id || null);
              setSidebarOpen(false);
            }}
            agents={agents}
            agentsSupported={agentsSupported}
            onAgentCreated={(a) => setAgents((prev) => [...prev, a])}
            activeAgentId={activeAgentId}
            onSelectAgent={(a) => setActiveAgentId(a.id)}
            newAgent={newAgent}
            onNewAgentOpenChange={(open) => setNewAgent({ open, template: null })}
          />
        </div>

        <div className="assistant-page-main">
          <AssistantChat
            conversationId={activeId}
            context={{ page: '/app/assistant' }}
            user={user}
            onConversationCreated={setActiveId}
            agent={activeAgent}
            agents={agents}
            onSelectAgent={setActiveAgentId}
            composerMode={tweaks.composerMode}
            onNewAgent={(template) => setNewAgent({ open: true, template: template ?? null })}
            onToggleOps={() => setTweaks({ opsVisible: !workspaceOpen })}
          />
        </div>

        {/* Ops panel — live feed of the team's operation. */}
        {!workspaceOpen && (
          <button
            type="button"
            className="assistant-workspace-toggle"
            onClick={() => setTweaks({ opsVisible: true })}
            aria-label="Abrir panel de operación"
            title="Panel de operación"
          >
            <Monitor size={18} />
          </button>
        )}
        {workspaceOpen && (
          <div className="assistant-workspace-col ops-col">
            <OpsPanel
              conversationId={activeId}
              userId={user.id}
              onClose={() => setTweaks({ opsVisible: false })}
              onOpenConversation={(id) => setActiveId(id)}
            />
          </div>
        )}

        <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} />
      </div>
    </MotionConfig>
  );
}

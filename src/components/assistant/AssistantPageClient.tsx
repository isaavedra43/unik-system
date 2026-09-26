'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MotionConfig } from 'motion/react';
import { X } from 'lucide-react';
import type { Layout } from 'react-resizable-panels';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/shadcn/resizable';
import { AssistantChat } from './AssistantChat';
import { AgentSidebar } from './agents/AgentSidebar';
import { WorkspacePanel } from './agents/WorkspacePanel';
import type { NewAgentTemplate } from './agents/NewAgentSheet';
import { TweaksPanel } from './agents/TweaksPanel';
import { useAssistantTweaks } from './agents/useAssistantTweaks';
import {
  PRINCIPAL_AGENT,
  agentFromRecord,
  type AgentInfo,
  type AgentRecordDTO,
  type WorkspaceTab,
} from './agents/agent-types';

export interface AssistantPageClientProps {
  user: CurrentUser;
}

type AgentTemplate = NewAgentTemplate | null;

const LAYOUT_KEY = 'unik.assistant.layout.v2';
const MOBILE_QUERY = '(max-width: 1023px)';

/** null until mounted — the page renders a neutral skeleton meanwhile. */
function useIsMobile(): boolean | null {
  const [mobile, setMobile] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return mobile;
}

function loadLayout(): Layout | undefined {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    return raw ? (JSON.parse(raw) as Layout) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * /app/assistant — UNIVERSO: three columns.
 *   team (agents · missions · threads) | conversation | workspace
 * Desktop: resizable panels (layout persisted per browser).
 * Mobile/tablet: the team is a drawer and the workspace a full sheet.
 */
export function AssistantPageClient({ user }: AssistantPageClientProps) {
  const searchParams = useSearchParams();
  const requestedId = searchParams.get('c');
  const isMobile = useIsMobile();
  const [activeId, setActiveId] = useState<string | null>(requestedId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [wsSheetOpen, setWsSheetOpen] = useState(false);
  const [wsTab, setWsTab] = useState<WorkspaceTab>('browser');
  const [wsHint, setWsHint] = useState<{ tab: WorkspaceTab; at: number } | null>(null);
  const [wsBadge, setWsBadge] = useState(false);
  const [layout, setLayout] = useState<Layout | undefined>(undefined);
  const [layoutReady, setLayoutReady] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([PRINCIPAL_AGENT]);
  const [agentsSupported, setAgentsSupported] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState(PRINCIPAL_AGENT.id);
  const [newAgent, setNewAgent] = useState<{ open: boolean; template: AgentTemplate }>({
    open: false,
    template: null,
  });
  const { tweaks, setTweaks } = useAssistantTweaks();

  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? PRINCIPAL_AGENT;
  const workspaceOpen = isMobile ? wsSheetOpen : tweaks.opsVisible;

  useEffect(() => {
    setLayout(loadLayout());
    setLayoutReady(true);
  }, []);

  // Deep link from a notification ("the assistant finished"): open that thread.
  useEffect(() => {
    if (requestedId) setActiveId(requestedId);
  }, [requestedId]);

  // The team — degrades to the Principal while the agents tables do not exist.
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

  // A tool that has a surface brings it up: the workspace opens on desktop,
  // and on mobile the header button lights up instead of stealing the screen.
  const handleWorkspaceHint = useCallback(
    (tab: WorkspaceTab) => {
      setWsHint({ tab, at: Date.now() });
      if (isMobile) setWsBadge(true);
      else setTweaks({ opsVisible: true });
    },
    [isMobile, setTweaks]
  );

  const toggleWorkspace = useCallback(() => {
    if (isMobile) {
      setWsSheetOpen((v) => !v);
      setWsBadge(false);
    } else {
      setTweaks({ opsVisible: !tweaks.opsVisible });
    }
  }, [isMobile, setTweaks, tweaks.opsVisible]);

  // Keyboard: ⌘/Ctrl+K focuses the team search, ⌘/Ctrl+J toggles the workspace,
  // Escape closes mobile overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isMobile) setSidebarOpen(true);
        window.dispatchEvent(new CustomEvent('uv:focus-search'));
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggleWorkspace();
      } else if (e.key === 'Escape') {
        setSidebarOpen(false);
        setWsSheetOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, toggleWorkspace]);

  const saveLayout = useCallback((next: Layout) => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  }, []);

  const sidebar = (
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
      onSelectAgent={(a) => {
        setActiveAgentId(a.id);
        setSidebarOpen(false);
      }}
      newAgent={newAgent}
      onNewAgentOpenChange={(open) => setNewAgent({ open, template: null })}
    />
  );

  const chat = (
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
      onNewConversation={() => setActiveId(null)}
      onToggleOps={toggleWorkspace}
      workspaceOpen={workspaceOpen}
      workspaceBadge={wsBadge}
      onOpenSidebar={() => setSidebarOpen(true)}
      onWorkspaceHint={handleWorkspaceHint}
    />
  );

  const workspace = (
    <WorkspacePanel
      conversationId={activeId}
      userId={user.id}
      tab={wsTab}
      onTabChange={setWsTab}
      hint={wsHint}
      onClose={() => (isMobile ? setWsSheetOpen(false) : setTweaks({ opsVisible: false }))}
      onOpenConversation={(id) => {
        setActiveId(id);
        setWsSheetOpen(false);
      }}
      onSendText={(text) => {
        window.dispatchEvent(new CustomEvent('uv:send', { detail: { text } }));
        setWsSheetOpen(false);
      }}
    />
  );

  return (
    <MotionConfig reducedMotion={tweaks.animations ? 'user' : 'always'}>
      <div
        className="uv-root"
        data-density={tweaks.density}
        data-anim={tweaks.animations ? 'on' : 'off'}
      >
        {isMobile === null || !layoutReady ? (
          <div className="uv-layout" aria-busy="true" style={{ display: 'flex' }}>
            <div
              className="uv-panel"
              style={{ width: 286, flexDirection: 'column', padding: 12, gap: 8 }}
            >
              <div className="uv-skeleton" style={{ height: 38 }} />
              <div className="uv-skeleton" />
              <div className="uv-skeleton" />
              <div className="uv-skeleton" />
            </div>
            <div className="uv-panel" style={{ flex: 1 }} />
          </div>
        ) : isMobile ? (
          <>
            <div className="uv-chat" style={{ flex: 1 }}>
              {chat}
            </div>
            {sidebarOpen && (
              <div
                className="uv-backdrop"
                onClick={() => setSidebarOpen(false)}
                aria-hidden="true"
              />
            )}
            <div
              className={`uv-side-drawer ${sidebarOpen ? 'is-open' : ''}`}
              aria-hidden={!sidebarOpen}
            >
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <div className="uv-side-drawer-head">
                  <span>Tu equipo</span>
                  <button
                    type="button"
                    className="uv-icon-btn"
                    onClick={() => setSidebarOpen(false)}
                    aria-label="Cerrar"
                  >
                    <X size={18} />
                  </button>
                </div>
                {sidebar}
              </div>
            </div>
            {wsSheetOpen && <div className="uv-ws-sheet">{workspace}</div>}
          </>
        ) : (
          <ResizablePanelGroup
            orientation="horizontal"
            className="uv-layout"
            defaultLayout={layout}
            onLayoutChanged={saveLayout}
          >
            <ResizablePanel
              id="sidebar"
              defaultSize={286}
              minSize={230}
              maxSize={420}
              className="uv-panel"
            >
              {sidebar}
            </ResizablePanel>
            <ResizableHandle className="uv-handle" />
            <ResizablePanel id="chat" minSize={380} className="uv-panel">
              {chat}
            </ResizablePanel>
            {workspaceOpen && (
              <>
                <ResizableHandle className="uv-handle" />
                <ResizablePanel
                  id="workspace"
                  defaultSize={540}
                  minSize={380}
                  maxSize={960}
                  className="uv-panel"
                >
                  {workspace}
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}

        <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} />
      </div>
    </MotionConfig>
  );
}

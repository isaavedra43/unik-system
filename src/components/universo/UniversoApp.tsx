'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MotionConfig } from 'motion/react';
import { X } from 'lucide-react';
import type { Layout } from 'react-resizable-panels';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/shadcn/resizable';
import { AssistantPreferencesPanel } from '@/components/copilot/AssistantPreferencesPanel';
import type { AgentTeamTemplate } from '@/modules/agents/agent-templates';
import type { AgentInfo, AgentRecordDTO, MessageData, TeamTask, WorkspaceTab } from './lib/types';
import { PRINCIPAL_AGENT, agentFromRecord } from './lib/agents';
import { useRealtime } from './lib/realtime';
import { useUniversoPrefs } from './lib/prefs';
import { IconButton } from './ui';
import { Chat, type ChatUser } from './chat/Chat';
import { Sidebar } from './shell/Sidebar';
import { UserMenu } from './shell/UserMenu';
import { NewAgentDialog } from './shell/NewAgentDialog';
import { Workspace } from './workspace/Workspace';

/**
 * /app/assistant — UNIVERSO. Three columns: the team (agents, work in
 * progress, missions, conversations) · the conversation · the workspace (the
 * agents' browser, the virtual computer, the team, the files). Desktop:
 * resizable, layout remembered. Tablet/phone: the team is a drawer and the
 * workspace a full-screen sheet.
 */

const LAYOUT_KEY = 'unik.universo.layout.v1';
const MOBILE_QUERY = '(max-width: 1023px)';

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

function setUrlThread(id: string | null) {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('c', id);
    else url.searchParams.delete('c');
    url.searchParams.delete('settings');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* ignore */
  }
}

export function UniversoApp({ user }: { user: ChatUser }) {
  const params = useSearchParams();
  const isMobile = useIsMobile();
  const { prefs, setPrefs, ready } = useUniversoPrefs();
  const [conversationId, setConversationId] = useState<string | null>(params.get('c'));
  const [agents, setAgents] = useState<AgentInfo[]>([PRINCIPAL_AGENT]);
  const [activeAgentId, setActiveAgentId] = useState(PRINCIPAL_AGENT.id);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [working, setWorking] = useState(false);
  const [wsTab, setWsTab] = useState<WorkspaceTab>('browser');
  const [sheet, setSheet] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [badge, setBadge] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dialog, setDialog] = useState<{ open: boolean; team: AgentTeamTemplate | null }>({
    open: false,
    team: null,
  });
  const [prefsOpen, setPrefsOpen] = useState(params.get('settings') === '1');
  const [teach, setTeach] = useState(false);
  const [layout, setLayout] = useState<Layout | undefined>(undefined);
  const [layoutReady, setLayoutReady] = useState(false);

  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? agents[0] ?? PRINCIPAL_AGENT;
  const workspaceOpen = isMobile ? sheet : prefs.workspaceOpen;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_KEY);
      if (raw) setLayout(JSON.parse(raw) as Layout);
    } catch {
      /* private mode */
    }
    setLayoutReady(true);
  }, []);

  // Deep link (?c=) from notifications.
  useEffect(() => {
    const c = params.get('c');
    if (c) setConversationId(c);
  }, [params]);

  // The team (degrades to the built-in coordinator without the agents tables).
  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch('/app/assistant/api/agents');
      if (!res.ok) return;
      const d = (await res.json()) as { agents?: AgentRecordDTO[] };
      const list = (d.agents ?? [])
        .filter((a) => a.status !== 'archived')
        .map(agentFromRecord)
        .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
      const principal = list.find((a) => a.kind === 'principal') ?? PRINCIPAL_AGENT;
      const rest = list.filter((a) => a.id !== principal.id);
      setAgents([principal, ...rest]);
      setActiveAgentId((cur) =>
        cur === PRINCIPAL_AGENT.id || !list.some((a) => a.id === cur) ? principal.id : cur
      );
    } catch {
      /* keep the coordinator */
    }
  }, []);
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  // Delegated work: recent history + live updates.
  useEffect(() => {
    fetch('/app/assistant/api/tasks')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { tasks?: TeamTask[] } | null) => d?.tasks && setTasks(d.tasks))
      .catch(() => undefined);
  }, []);
  useRealtime([`user:${user.id}`], ['agent.task'], (_type, p) => {
    const taskId = typeof p.taskId === 'string' ? p.taskId : null;
    if (!taskId) return;
    setTasks((prev) => {
      const old = prev.find((t) => t.taskId === taskId);
      const next: TeamTask = {
        taskId,
        status: typeof p.status === 'string' ? p.status : (old?.status ?? 'running'),
        title: typeof p.title === 'string' ? p.title : (old?.title ?? 'Tarea'),
        agentId: typeof p.agentId === 'string' ? p.agentId : (old?.agentId ?? null),
        conversationId:
          typeof p.conversationId === 'string' ? p.conversationId : (old?.conversationId ?? null),
        reportPreview:
          typeof p.reportPreview === 'string' ? p.reportPreview : (old?.reportPreview ?? null),
        durationMs: typeof p.durationMs === 'number' ? p.durationMs : (old?.durationMs ?? null),
        updatedAt: Date.now(),
      };
      return [next, ...prev.filter((t) => t.taskId !== taskId)].slice(0, 40);
    });
  });

  // Live status of every agent (working while it has running tasks).
  const agentsWithStatus = useMemo(() => {
    const busy = new Set(
      tasks.filter((t) => ['queued', 'pending', 'running'].includes(t.status)).map((t) => t.agentId)
    );
    return agents.map((a) =>
      a.status === 'offline'
        ? a
        : {
            ...a,
            status: (busy.has(a.id) || (working && a.id === activeAgent.id)
              ? 'working'
              : 'idle') as AgentInfo['status'],
          }
    );
  }, [agents, tasks, working, activeAgent.id]);

  const selectConversation = useCallback(
    (id: string | null, agentId?: string | null) => {
      setConversationId(id);
      setUrlThread(id);
      if (agentId !== undefined) {
        const owner = agentId
          ? agents.find((a) => a.id === agentId)
          : agents.find((a) => a.kind === 'principal');
        if (owner) setActiveAgentId(owner.id);
      }
      setDrawer(false);
      setSheet(false);
    },
    [agents]
  );

  const newConversation = useCallback(() => {
    setConversationId(null);
    setUrlThread(null);
    setDrawer(false);
  }, []);

  const onCreated = useCallback((id: string) => {
    setConversationId(id);
    setUrlThread(id);
    setRefreshKey((k) => k + 1);
  }, []);

  const onThreadAgent = useCallback(
    (agentId: string | null) => {
      const owner = agentId ? agents.find((a) => a.id === agentId) : null;
      if (owner && owner.id !== activeAgentId) setActiveAgentId(owner.id);
    },
    [agents, activeAgentId]
  );

  const showWorkspace = useCallback(
    (tab: WorkspaceTab) => {
      setWsTab(tab);
      if (isMobile) setSheet(true);
      else setPrefs({ workspaceOpen: true });
    },
    [isMobile, setPrefs]
  );

  // A tool with a surface started: desktop opens it; mobile lights the button.
  const onWorkspaceHint = useCallback(
    (tab: WorkspaceTab) => {
      setWsTab(tab);
      if (isMobile) setBadge(true);
      else setPrefs({ workspaceOpen: true });
    },
    [isMobile, setPrefs]
  );

  const toggleWorkspace = useCallback(() => {
    if (isMobile) {
      setSheet((v) => !v);
      setBadge(false);
    } else setPrefs({ workspaceOpen: !prefs.workspaceOpen });
  }, [isMobile, prefs.workspaceOpen, setPrefs]);

  // Generative cards (and the home screen) ask the shell to open things.
  useEffect(() => {
    const onWorkspace = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: WorkspaceTab }>).detail?.tab;
      if (tab && ['browser', 'computer', 'files', 'team'].includes(tab)) showWorkspace(tab);
    };
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (typeof id === 'string' && id) selectConversation(id);
    };
    window.addEventListener('uv:workspace', onWorkspace);
    window.addEventListener('uv:open-conversation', onOpen);
    return () => {
      window.removeEventListener('uv:workspace', onWorkspace);
      window.removeEventListener('uv:open-conversation', onOpen);
    };
  }, [showWorkspace, selectConversation]);

  // ⌘K search · ⌘J workspace · ⌘⇧O new conversation · Esc closes overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'k') {
        e.preventDefault();
        if (isMobile) setDrawer(true);
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('uv:focus-search')), 30);
      } else if (mod && k === 'j') {
        e.preventDefault();
        toggleWorkspace();
      } else if (mod && e.shiftKey && k === 'o') {
        e.preventDefault();
        newConversation();
      } else if (e.key === 'Escape') {
        setDrawer(false);
        if (isMobile) setSheet(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, toggleWorkspace, newConversation]);

  const agentName = useCallback(
    (id?: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? null) : null),
    [agents]
  );

  const sidebar = (
    <Sidebar
      agents={agentsWithStatus}
      activeAgentId={activeAgent.id}
      onSelectAgent={(a) => {
        if (a.id !== activeAgent.id) {
          setActiveAgentId(a.id);
          newConversation();
        }
        setDrawer(false);
      }}
      onNewAgent={() => setDialog({ open: true, team: null })}
      activeConversationId={conversationId}
      onSelectConversation={selectConversation}
      onNewConversation={newConversation}
      teamTasks={tasks}
      refreshKey={refreshKey}
      footer={
        <UserMenu
          name={user.name}
          username={user.username}
          prefs={prefs}
          setPrefs={setPrefs}
          onOpenPreferences={() => setPrefsOpen(true)}
        />
      }
    />
  );

  const chat = (
    <Chat
      user={user}
      conversationId={conversationId}
      onConversationCreated={onCreated}
      agent={agentsWithStatus.find((a) => a.id === activeAgent.id) ?? activeAgent}
      agents={isMobile ? agentsWithStatus : undefined}
      onSelectAgent={(id) => {
        setActiveAgentId(id);
        newConversation();
      }}
      context={{ page: '/app/assistant' }}
      onOpenSidebar={() => setDrawer(true)}
      onNewConversation={newConversation}
      workspaceOpen={workspaceOpen}
      workspaceBadge={badge}
      onToggleWorkspace={toggleWorkspace}
      onWorkspaceHint={onWorkspaceHint}
      onOpenWorkspace={showWorkspace}
      onTeach={() => {
        setTeach(true);
        showWorkspace('browser');
      }}
      onNewTeam={(team) => setDialog({ open: true, team })}
      teamTasks={tasks}
      agentName={agentName}
      defaultMode={prefs.composerMode}
      onWorkingChange={setWorking}
      onMessages={setMessages}
      onThreadAgent={onThreadAgent}
    />
  );

  const workspace = (
    <Workspace
      conversationId={conversationId}
      messages={messages}
      agentWorking={working}
      tab={wsTab}
      onTabChange={setWsTab}
      visible={workspaceOpen}
      teachRequested={teach}
      onTeachHandled={() => setTeach(false)}
      teamTasks={tasks}
      agents={agentsWithStatus}
      onOpenConversation={(id) => selectConversation(id)}
      onClose={() => (isMobile ? setSheet(false) : setPrefs({ workspaceOpen: false }))}
      onActivity={(tab) => {
        if (isMobile && !sheet) setBadge(true);
        void tab;
      }}
    />
  );

  const loadingShell = isMobile === null || !layoutReady || !ready;

  return (
    <MotionConfig reducedMotion={prefs.animations ? 'user' : 'always'}>
      <div
        className="uv-root"
        data-density={prefs.density}
        data-anim={prefs.animations ? 'on' : 'off'}
      >
        {loadingShell ? (
          <div className="uv-layout" aria-busy="true" style={{ display: 'flex' }}>
            <div
              className="uv-panel uv-only-desktop"
              style={{
                width: 280,
                flexDirection: 'column',
                padding: 14,
                gap: 10,
                background: 'var(--uv-side-bg)',
              }}
            >
              <div className="uv-skel" style={{ height: 38 }} />
              <div className="uv-skel" style={{ height: 34 }} />
              <div className="uv-skel" style={{ height: 44, marginTop: 16 }} />
              <div className="uv-skel" style={{ height: 44 }} />
            </div>
            <div className="uv-panel" style={{ flex: 1 }} />
          </div>
        ) : isMobile ? (
          <>
            <div className="uv-panel" style={{ flex: 1 }}>
              {chat}
            </div>
            {drawer && (
              <>
                <div className="uv-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
                <div
                  className="uv-drawer"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Tu equipo y conversaciones"
                >
                  <div className="uv-drawer-close">
                    <IconButton label="Cerrar" onClick={() => setDrawer(false)} tip={false}>
                      <X size={18} />
                    </IconButton>
                  </div>
                  {sidebar}
                </div>
              </>
            )}
            {sheet && (
              <div
                className="uv-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Espacio de trabajo"
              >
                {workspace}
              </div>
            )}
          </>
        ) : (
          <ResizablePanelGroup
            orientation="horizontal"
            className="uv-layout"
            defaultLayout={layout}
            onLayoutChanged={(next) => {
              try {
                window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
              } catch {
                /* private mode */
              }
            }}
          >
            <ResizablePanel
              id="team"
              defaultSize={280}
              minSize={232}
              maxSize={400}
              className="uv-panel"
            >
              {sidebar}
            </ResizablePanel>
            <ResizableHandle className="uv-handle" />
            <ResizablePanel id="chat" minSize={420} className="uv-panel">
              {chat}
            </ResizablePanel>
            {workspaceOpen && (
              <>
                <ResizableHandle className="uv-handle" />
                <ResizablePanel
                  id="workspace"
                  defaultSize={560}
                  minSize={380}
                  maxSize={1000}
                  className="uv-panel"
                >
                  {workspace}
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}

        <NewAgentDialog
          open={dialog.open}
          onOpenChange={(open) => setDialog((d) => ({ open, team: open ? d.team : null }))}
          initialTeam={dialog.team}
          existingNames={agents.map((a) => a.name)}
          onCreated={(created, { select }) => {
            setAgents((prev) => [
              ...prev,
              ...created.filter((c) => !prev.some((p) => p.id === c.id)),
            ]);
            if (select && created[0]) {
              setActiveAgentId(created[0].id);
              newConversation();
            }
            void loadAgents();
          }}
          onKickoff={(text) => {
            const principal = agents.find((a) => a.kind === 'principal');
            if (principal) setActiveAgentId(principal.id);
            newConversation();
            // Let the new (empty) thread mount, then hand the kickoff to the director.
            window.setTimeout(
              () => window.dispatchEvent(new CustomEvent('uv:send', { detail: { text } })),
              250
            );
          }}
        />
        <AssistantPreferencesPanel open={prefsOpen} onClose={() => setPrefsOpen(false)} />
      </div>
    </MotionConfig>
  );
}

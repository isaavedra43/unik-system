'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import {
  CalendarClock,
  Flag,
  Pencil,
  Plus,
  Puzzle,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { listItem } from '@/lib/motion';
import { AssistantPreferencesPanel } from '@/components/copilot/AssistantPreferencesPanel';
import {
  createConversationAction,
  deleteConversationAction,
  renameConversationAction,
  toggleStarAction,
} from '@/app/app/assistant/actions';
import { PRINCIPAL_AGENT, relTime, type AgentInfo } from './agent-types';
import { AgentAvatar } from './AgentAvatar';
import { InstallAppButton } from './InstallAppButton';
import { NewAgentSheet, type NewAgentTemplate } from './NewAgentSheet';

interface ConversationItem {
  id: string;
  title: string;
  isStarred: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionItem {
  id: string;
  goal: string;
  status: string;
  plan?: { steps?: Array<{ title: string; status: string }> } | null;
  schedule?: string | null;
  nextRunAt?: string | null;
  createdAt?: string;
  completedAt?: string | null;
  conversationId?: string | null;
}

export const MISSION_STATUS_LABEL: Record<string, string> = {
  awaiting_approval: 'Por aprobar',
  active: 'En curso',
  blocked: 'Pausada',
  done: 'Completada',
  failed: 'Falló',
  cancelled: 'Cancelada',
};

export function missionProgress(m: MissionItem): { done: number; total: number } {
  const steps = m.plan?.steps ?? [];
  return {
    done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: steps.length,
  };
}

export function missionSubtitle(m: MissionItem): string {
  const { done, total } = missionProgress(m);
  const label = MISSION_STATUS_LABEL[m.status] ?? m.status;
  if (m.schedule?.startsWith('daily:'))
    return `Rutina diaria ${m.schedule.slice(6)} · ${label.toLowerCase()}`;
  if (m.schedule?.startsWith('every:'))
    return `Cada ${m.schedule.slice(6)} min · ${label.toLowerCase()}`;
  return total > 0 ? `${label} · ${done}/${total} tareas` : label;
}

type ThreadGroup = { key: string; label: string; items: ConversationItem[] };

/** Favoritas · Hoy · Ayer · Últimos 7 días · Anteriores */
function groupThreads(list: ConversationItem[]): ThreadGroup[] {
  const groups: Record<string, ConversationItem[]> = {
    starred: [],
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  for (const c of list) {
    if (c.isStarred) {
      groups.starred.push(c);
      continue;
    }
    const t = Date.parse(c.lastMessageAt ?? c.updatedAt ?? c.createdAt);
    if (Number.isNaN(t) || t < startOfToday - 6 * dayMs) groups.older.push(c);
    else if (t >= startOfToday) groups.today.push(c);
    else if (t >= startOfToday - dayMs) groups.yesterday.push(c);
    else groups.week.push(c);
  }
  const labels: Record<string, string> = {
    starred: 'Favoritas',
    today: 'Hoy',
    yesterday: 'Ayer',
    week: 'Últimos 7 días',
    older: 'Anteriores',
  };
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([key, items]) => ({ key, label: labels[key], items }));
}

export interface AgentSidebarProps {
  userId: string;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Lifted state — the page owns the team so the mobile strip shares it. */
  agents: AgentInfo[];
  agentsSupported: boolean;
  onAgentCreated?: (agent: AgentInfo) => void;
  activeAgentId?: string;
  onSelectAgent?: (agent: AgentInfo) => void;
  /** Controlled NewAgentSheet — the empty-state cards can open it pre-filled. */
  newAgent?: {
    open: boolean;
    template: NewAgentTemplate | null;
  };
  onNewAgentOpenChange?: (open: boolean) => void;
}

export function AgentSidebar({
  userId: _userId,
  activeId,
  onSelect,
  agents,
  agentsSupported,
  onAgentCreated,
  activeAgentId,
  onSelectAgent,
  newAgent,
  onNewAgentOpenChange,
}: AgentSidebarProps) {
  void _userId;
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [missionsLoaded, setMissionsLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [sheetOpenLocal, setSheetOpenLocal] = useState(false);
  const teamRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchParams = useSearchParams();
  const router = useRouter();

  const sheetOpen = newAgent ? newAgent.open : sheetOpenLocal;
  const setSheetOpen = (v: boolean) => {
    if (onNewAgentOpenChange) onNewAgentOpenChange(v);
    else setSheetOpenLocal(v);
  };

  // Deep link used by other surfaces ("Configurar en Asistente IA").
  useEffect(() => {
    if (searchParams.get('settings') === '1') {
      setPrefsOpen(true);
      router.replace('/app/assistant', { scroll: false });
    }
  }, [searchParams, router]);

  // ⌘K from the page focuses the search box.
  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener('uv:focus-search', focus);
    return () => window.removeEventListener('uv:focus-search', focus);
  }, []);

  // Recent missions — real API.
  useEffect(() => {
    let cancelled = false;
    fetch('/app/assistant/api/missions')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const d = (await res.json()) as { missions?: MissionItem[] };
        setMissions((d.missions ?? []).slice(0, 6));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setMissionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const url = search
        ? `/app/assistant/api/conversations?search=${encodeURIComponent(search)}`
        : '/app/assistant/api/conversations';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // A new thread created from the chat (first message) shows up without a reload.
  useEffect(() => {
    if (activeId && !conversations.some((c) => c.id === activeId)) void loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  async function handleNew() {
    const { id } = await createConversationAction({});
    await loadConversations();
    onSelect(id);
  }

  async function handleDelete(id: string, title: string) {
    if (!window.confirm(`¿Eliminar la conversación «${title}»?`)) return;
    await deleteConversationAction({ id });
    await loadConversations();
    if (activeId === id) onSelect('');
  }

  async function handleStar(id: string) {
    await toggleStarAction({ id });
    await loadConversations();
  }

  async function handleRename(id: string) {
    if (!editTitle.trim()) {
      setEditingId(null);
      return;
    }
    await renameConversationAction({ id, title: editTitle.trim() });
    setEditingId(null);
    await loadConversations();
  }

  // Arrow-key navigation through the team list.
  function handleTeamKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(
      teamRef.current?.querySelectorAll<HTMLButtonElement>('.uv-agent') ?? []
    );
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0) return;
    e.preventDefault();
    items[e.key === 'ArrowDown' ? idx + 1 : idx - 1]?.focus();
  }

  const q = search.trim().toLowerCase();
  const filteredAgents = q ? agents.filter((a) => a.name.toLowerCase().includes(q)) : agents;
  const filteredMissions = q ? missions.filter((m) => m.goal.toLowerCase().includes(q)) : missions;
  const teamEmpty = filteredAgents.length <= 1 && !agentsSupported;
  const selectedAgentId = activeAgentId ?? PRINCIPAL_AGENT.id;
  const routines = filteredMissions.filter((m) => m.schedule);
  const recentMissions = filteredMissions.filter((m) => !m.schedule);
  const groups = groupThreads(conversations);

  return (
    <div className="uv-side">
      <div className="uv-side-top">
        <button type="button" className="uv-btn-primary" onClick={() => setSheetOpen(true)}>
          <Plus size={15} /> Nuevo agente
        </button>
        <label className="uv-search">
          <Search size={14} />
          <input
            ref={searchRef}
            type="text"
            placeholder="Buscar agentes o conversaciones"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar agentes, misiones y conversaciones"
          />
          {!search && <kbd>⌘K</kbd>}
        </label>
      </div>

      <div className="uv-side-scroll">
        {/* Tu equipo */}
        <div className="uv-section">
          <div className="uv-section-label">
            <span>Tu equipo</span>
            <span>{agents.length}</span>
          </div>
          <div ref={teamRef} role="list" onKeyDown={handleTeamKeyDown}>
            <AnimatePresence initial={false}>
              {filteredAgents.map((a) => {
                const working = a.status === 'working';
                return (
                  <motion.div
                    key={a.id}
                    variants={listItem}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    layout={false}
                  >
                    <button
                      type="button"
                      role="listitem"
                      className={cn('uv-agent', selectedAgentId === a.id && 'is-active')}
                      onClick={() => onSelectAgent?.(a)}
                      aria-current={selectedAgentId === a.id ? 'true' : undefined}
                    >
                      <AgentAvatar agent={a} status={a.status ?? 'idle'} />
                      <span className="uv-agent-text">
                        <span className="uv-agent-name">
                          {a.name}
                          {a.kind === 'principal' && <span className="uv-badge-jefe">Jefe</span>}
                        </span>
                        <span className={cn('uv-agent-sub', working && 'is-working')}>
                          {a.statusLine ?? (working ? 'Trabajando…' : (a.purpose ?? 'Disponible'))}
                        </span>
                      </span>
                      {a.unread && (
                        <span className="uv-agent-unread" aria-label="Tiene novedades" />
                      )}
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {teamEmpty && !search && (
              <button type="button" className="uv-agent-ghost" onClick={() => setSheetOpen(true)}>
                <Plus size={13} /> Crea especialistas para delegar trabajo
              </button>
            )}
          </div>
        </div>

        {/* Rutinas (missions with a schedule) */}
        {routines.length > 0 && (
          <div className="uv-section">
            <div className="uv-section-label">
              <span>Rutinas</span>
            </div>
            {routines.map((m) => (
              <button
                key={m.id}
                type="button"
                className="uv-mission"
                onClick={() => m.conversationId && onSelect(m.conversationId)}
                disabled={!m.conversationId}
                title={m.goal}
              >
                <CalendarClock size={13} className="uv-mission-icon" />
                <span className="uv-agent-text">
                  <span className="uv-agent-name">{m.goal}</span>
                  <span className="uv-agent-sub">{missionSubtitle(m)}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Misiones recientes */}
        {missionsLoaded && (recentMissions.length > 0 || !search) && (
          <div className="uv-section">
            <div className="uv-section-label">
              <span>Misiones</span>
            </div>
            {recentMissions.length === 0 ? (
              <div className="uv-empty-inline">Sin misiones — pídele una al Central</div>
            ) : (
              recentMissions.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="uv-mission"
                  onClick={() => m.conversationId && onSelect(m.conversationId)}
                  disabled={!m.conversationId}
                  title={m.goal}
                >
                  <Flag size={13} className="uv-mission-icon" />
                  <span className="uv-agent-text">
                    <span className="uv-agent-name">{m.goal}</span>
                    <span className="uv-agent-sub">{missionSubtitle(m)}</span>
                  </span>
                  <span className="uv-mission-time">
                    {relTime(m.completedAt ?? m.nextRunAt ?? m.createdAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* Conversaciones */}
        <div className="uv-section">
          <div className="uv-section-label">
            <span>Conversaciones</span>
            <button
              type="button"
              className="uv-section-add"
              onClick={() => void handleNew()}
              aria-label="Nueva conversación"
              title="Nueva conversación"
            >
              <Plus size={13} />
            </button>
          </div>
          {loading && (
            <>
              <div className="uv-skeleton" />
              <div className="uv-skeleton" style={{ width: '80%' }} />
              <div className="uv-skeleton" style={{ width: '60%' }} />
            </>
          )}
          {!loading && conversations.length === 0 && (
            <div className="uv-empty-inline">
              {search ? 'Sin resultados' : 'Aún no hay conversaciones'}
            </div>
          )}
          {groups.map((g) => (
            <React.Fragment key={g.key}>
              {groups.length > 1 && <div className="uv-thread-group">{g.label}</div>}
              {g.items.map((c) => (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  className={cn('uv-thread', activeId === c.id && 'is-active')}
                  onClick={() => onSelect(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(c.id);
                    }
                  }}
                  title={c.title}
                >
                  {editingId === c.id ? (
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') void handleRename(c.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => void handleRename(c.id)}
                      autoFocus
                      className="uv-thread-rename"
                      aria-label="Nuevo título"
                    />
                  ) : (
                    <>
                      {c.isStarred && <Star size={12} className="uv-thread-star" />}
                      <span className="uv-thread-title">{c.title}</span>
                      <span className="uv-thread-actions">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleStar(c.id);
                          }}
                          aria-label={c.isStarred ? 'Quitar de favoritas' : 'Marcar favorita'}
                          title={c.isStarred ? 'Quitar de favoritas' : 'Favorita'}
                        >
                          <Star size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(c.id);
                            setEditTitle(c.title);
                          }}
                          aria-label="Renombrar"
                          title="Renombrar"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="is-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDelete(c.id, c.title);
                          }}
                          aria-label="Eliminar"
                          title="Eliminar"
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="uv-side-foot">
        <button type="button" className="uv-side-link" onClick={() => setPrefsOpen(true)}>
          <SlidersHorizontal size={15} />
          <span>Preferencias y memoria</span>
        </button>
        <Link href="/app/assistant/extensions" className="uv-side-link">
          <Puzzle size={15} />
          <span>Extensiones y skills</span>
        </Link>
        <InstallAppButton />
      </div>
      <AssistantPreferencesPanel open={prefsOpen} onClose={() => setPrefsOpen(false)} />
      <NewAgentSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        supported={agentsSupported}
        template={newAgent?.template ?? null}
        onCreated={(a) => {
          onAgentCreated?.(a);
          onSelectAgent?.(a);
        }}
      />
    </div>
  );
}

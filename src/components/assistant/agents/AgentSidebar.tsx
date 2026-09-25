'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { Flag, Pencil, Plus, Puzzle, Search, SlidersHorizontal, Star, Trash2 } from 'lucide-react';
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
import { NewAgentSheet } from './NewAgentSheet';

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
    template: { name: string; purpose: string; icon: string; color: number } | null;
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

  // Recent missions — real API.
  useEffect(() => {
    let cancelled = false;
    fetch('/app/assistant/api/missions')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const d = (await res.json()) as { missions?: MissionItem[] };
        setMissions((d.missions ?? []).slice(0, 5));
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

  async function handleNew() {
    const { id } = await createConversationAction({});
    await loadConversations();
    onSelect(id);
  }

  async function handleDelete(id: string) {
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
      teamRef.current?.querySelectorAll<HTMLButtonElement>('.agent-item') ?? []
    );
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
    items[next]?.focus();
  }

  const filteredAgents = search
    ? agents.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents;
  const filteredMissions = search
    ? missions.filter((m) => m.goal.toLowerCase().includes(search.toLowerCase()))
    : missions;
  const teamEmpty = filteredAgents.length <= 1 && !agentsSupported;
  const selectedAgentId = activeAgentId ?? PRINCIPAL_AGENT.id;

  return (
    <div className="assistant-sidebar agent-sidebar">
      <div className="assistant-sidebar-header">
        <button type="button" className="agent-btn-primary" onClick={() => setSheetOpen(true)}>
          <Plus size={15} /> Nuevo agente
        </button>
        <div className="assistant-sidebar-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Buscar…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar agentes, misiones y conversaciones"
          />
        </div>
      </div>

      <div className="assistant-sidebar-list agent-sidebar-scroll">
        {/* Tu equipo */}
        <div className="agent-section">
          <div className="agent-section-label">Tu equipo</div>
          <div className="agent-team" ref={teamRef} role="list" onKeyDown={handleTeamKeyDown}>
            <AnimatePresence initial={false}>
              {filteredAgents.map((a) => (
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
                    className={cn('agent-item', selectedAgentId === a.id && 'active')}
                    onClick={() => onSelectAgent?.(a)}
                  >
                    <AgentAvatar agent={a} status={a.status ?? 'idle'} />
                    <span className="agent-item-text">
                      <span className="agent-item-title">
                        {a.name}
                        {a.kind === 'principal' && <span className="agent-badge-jefe">Jefe</span>}
                      </span>
                      <span className="agent-item-sub">
                        {a.statusLine ??
                          a.purpose ??
                          (a.status === 'working' ? 'Trabajando…' : 'Disponible')}
                      </span>
                    </span>
                    {a.unread && <span className="agent-unread" aria-label="Tiene novedades" />}
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
            {teamEmpty && !search && (
              <button type="button" className="agent-team-empty" onClick={() => setSheetOpen(true)}>
                <Plus size={13} /> Crea especialistas para delegar trabajo
              </button>
            )}
          </div>
        </div>

        {/* Misiones recientes */}
        {missionsLoaded && (filteredMissions.length > 0 || !search) && (
          <div className="agent-section">
            <div className="agent-section-label">Misiones recientes</div>
            {filteredMissions.length === 0 ? (
              <div className="agent-section-empty">Sin misiones — pídele una al Central</div>
            ) : (
              filteredMissions.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="agent-mission-item"
                  onClick={() => m.conversationId && onSelect(m.conversationId)}
                  disabled={!m.conversationId}
                  title={m.goal}
                >
                  <Flag size={13} className="agent-mission-icon" />
                  <span className="agent-item-text">
                    <span className="agent-item-title">{m.goal}</span>
                    <span className="agent-item-sub">{missionSubtitle(m)}</span>
                  </span>
                  <span className="agent-item-time">
                    {relTime(m.completedAt ?? m.nextRunAt ?? m.createdAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* Conversaciones */}
        <div className="agent-section">
          <div className="agent-section-label agent-section-label-row">
            <span>Conversaciones</span>
            <button
              type="button"
              className="agent-section-add"
              onClick={() => void handleNew()}
              aria-label="Nueva conversación"
              title="Nueva conversación"
            >
              <Plus size={12} />
            </button>
          </div>
          {loading && <div className="assistant-sidebar-empty">Cargando…</div>}
          {!loading && conversations.length === 0 && (
            <div className="assistant-sidebar-empty">
              {search ? 'Sin resultados' : 'No hay conversaciones'}
            </div>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`assistant-sidebar-item ${activeId === c.id ? 'active' : ''}`}
              onClick={() => onSelect(c.id)}
            >
              {editingId === c.id ? (
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(c.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  autoFocus
                  className="assistant-sidebar-rename"
                />
              ) : (
                <>
                  <div className="assistant-sidebar-item-title">
                    {c.isStarred && <Star size={12} className="assistant-sidebar-star" />}
                    {c.title}
                  </div>
                  <div className="assistant-sidebar-item-actions">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStar(c.id);
                      }}
                      aria-label="Marcar favorito"
                    >
                      <Star size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(c.id);
                        setEditTitle(c.title);
                      }}
                      aria-label="Renombrar"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(c.id);
                      }}
                      aria-label="Eliminar"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="assistant-sidebar-header agent-sidebar-footer">
        <button type="button" className="assistant-sidebar-new" onClick={() => setPrefsOpen(true)}>
          <SlidersHorizontal size={16} />
          <span>Preferencias y memoria</span>
        </button>
        <Link
          href="/app/assistant/extensions"
          className="assistant-sidebar-new"
          style={{ textDecoration: 'none' }}
        >
          <Puzzle size={16} />
          <span>Extensiones y skills</span>
        </Link>
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

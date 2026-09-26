'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CalendarClock,
  Flag,
  Pencil,
  Plus,
  Search,
  SquarePen,
  Star,
  Trash2,
  Orbit,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

async function patchThread(
  id: string,
  body: { title?: string; toggleStar?: boolean }
): Promise<void> {
  const res = await fetch(`/app/assistant/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('fail');
}
import type { AgentInfo, ConversationItem, TeamTask } from '../lib/types';
import { THREAD_GROUP_LABEL, threadGroupOf, timeAgo, type ThreadGroup } from '../lib/format';
import { missionSubtitle, type MissionItem } from '../lib/missions';
import { AgentAvatar, IconButton, Kbd, modKey } from '../ui';
import { taskStatus } from '../cards/Agentic';

/**
 * Left column: the team (who works for you and what each one is doing), work
 * in progress, missions and routines, and every conversation — searchable,
 * grouped by date, with star / rename / delete.
 */

export interface SidebarProps {
  agents: AgentInfo[];
  activeAgentId: string;
  onSelectAgent: (agent: AgentInfo) => void;
  onNewAgent: () => void;
  activeConversationId: string | null;
  onSelectConversation: (id: string | null, agentId?: string | null) => void;
  onNewConversation: () => void;
  teamTasks: TeamTask[];
  /** Bump to reload the thread list (a new thread was created). */
  refreshKey: number;
  footer: React.ReactNode;
  onClose?: () => void;
}

const GROUP_ORDER: ThreadGroup[] = ['starred', 'today', 'yesterday', 'week', 'month', 'older'];
const ACTIVE_TASK = new Set(['queued', 'pending', 'running']);

export function Sidebar({
  agents,
  activeAgentId,
  onSelectAgent,
  onNewAgent,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  teamTasks,
  refreshKey,
  footer,
}: SidebarProps) {
  const [threads, setThreads] = useState<ConversationItem[] | null>(null);
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showWorkers, setShowWorkers] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const mod = useMemo(() => modKey(), []);

  const loadThreads = useCallback(async (search: string) => {
    try {
      const res = await fetch(
        search
          ? `/app/assistant/api/conversations?search=${encodeURIComponent(search)}`
          : '/app/assistant/api/conversations'
      );
      if (!res.ok) throw new Error('fail');
      const d = (await res.json()) as { conversations?: ConversationItem[] };
      setThreads(d.conversations ?? []);
    } catch {
      setThreads((prev) => prev ?? []);
    }
  }, []);

  // Debounced search; reload when a thread is created elsewhere.
  useEffect(() => {
    const t = window.setTimeout(() => void loadThreads(query.trim()), query ? 220 : 0);
    return () => window.clearTimeout(t);
  }, [query, refreshKey, loadThreads]);

  useEffect(() => {
    if (activeConversationId && threads && !threads.some((c) => c.id === activeConversationId))
      void loadThreads(query.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/app/assistant/api/missions')
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (d: { missions?: MissionItem[] } | null) => alive && d && setMissions(d.missions ?? [])
        )
        .catch(() => undefined);
    void load();
    const i = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(i);
    };
  }, [refreshKey]);

  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener('uv:focus-search', focus);
    return () => window.removeEventListener('uv:focus-search', focus);
  }, []);

  const q = query.trim().toLowerCase();
  const shownAgents = q
    ? agents.filter(
        (a) => a.name.toLowerCase().includes(q) || (a.purpose ?? '').toLowerCase().includes(q)
      )
    : agents;
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a] as const)), [agents]);
  const running = teamTasks.filter((t) => ACTIVE_TASK.has(t.status));
  const recentDone = teamTasks
    .filter((t) => !ACTIVE_TASK.has(t.status) && Date.now() - t.updatedAt < 30 * 60_000)
    .slice(0, 3);
  const shownMissions = (
    q ? missions.filter((m) => m.goal.toLowerCase().includes(q)) : missions
  ).filter(
    (m) =>
      m.schedule ||
      ['awaiting_approval', 'active', 'blocked'].includes(m.status) ||
      Date.now() - Date.parse(m.createdAt ?? '') < 3 * 86_400_000
  );

  const { groups, workers } = useMemo(() => {
    const list = threads ?? [];
    const w = list.filter((c) => (c.title ?? '').startsWith('⚙'));
    const main = list.filter((c) => !(c.title ?? '').startsWith('⚙'));
    const map = new Map<ThreadGroup, ConversationItem[]>();
    for (const c of main) {
      const g = threadGroupOf(c.lastMessageAt ?? c.updatedAt, c.isStarred);
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return {
      groups: GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ g, items: map.get(g) ?? [] })),
      workers: w,
    };
  }, [threads]);

  const star = async (c: ConversationItem) => {
    setThreads(
      (prev) => prev?.map((x) => (x.id === c.id ? { ...x, isStarred: !x.isStarred } : x)) ?? prev
    );
    try {
      await patchThread(c.id, { toggleStar: true });
    } catch {
      toast.error('No se pudo actualizar');
      void loadThreads(query.trim());
    }
  };
  const rename = async (c: ConversationItem) => {
    const title = draft.trim();
    setEditing(null);
    if (!title || title === c.title) return;
    setThreads((prev) => prev?.map((x) => (x.id === c.id ? { ...x, title } : x)) ?? prev);
    try {
      await patchThread(c.id, { title: title.slice(0, 100) });
    } catch {
      toast.error('No se pudo renombrar');
      void loadThreads(query.trim());
    }
  };
  const remove = async (c: ConversationItem) => {
    if (
      !window.confirm(
        `¿Eliminar la conversación «${c.title ?? 'Sin título'}»? No se puede deshacer.`
      )
    )
      return;
    setThreads((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
    try {
      const res = await fetch(`/app/assistant/api/conversations/${c.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('fail');
      if (activeConversationId === c.id) onSelectConversation(null);
    } catch {
      toast.error('No se pudo eliminar');
      void loadThreads(query.trim());
    }
  };

  const threadRow = (c: ConversationItem) => {
    const owner = c.agentId ? agentById.get(c.agentId) : null;
    const active = activeConversationId === c.id;
    if (editing === c.id) {
      return (
        <div key={c.id} className="uv-row uv-thread-row is-active">
          <input
            className="uv-thread-rename"
            value={draft}
            autoFocus
            maxLength={100}
            aria-label="Nuevo título"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void rename(c)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename(c);
              if (e.key === 'Escape') setEditing(null);
            }}
          />
        </div>
      );
    }
    return (
      <div
        key={c.id}
        role="button"
        tabIndex={0}
        className={cn('uv-row uv-thread-row', active && 'is-active')}
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelectConversation(c.id, c.agentId ?? null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectConversation(c.id, c.agentId ?? null);
          }
        }}
        title={c.title ?? undefined}
      >
        {owner && owner.kind !== 'principal' && <AgentAvatar agent={owner} size="xs" />}
        <span className="uv-row-text">
          <span className="uv-row-title">
            <span>{c.title || 'Nueva conversación'}</span>
          </span>
        </span>
        <span
          className="uv-thread-tools"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <IconButton
            size="sm"
            label={c.isStarred ? 'Quitar de favoritas' : 'Marcar como favorita'}
            className={cn(c.isStarred && 'is-starred')}
            onClick={() => void star(c)}
          >
            <Star size={13} fill={c.isStarred ? 'currentColor' : 'none'} />
          </IconButton>
          <IconButton
            size="sm"
            label="Renombrar"
            onClick={() => {
              setEditing(c.id);
              setDraft(c.title ?? '');
            }}
          >
            <Pencil size={13} />
          </IconButton>
          <IconButton size="sm" label="Eliminar" onClick={() => void remove(c)}>
            <Trash2 size={13} />
          </IconButton>
        </span>
      </div>
    );
  };

  return (
    <nav className="uv-side" aria-label="Equipo y conversaciones">
      <div className="uv-side-head">
        <div className="uv-brand">
          <span className="uv-brand-mark" aria-hidden="true">
            <Orbit size={16} />
          </span>
          <span>Universo</span>
        </div>
      </div>
      <div className="uv-side-actions">
        <button type="button" className="uv-new-chat" onClick={onNewConversation}>
          <SquarePen size={15} />
          Nueva conversación
        </button>
        <label className="uv-search">
          <Search size={14} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar"
            aria-label="Buscar agentes, misiones y conversaciones"
          />
          {!query && (
            <span className="uv-search-kbd" aria-hidden="true">
              <Kbd>{mod}K</Kbd>
            </span>
          )}
        </label>
      </div>

      <div className="uv-side-scroll">
        <section className="uv-section" aria-label="Tu equipo">
          <div className="uv-section-head">
            <span>Tu equipo</span>
            <IconButton label="Crear agente o equipo" size="sm" onClick={onNewAgent}>
              <Plus size={14} />
            </IconButton>
          </div>
          {shownAgents.map((a) => {
            const working = a.status === 'working';
            const task = running.find((t) => t.agentId === a.id);
            return (
              <button
                key={a.id}
                type="button"
                className={cn('uv-row', activeAgentId === a.id && 'is-active')}
                aria-current={activeAgentId === a.id ? 'true' : undefined}
                onClick={() => onSelectAgent(a)}
              >
                <AgentAvatar agent={a} status={task ? 'working' : (a.status ?? 'idle')} />
                <span className="uv-row-text">
                  <span className="uv-row-title">
                    <span>{a.name}</span>
                    {a.kind === 'principal' && <span className="uv-tag-chief">Director</span>}
                  </span>
                  <span className={cn('uv-row-sub', (working || task) && 'is-working')}>
                    {task
                      ? task.title
                      : working
                        ? 'Trabajando…'
                        : a.status === 'offline'
                          ? 'En pausa'
                          : (a.purpose ?? 'Disponible')}
                  </span>
                </span>
              </button>
            );
          })}
          {agents.length <= 1 && !q && (
            <button type="button" className="uv-row uv-row-ghost" onClick={onNewAgent}>
              <span className="uv-row-ghost-icon">
                <Plus size={14} />
              </span>
              <span className="uv-row-text">
                <span className="uv-row-title">
                  <span>Crea especialistas o un equipo</span>
                </span>
                <span className="uv-row-sub">Ventas, cobranza, marketing, programadores…</span>
              </span>
            </button>
          )}
        </section>

        {(running.length > 0 || recentDone.length > 0) && (
          <section className="uv-section" aria-label="Trabajo en curso">
            <div className="uv-section-head">
              <span>En curso</span>
              {running.length > 0 && <span className="uv-count">{running.length}</span>}
            </div>
            {[...running, ...recentDone].map((t) => {
              const st = taskStatus(t.status);
              const who = t.agentId ? agentById.get(t.agentId) : null;
              return (
                <button
                  key={t.taskId}
                  type="button"
                  className="uv-row uv-task-row"
                  onClick={() => t.conversationId && onSelectConversation(t.conversationId)}
                  disabled={!t.conversationId}
                >
                  {who ? (
                    <AgentAvatar
                      agent={who}
                      size="sm"
                      status={ACTIVE_TASK.has(t.status) ? 'working' : 'idle'}
                    />
                  ) : (
                    <Bot size={16} />
                  )}
                  <span className="uv-row-text">
                    <span className="uv-row-title">
                      <span>{t.title}</span>
                    </span>
                    <span className={cn('uv-row-sub', ACTIVE_TASK.has(t.status) && 'is-working')}>
                      {st.label}
                      {who ? ` · ${who.name}` : ''} · {timeAgo(t.updatedAt)}
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        )}

        {shownMissions.length > 0 && (
          <section className="uv-section" aria-label="Misiones y rutinas">
            <div className="uv-section-head">
              <span>Misiones y rutinas</span>
            </div>
            {shownMissions.slice(0, 8).map((m) => (
              <button
                key={m.id}
                type="button"
                className="uv-row uv-task-row"
                onClick={() => m.conversationId && onSelectConversation(m.conversationId)}
                disabled={!m.conversationId}
                title={m.goal}
              >
                <span className="uv-row-icon">
                  {m.schedule ? <CalendarClock size={14} /> : <Flag size={14} />}
                </span>
                <span className="uv-row-text">
                  <span className="uv-row-title">
                    <span>{m.goal}</span>
                  </span>
                  <span className={cn('uv-row-sub', m.status === 'active' && 'is-working')}>
                    {missionSubtitle(m)}
                  </span>
                </span>
              </button>
            ))}
          </section>
        )}

        <section className="uv-section" aria-label="Conversaciones">
          <div className="uv-section-head">
            <span>Conversaciones</span>
          </div>
          {threads === null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 8px' }}>
              <div className="uv-skel" style={{ height: 14, width: '80%' }} />
              <div className="uv-skel" style={{ height: 14, width: '65%' }} />
              <div className="uv-skel" style={{ height: 14, width: '72%' }} />
            </div>
          )}
          {threads !== null && groups.length === 0 && (
            <p className="uv-section-note">
              {q ? 'Nada coincide con tu búsqueda.' : 'Aquí aparecerán tus conversaciones.'}
            </p>
          )}
          {groups.map(({ g, items }) => (
            <div key={g}>
              <div className="uv-group-label">{THREAD_GROUP_LABEL[g]}</div>
              {items.map(threadRow)}
            </div>
          ))}
          {workers.length > 0 && (
            <div>
              <button
                type="button"
                className="uv-group-label uv-group-toggle"
                onClick={() => setShowWorkers((v) => !v)}
                aria-expanded={showWorkers}
              >
                Trabajo del equipo · {workers.length}
              </button>
              {showWorkers && workers.slice(0, 30).map(threadRow)}
            </div>
          )}
        </section>
      </div>

      <div className="uv-side-foot">{footer}</div>
    </nav>
  );
}

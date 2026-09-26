'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Flag, Loader2, Plug, ShieldCheck, Users, Wallet, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { AgentInfo, ProposalInfo, TeamTask } from '../lib/types';
import { formatDuration, timeAgo } from '../lib/format';
import { MISSION_STATUS_LABEL, missionProgress, type MissionItem } from '../lib/missions';
import { AgentAvatar, IconButton } from '../ui';
import { ApprovalCard, taskStatus } from '../cards/Agentic';
import { AppsList } from '../shell/AppsList';

/**
 * "Equipo": what your agents are doing right now, what waits for your OK,
 * missions and routines (pause/resume), connected apps and what it all cost
 * this month — every number comes from measured data.
 */

interface TriggerRow {
  id: string;
  agentId: string;
  type: string;
  spec: { atHour?: number; atMinute?: number; tz?: string; everyMinutes?: number } & Record<
    string,
    unknown
  >;
  action: { goal?: string; kind?: string };
  enabled: boolean;
  nextRunAt?: string | null;
  lastFiredAt?: string | null;
}

interface Usage {
  llm: number;
  venue: number;
  venueMinutes: number;
  runs: number;
  spent: number;
}

const ACTIVE = new Set(['queued', 'pending', 'running']);

function money(n: number): string {
  return n.toLocaleString('es-MX', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: n < 1 ? 3 : 2,
  });
}

function scheduleOf(spec: TriggerRow['spec']): string {
  if (typeof spec.everyMinutes === 'number') {
    return spec.everyMinutes >= 60 && spec.everyMinutes % 60 === 0
      ? `Cada ${spec.everyMinutes / 60} h`
      : `Cada ${spec.everyMinutes} min`;
  }
  if (typeof spec.atHour === 'number') {
    return `Todos los días ${spec.atHour}:${String(typeof spec.atMinute === 'number' ? spec.atMinute : 0).padStart(2, '0')}`;
  }
  return 'Rutina';
}

function Section({
  icon,
  title,
  count,
  children,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="uv-block">
      <div className="uv-block-head">
        {icon}
        <span>{title}</span>
        {typeof count === 'number' && count > 0 && <span className="uv-count">{count}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

export function TeamView({
  tasks,
  agents,
  visible,
  onOpenConversation,
}: {
  tasks: TeamTask[];
  agents: AgentInfo[];
  visible: boolean;
  onOpenConversation: (id: string) => void;
}) {
  const [proposals, setProposals] = useState<ProposalInfo[] | null>(null);
  const [missions, setMissions] = useState<MissionItem[] | null>(null);
  const [triggers, setTriggers] = useState<TriggerRow[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const agentById = new Map(agents.map((a) => [a.id, a] as const));

  const load = useCallback(async () => {
    const get = async <T,>(url: string): Promise<T | null> => {
      try {
        const r = await fetch(url);
        return r.ok ? ((await r.json()) as T) : null;
      } catch {
        return null;
      }
    };
    const [p, m, t, u] = await Promise.all([
      get<{ proposals?: ProposalInfo[] }>('/app/assistant/api/proposals'),
      get<{ missions?: MissionItem[] }>('/app/assistant/api/missions'),
      get<{ triggers?: TriggerRow[] }>('/app/assistant/api/triggers'),
      get<Usage>('/app/assistant/api/usage'),
    ]);
    setProposals(p?.proposals ?? []);
    setMissions(m?.missions ?? []);
    setTriggers(t?.triggers ?? []);
    setUsage(u);
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load();
    const i = window.setInterval(
      () => document.visibilityState === 'visible' && void load(),
      20_000
    );
    return () => window.clearInterval(i);
  }, [visible, load]);

  const cancel = async (t: TeamTask) => {
    setCancelling(t.taskId);
    try {
      const r = await fetch(`/app/assistant/api/tasks/${t.taskId}/cancel`, { method: 'POST' });
      if (!r.ok) throw new Error('No se pudo cancelar');
      toast.success('Tarea cancelada');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cancelar');
    } finally {
      setCancelling(null);
    }
  };

  const toggleTrigger = async (t: TriggerRow) => {
    setTriggers(
      (prev) => prev?.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)) ?? prev
    );
    const r = await fetch(`/app/assistant/api/triggers/${t.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !t.enabled }),
    }).catch(() => null);
    if (!r?.ok) {
      toast.error('No se pudo cambiar la rutina');
      void load();
    }
  };

  const running = tasks.filter((t) => ACTIVE.has(t.status));
  const finished = tasks.filter((t) => !ACTIVE.has(t.status)).slice(0, 8);
  const liveMissions = (missions ?? []).filter((m) => !m.schedule).slice(0, 8);

  return (
    <div className="uv-ws-scroll">
      <Section icon={<Users size={14} />} title="Trabajando ahora" count={running.length}>
        {tasks.length === 0 ? (
          <div className="uv-empty" style={{ padding: '18px 12px' }}>
            <span>
              Cuando el director reparta trabajo, aquí verás a cada especialista avanzar en
              paralelo.
            </span>
          </div>
        ) : (
          <div className="uv-feed">
            {[...running, ...finished].map((t) => {
              const who = t.agentId ? agentById.get(t.agentId) : null;
              const st = taskStatus(t.status);
              return (
                <div key={t.taskId} className="uv-feed-item">
                  {who ? (
                    <AgentAvatar
                      agent={who}
                      size="sm"
                      status={ACTIVE.has(t.status) ? 'working' : 'idle'}
                    />
                  ) : (
                    <Users size={14} />
                  )}
                  <div className="uv-feed-main">
                    <strong>{t.title}</strong>
                    <span>
                      {[
                        who?.name,
                        t.durationMs ? formatDuration(t.durationMs) : null,
                        timeAgo(t.updatedAt),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {t.reportPreview && <p className="uv-feed-report">{t.reportPreview}</p>}
                  </div>
                  <span className={cn('uv-pill', st.tone)}>{st.label}</span>
                  {ACTIVE.has(t.status) && (
                    <IconButton
                      label="Cancelar tarea"
                      size="sm"
                      onClick={() => void cancel(t)}
                      disabled={cancelling === t.taskId}
                    >
                      {cancelling === t.taskId ? (
                        <Loader2 size={13} className="uv-spin" />
                      ) : (
                        <X size={13} />
                      )}
                    </IconButton>
                  )}
                  {!ACTIVE.has(t.status) && t.conversationId && (
                    <button
                      type="button"
                      className="uv-btn is-ghost is-sm"
                      onClick={() => onOpenConversation(t.conversationId as string)}
                    >
                      Ver
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        icon={<ShieldCheck size={14} />}
        title="Esperan tu aprobación"
        count={proposals?.length ?? 0}
      >
        {proposals === null ? (
          <div className="uv-skel" style={{ height: 64 }} />
        ) : proposals.length === 0 ? (
          <p className="uv-section-note">
            Nada pendiente. Todo lo que envíe, cobre o cambie algo pasará por aquí.
          </p>
        ) : (
          <div className="uv-cards">
            {proposals.slice(0, 6).map((p) => (
              <ApprovalCard key={p.id} proposal={p} onDecided={() => void load()} />
            ))}
          </div>
        )}
      </Section>

      <Section icon={<Flag size={14} />} title="Misiones">
        {missions === null ? (
          <div className="uv-skel" style={{ height: 48 }} />
        ) : liveMissions.length === 0 ? (
          <p className="uv-section-note">
            Pide una misión en el chat (modo Misión) y aquí verás su avance paso a paso.
          </p>
        ) : (
          <div className="uv-feed">
            {liveMissions.map((m) => {
              const { done, total } = missionProgress(m);
              return (
                <button
                  key={m.id}
                  type="button"
                  className="uv-feed-item is-link"
                  onClick={() => m.conversationId && onOpenConversation(m.conversationId)}
                  disabled={!m.conversationId}
                >
                  <Flag size={14} />
                  <div className="uv-feed-main">
                    <strong>{m.goal}</strong>
                    <span>
                      {MISSION_STATUS_LABEL[m.status] ?? m.status}
                      {total > 0 ? ` · ${done}/${total} pasos` : ''}
                    </span>
                    {total > 0 && (
                      <div className="uv-progress">
                        <i style={{ width: `${(done / total) * 100}%` }} />
                      </div>
                    )}
                  </div>
                  <span className="uv-feed-time">
                    {timeAgo(m.completedAt ?? m.createdAt ?? null)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <Section icon={<CalendarClock size={14} />} title="Rutinas">
        {triggers === null ? (
          <div className="uv-skel" style={{ height: 48 }} />
        ) : triggers.length === 0 ? (
          <p className="uv-section-note">
            Crea un especialista con rutina (por ejemplo «Arranque del día» a las 6:00) y trabajará
            solo a su hora.
          </p>
        ) : (
          <div className="uv-feed">
            {triggers.map((t) => {
              const who = agentById.get(t.agentId);
              return (
                <div key={t.id} className="uv-feed-item">
                  {who ? <AgentAvatar agent={who} size="sm" /> : <CalendarClock size={14} />}
                  <div className="uv-feed-main">
                    <strong>{t.action.goal ?? 'Rutina'}</strong>
                    <span>
                      {[
                        who?.name,
                        t.type === 'time' ? scheduleOf(t.spec) : t.type,
                        t.lastFiredAt ? `última ${timeAgo(t.lastFiredAt)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <label className="uv-switch" title={t.enabled ? 'Pausar' : 'Reanudar'}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={t.enabled}
                      onChange={() => void toggleTrigger(t)}
                      aria-label={t.enabled ? 'Pausar rutina' : 'Reanudar rutina'}
                    />
                    <span aria-hidden="true" />
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section icon={<Plug size={14} />} title="Apps conectadas">
        <div className="uv-feed" style={{ padding: 6 }}>
          <AppsList compact />
        </div>
      </Section>

      <Section icon={<Wallet size={14} />} title="Uso este mes">
        {usage ? (
          <div className="uv-stats">
            <div className="uv-stat">
              <span>Inteligencia artificial</span>
              <strong>{money(usage.llm)}</strong>
            </div>
            <div className="uv-stat">
              <span>Computadora virtual</span>
              <strong>{money(usage.venue)}</strong>
              <span>{Math.round(usage.venueMinutes)} min</span>
            </div>
            <div className="uv-stat">
              <span>Trabajos ejecutados</span>
              <strong>{usage.runs.toLocaleString('es-MX')}</strong>
            </div>
          </div>
        ) : (
          <div className="uv-skel" style={{ height: 64 }} />
        )}
      </Section>
    </div>
  );
}

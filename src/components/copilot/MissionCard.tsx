'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Circle, Clock, Loader2, Pause, Play, Rocket, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { listItem } from '@/lib/motion';
import { MISSION_STATUS_LABEL } from '@/components/assistant/agents/AgentSidebar';
import { type MissionCardData } from './copilot-types';

interface LiveStep {
  title: string;
  status: string;
  agent?: string | null;
}

const STEP_ICON: Record<string, React.ReactNode> = {
  done: <Check size={12} />,
  skipped: <Check size={12} />,
  running: <Loader2 size={12} className="copilot-spin" />,
  awaiting_approval: <Clock size={12} />,
  failed: <XCircle size={12} />,
};

const STEP_LABEL: Record<string, string> = {
  pending: 'en espera',
  running: 'en curso',
  awaiting_approval: 'esperando aprobación',
  done: 'listo',
  failed: 'falló',
  skipped: 'omitido',
};

const CHIP_TONE: Record<string, string> = {
  active: 'is-running',
  awaiting_approval: 'is-waiting',
  blocked: 'is-waiting',
  done: 'is-done',
  failed: 'is-failed',
  cancelled: 'is-failed',
};

/** Mission proposed via `proposeMission` — approve/pause/cancel hit the missions API. */
export function MissionCard({ mission, active }: { mission: MissionCardData; active: boolean }) {
  const [status, setStatus] = useState(mission.initialStatus ?? 'awaiting_approval');
  const [steps, setSteps] = useState<LiveStep[]>(mission.steps);
  const [busy, setBusy] = useState<string | null>(null);

  // Live status: poll the mission endpoint while it's in flight so the card
  // reflects real step transitions (each step still asks for approval).
  useEffect(() => {
    if (!['active', 'awaiting_approval', 'blocked'].includes(status)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/app/assistant/api/missions/${mission.missionId}`);
        if (!res.ok || cancelled) return;
        const d = (await res.json()) as {
          mission?: { status?: string; plan?: { steps?: LiveStep[] } | null };
        };
        if (!d.mission || cancelled) return;
        if (d.mission.status) setStatus(d.mission.status);
        const live = d.mission.plan?.steps;
        if (Array.isArray(live) && live.length > 0) setSteps(live);
      } catch {
        /* poll is best-effort */
      }
    };
    const i = setInterval(() => void tick(), 6000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, [mission.missionId, status]);

  const act = async (action: 'approve' | 'pause' | 'resume' | 'cancel') => {
    setBusy(action);
    try {
      const res = await fetch(`/app/assistant/api/missions/${mission.missionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Error');
      setStatus(
        action === 'approve' || action === 'resume'
          ? 'active'
          : action === 'cancel'
            ? 'cancelled'
            : 'blocked'
      );
      toast.success(
        action === 'approve'
          ? 'Misión en marcha — te aviso al terminar'
          : action === 'cancel'
            ? 'Misión cancelada'
            : action === 'pause'
              ? 'Misión pausada'
              : 'Misión reanudada'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo aplicar');
    } finally {
      setBusy(null);
    }
  };

  const scheduleLabel = mission.schedule?.startsWith('daily:')
    ? `Todos los días ${mission.schedule.slice(6)} (CDMX)`
    : mission.schedule?.startsWith('every:')
      ? `Cada ${mission.schedule.slice(6)} min`
      : null;

  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const progress = steps.length > 0 ? done / steps.length : 0;

  return (
    <motion.div
      className={cn('mission-card', !active && 'is-past')}
      role="group"
      aria-label="Misión propuesta"
      variants={listItem}
      initial="initial"
      animate="animate"
    >
      <div className="mission-head">
        <span className="mission-icon">
          <Rocket size={16} />
        </span>
        <div className="mission-title">
          <strong>Misión</strong>
          <span className="mission-subtitle">{mission.goal}</span>
        </div>
        <span className={cn('mission-state', CHIP_TONE[status] ?? 'is-waiting')}>
          {MISSION_STATUS_LABEL[status] ?? status}
        </span>
      </div>
      {scheduleLabel && (
        <div className="mission-schedule">
          <span className="mission-label">Rutina</span>
          <span>{scheduleLabel}</span>
        </div>
      )}
      {steps.length > 0 && (
        <ol className="mission-tasks">
          {steps.map((step, i) => (
            <li key={i} className={cn('mission-task', `is-${step.status}`)}>
              <span className="mission-task-check">
                {STEP_ICON[step.status] ?? <Circle size={12} />}
              </span>
              <span className="mission-task-title">{step.title}</span>
              {step.agent && <span className="mission-task-agent">{step.agent}</span>}
              <span className="mission-task-status">{STEP_LABEL[step.status] ?? step.status}</span>
            </li>
          ))}
        </ol>
      )}
      {steps.length > 0 && (
        <div className="mission-foot">
          <span className="mission-progress" aria-hidden="true">
            <span className="mission-progress-bar" style={{ transform: `scaleX(${progress})` }} />
          </span>
          <span className="mission-foot-count">
            {done}/{steps.length}
          </span>
        </div>
      )}
      {active && status === 'awaiting_approval' && (
        <div className="mission-actions">
          <button
            type="button"
            className="proposal-btn proposal-btn-ghost"
            disabled={busy !== null}
            onClick={() => void act('cancel')}
          >
            <XCircle size={14} /> Cancelar
          </button>
          <button
            type="button"
            className="proposal-btn proposal-btn-primary"
            disabled={busy !== null}
            onClick={() => void act('approve')}
          >
            <Play size={14} /> {busy === 'approve' ? 'Arrancando…' : 'Aprobar y ejecutar'}
          </button>
        </div>
      )}
      {active && status === 'active' && (
        <div className="mission-actions">
          <button
            type="button"
            className="proposal-btn proposal-btn-ghost"
            disabled={busy !== null}
            onClick={() => void act('pause')}
          >
            <Pause size={14} /> Pausar
          </button>
          <span className="mission-note">
            Corriendo paso a paso — cada efecto externo pedirá tu aprobación
          </span>
        </div>
      )}
      {active && status === 'blocked' && (
        <div className="mission-actions">
          <button
            type="button"
            className="proposal-btn proposal-btn-primary"
            disabled={busy !== null}
            onClick={() => void act('resume')}
          >
            <Play size={14} /> Reanudar
          </button>
          <button
            type="button"
            className="proposal-btn proposal-btn-ghost"
            disabled={busy !== null}
            onClick={() => void act('cancel')}
          >
            <XCircle size={14} /> Cancelar
          </button>
        </div>
      )}
      {!active && status === 'awaiting_approval' && (
        <div className="mission-note">Misión propuesta</div>
      )}
    </motion.div>
  );
}

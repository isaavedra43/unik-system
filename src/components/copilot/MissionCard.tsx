'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Pause, Play, Rocket, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const spring = { type: 'spring', stiffness: 420, damping: 32, mass: 0.6 } as const;

import { type MissionCardData } from './copilot-types';

/** Mission proposed via `proposeMission` — approve/pause/cancel hit the missions API. */
export function MissionCard({ mission, active }: { mission: MissionCardData; active: boolean }) {
  const [status, setStatus] = useState<'awaiting_approval' | 'active' | 'cancelled' | 'blocked'>(
    'awaiting_approval'
  );
  const [busy, setBusy] = useState<string | null>(null);

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
        action === 'approve' || action === 'resume' ? 'active' : action === 'cancel' ? 'cancelled' : 'blocked'
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

  const scheduleLabel =
    mission.schedule?.startsWith('daily:')
      ? `Todos los días ${mission.schedule.slice(6)} (CDMX)`
      : mission.schedule?.startsWith('every:')
        ? `Cada ${mission.schedule.slice(6)} min`
        : null;

  return (
    <motion.div
      className={cn('plan-card', !active && 'is-past')}
      role="group"
      aria-label="Misión propuesta"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
      <div className="plan-head">
        <span className="plan-icon">
          <Rocket size={16} />
        </span>
        <div className="plan-title">
          <strong>Misión {status === 'active' ? 'en marcha' : status === 'cancelled' ? 'cancelada' : status === 'blocked' ? 'pausada' : 'propuesta'}</strong>
          <span className="plan-subtitle">{mission.goal}</span>
        </div>
        {mission.steps.length > 0 && <span className="plan-count">{mission.steps.length} pasos</span>}
      </div>
      {scheduleLabel && <div className="plan-deliverable"><span className="plan-label">Rutina</span><span>{scheduleLabel}</span></div>}
      {mission.steps.length > 0 && (
        <ol className="plan-steps">
          {mission.steps.map((step, i) => (
            <li key={i} className="plan-step">
              <span className="plan-step-n">{i + 1}</span>
              <div className="plan-step-body">
                <div className="plan-step-title">{step.title}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {active && status === 'awaiting_approval' && (
        <div className="plan-actions">
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
        <div className="plan-actions">
          <button
            type="button"
            className="proposal-btn proposal-btn-ghost"
            disabled={busy !== null}
            onClick={() => void act('pause')}
          >
            <Pause size={14} /> Pausar
          </button>
          <span className="plan-past">Corriendo paso a paso — cada efecto externo pedirá tu aprobación</span>
        </div>
      )}
      {!active && status === 'awaiting_approval' && <div className="plan-past">Misión propuesta</div>}
    </motion.div>
  );
}

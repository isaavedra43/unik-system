'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { ListChecks, Play, ShieldAlert, SlidersHorizontal, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RUN_PLAN_MESSAGE, toolLabel, type PlanData } from './copilot-types';

const spring = { type: 'spring', stiffness: 420, damping: 32, mass: 0.6 } as const;

/**
 * Plan-then-execute card: the steps the assistant proposes before touching
 * anything. "Ejecutar plan" sends the confirmation as a normal message; the
 * assistant then runs the steps (side effects still go through approval).
 */
export function PlanCard({ plan, active, onRun, onAdjust }: { plan: PlanData; active: boolean; onRun: (text: string) => void; onAdjust?: () => void }) {
  const approvals = plan.steps.filter((s) => s.needsApproval).length;
  return (
    <motion.div className={cn('plan-card', !active && 'is-past')} role="group" aria-label="Plan propuesto" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className="plan-head">
        <span className="plan-icon">
          <ListChecks size={16} />
        </span>
        <div className="plan-title">
          <strong>Plan propuesto</strong>
          <span className="plan-subtitle">{plan.goal}</span>
        </div>
        <span className="plan-count">{plan.steps.length} pasos</span>
      </div>
      <ol className="plan-steps">
        {plan.steps.map((step) => (
          <li key={step.n} className="plan-step">
            <span className="plan-step-n">{step.n}</span>
            <div className="plan-step-body">
              <div className="plan-step-title">{step.title}</div>
              {step.detail && <div className="plan-step-detail">{step.detail}</div>}
              <div className="plan-step-tags">
                {step.tool && (
                  <span className="plan-tag" title={step.tool}>
                    <Wrench size={10} /> {toolLabel(step.tool, 'running')}
                  </span>
                )}
                {step.needsApproval && (
                  <span className="plan-tag is-approval">
                    <ShieldAlert size={10} /> pedirá aprobación
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {plan.assumptions.length > 0 && (
        <div className="plan-assumptions">
          <span className="plan-label">Supuestos</span>
          <ul>
            {plan.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.deliverable && (
        <div className="plan-deliverable">
          <span className="plan-label">Entregable</span>
          <span>{plan.deliverable}</span>
        </div>
      )}
      {active ? (
        <div className="plan-actions">
          {onAdjust && (
            <button type="button" className="proposal-btn proposal-btn-ghost" onClick={onAdjust}>
              <SlidersHorizontal size={14} /> Ajustar
            </button>
          )}
          <button type="button" className="proposal-btn proposal-btn-primary" onClick={() => onRun(RUN_PLAN_MESSAGE)}>
            <Play size={14} /> Ejecutar plan{approvals > 0 ? ` · ${approvals} aprobación${approvals > 1 ? 'es' : ''}` : ''}
          </button>
        </div>
      ) : (
        <div className="plan-past">Plan anterior</div>
      )}
    </motion.div>
  );
}

import { cn } from '@/lib/utils';
import type { ProcessStepView } from './process-model';
import { stepBadges } from './process-model';

export interface StepNodeProps {
  step: ProcessStepView;
  /** Lo dibuja el lienzo de React Flow (ajusta el ancho al del acomodo). */
  onCanvas?: boolean;
  selected?: boolean;
  className?: string;
}

const BADGE_TONE_CLASS = {
  default: '',
  info: 'neural-badge-info',
  success: 'neural-badge-success',
  warning: 'neural-badge-warning',
  danger: 'neural-badge-danger',
} as const;

/**
 * Un paso del proceso (plan 7.8a): coloreado por área, con las insignias de lo
 * medido (p50 activo, p90 de espera y % de incumplimiento) y resaltado cuando
 * pertenece a la variante seleccionada.
 *
 * Presentacional y sin React Flow: lo usa el lienzo, la lista de móvil y la
 * story. Un paso SIN mediciones lo dice ("sin mediciones en el periodo") en vez
 * de mostrar ceros que parecerían reales.
 */
export function StepNode({ step, onCanvas = false, selected = false, className }: StepNodeProps) {
  const badges = stepBadges(step.metrics);
  return (
    <span
      className={cn(
        'neural-step-node',
        `neural-area-${step.areaTone}`,
        step.highlighted && 'neural-step-node-path',
        step.dimmed && 'neural-step-node-dim',
        selected && 'neural-graph-node-selected',
        className
      )}
      style={onCanvas ? { width: step.width, minHeight: step.height } : undefined}
    >
      <span className="neural-step-node-head">
        <span className="neural-step-node-title" title={step.label}>
          {step.label}
        </span>
        {step.sequenceIndex !== null ? (
          <span
            className="neural-step-node-order"
            aria-label={`Paso ${step.sequenceIndex} de la variante`}
          >
            {step.sequenceIndex}
          </span>
        ) : null}
      </span>
      <span className="neural-step-node-area">{step.areaLabel}</span>
      {badges.length > 0 ? (
        <span className="neural-step-node-badges">
          {badges.map((badge) => (
            <span key={badge.key} className={cn('neural-badge', BADGE_TONE_CLASS[badge.tone])}>
              <span className="neural-badge-label">{badge.label}</span>
              {badge.value}
            </span>
          ))}
        </span>
      ) : (
        <span className="neural-step-node-empty">Sin mediciones en el periodo</span>
      )}
    </span>
  );
}

import { AlertOctagon, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import {
  closeKindLabel,
  closeStatusLabel,
  closeStatusTone,
  describeCloseProgress,
  formatDateKey,
  formatPeriodKey,
  summarizeCloseChecks,
  type CloseCheckView,
} from '@/modules/areas/contabilidad/contabilidad-model';

export interface CloseChecklistCardProps {
  kind: 'daily' | 'monthly';
  /** Period being closed (`YYYY-MM-DD` daily, `YYYY-MM` monthly). */
  periodKey: string;
  status: string | null;
  checks: readonly CloseCheckView[];
  /** Actions of the section (only the Cierre page passes them). */
  actions?: React.ReactNode;
}

const BADGE_BY_TONE = {
  default: 'default',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  weak: 'weak',
} as const;

/**
 * Checklist of a close with its blockers highlighted (plan 7.6). Pure
 * presentation: what blocks, what only warns and what already passes, as the
 * close rules of the engine computed it.
 */
export function CloseChecklistCard({
  kind,
  periodKey,
  status,
  checks,
  actions,
}: CloseChecklistCardProps) {
  const progress = summarizeCloseChecks(checks);
  const tone = closeStatusTone(status ?? 'open');
  const title = kind === 'monthly' ? formatPeriodKey(periodKey) : formatDateKey(periodKey);

  return (
    <section className="fin-card" aria-labelledby={`fin-close-${kind}`}>
      <div className="fin-card-head">
        <h3 className="fin-card-title" id={`fin-close-${kind}`}>
          Cierre {closeKindLabel(kind)} · {title}
        </h3>
        <Badge variant={BADGE_BY_TONE[tone]}>{closeStatusLabel(status ?? 'open')}</Badge>
      </div>

      <p className="fin-card-hint">{describeCloseProgress(progress)}</p>

      {checks.length === 0 ? (
        <div className="fin-empty">
          <strong>Sin revisiones todavía</strong>
          <p>
            Ejecuta el cierre para que el sistema revise gastos pendientes, cobros sin asignar,
            arqueo de cajas y el cuadre del libro.
          </p>
        </div>
      ) : (
        <ul className="fin-checklist">
          {[...progress.blockers, ...progress.warnings, ...checks.filter((check) => check.ok)].map(
            (check) => {
              const state = check.ok ? 'ok' : check.blocking ? 'blocking' : 'warning';
              const Icon =
                state === 'ok' ? CheckCircle2 : state === 'blocking' ? AlertOctagon : AlertTriangle;
              return (
                <li key={check.key} className={`fin-check fin-check-${state}`}>
                  <span className="fin-check-icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span className="fin-check-body">
                    <span className="fin-check-label">
                      {check.label}
                      {state === 'blocking' ? ' · bloquea el cierre' : ''}
                    </span>
                    {check.detail ? <span className="fin-check-detail">{check.detail}</span> : null}
                  </span>
                </li>
              );
            }
          )}
        </ul>
      )}

      {actions ? <div className="fin-actions">{actions}</div> : null}
    </section>
  );
}

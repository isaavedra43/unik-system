import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';
import { deltaIntent, describeDelta, type StatDelta, type StatTone } from './dashboard-utils';

export type { StatDelta, StatTone } from './dashboard-utils';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Decorative icon (lucide-react, 20px). Hidden from assistive technology. */
  icon?: ReactNode;
  tone?: StatTone;
  delta?: StatDelta;
  /** Turns the whole card into a link (e.g. to the filtered list behind the KPI). */
  href?: string;
  loading?: boolean;
  /** Marks a tile computed on every request ("En vivo"). */
  live?: boolean;
  className?: string;
}

const DELTA_ICON = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: ArrowRight,
} as const;

/**
 * KPI tile of the dashboard kit. Works in Server and Client Components.
 * Replaces the former AssistantAdminStatCard / ChatAdminStatCard.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  delta,
  href,
  loading = false,
  live = false,
  className,
}: StatCardProps) {
  const classes = cn('stat-card', `stat-card-tone-${tone}`, href && 'stat-card-link', className);

  const body = (
    <>
      {icon ? (
        <span className="stat-card-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="stat-card-content">
        <span className="stat-card-label">
          {label}
          {live ? (
            <span className="stat-card-live" title="En vivo">
              <span className="stat-card-live-dot" aria-hidden="true" />
              <span className="sr-only">(en vivo)</span>
            </span>
          ) : null}
        </span>
        {loading ? (
          <>
            <Skeleton className="stat-card-skeleton-value" aria-hidden="true" />
            <Skeleton className="stat-card-skeleton-hint" aria-hidden="true" />
            <span className="sr-only">Cargando…</span>
          </>
        ) : (
          <>
            <span className="stat-card-value">{value}</span>
            {delta || hint ? (
              <span className="stat-card-meta">
                {delta ? <DeltaBadge delta={delta} /> : null}
                {hint ? <span className="stat-card-hint">{hint}</span> : null}
              </span>
            ) : null}
          </>
        )}
      </span>
    </>
  );

  if (href && !loading) {
    return (
      <Link href={href} className={classes}>
        {body}
      </Link>
    );
  }

  return (
    <div className={classes} aria-busy={loading || undefined}>
      {body}
    </div>
  );
}

function DeltaBadge({ delta }: { delta: StatDelta }) {
  const Icon = DELTA_ICON[delta.direction];
  return (
    <span className={`stat-card-delta stat-card-delta-${deltaIntent(delta)}`}>
      <Icon size={14} aria-hidden="true" />
      <span aria-hidden="true">
        {delta.value}
        {delta.label ? ` ${delta.label}` : ''}
      </span>
      <span className="sr-only">{describeDelta(delta)}</span>
    </span>
  );
}

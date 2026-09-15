import type { CSSProperties, ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';
import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';
import { ErrorState } from '../ErrorState';

export type ChartCardState = 'loading' | 'empty' | 'error';

export interface ChartCardProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Replaces the content with a skeleton, an empty message or an error with retry. */
  state?: ChartCardState;
  emptyText?: string;
  errorText?: string;
  /** Retry handler for the error state (Client Components only). */
  onRetry?: () => void;
  /**
   * Minimum height of the chart area in px (default 240). Charts that fill their
   * parent (TrendChart) take exactly this height; taller content, such as a
   * BarBreakdown with many rows, grows the card. 'auto' lets the content size itself.
   */
  height?: number | 'auto';
  children?: ReactNode;
  className?: string;
}

const DEFAULT_HEIGHT = 240;

/** Card that frames a chart (or any dashboard block) with loading / empty / error states. */
export function ChartCard({
  title,
  description,
  actions,
  state,
  emptyText = 'Sin datos para mostrar en este periodo.',
  errorText = 'Intenta de nuevo en unos segundos.',
  onRetry,
  height = DEFAULT_HEIGHT,
  children,
  className,
}: ChartCardProps) {
  const fixedHeight = height === 'auto' ? undefined : height;
  // The height is a minimum: charts that fill their parent (TrendChart) take exactly
  // --chart-card-height, while content with its own height (a BarBreakdown with many
  // rows) grows the card instead of spilling over its border.
  const bodyStyle: CSSProperties =
    state || fixedHeight === undefined
      ? { minHeight: fixedHeight }
      : ({ minHeight: fixedHeight, '--chart-card-height': `${fixedHeight}px` } as CSSProperties);

  return (
    <section className={cn('chart-card', className)} aria-busy={state === 'loading' || undefined}>
      <header className="chart-card-header">
        <div className="chart-card-heading">
          <h3 className="chart-card-title">{title}</h3>
          {description ? <p className="chart-card-description">{description}</p> : null}
        </div>
        {actions ? <div className="chart-card-actions">{actions}</div> : null}
      </header>
      <div className={cn('chart-card-body', state && 'chart-card-body-state')} style={bodyStyle}>
        {state === 'loading' ? (
          <div className="chart-card-loading" role="status">
            <span className="sr-only">Cargando {title}…</span>
            <Skeleton className="chart-card-skeleton" aria-hidden="true" />
          </div>
        ) : null}
        {state === 'empty' ? (
          <div className="chart-card-state">
            <BarChart3 size={20} className="chart-card-state-icon" aria-hidden="true" />
            <p className="chart-card-state-text">{emptyText}</p>
          </div>
        ) : null}
        {state === 'error' ? (
          <ErrorState
            compact
            className="chart-card-error"
            title={`No se pudo cargar «${title}»`}
            message={errorText}
            onRetry={onRetry}
          />
        ) : null}
        {state ? null : children}
      </div>
    </section>
  );
}

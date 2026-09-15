import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface KpiGridProps {
  /**
   * Columns on wide screens: 4 → 3 (≤1366px) → 2 (≤1024px) → 1 (≤640px).
   * A 4-column grid holding a multiple of 4 tiles (4, 8) skips the 3-column step
   * (4 → 2 → 1) so no row is left incomplete.
   */
  columns?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
  /** Optional accessible name when the grid is a landmark-like group of KPIs. */
  'aria-label'?: string;
}

/** Responsive grid for StatCard tiles. Works in Server and Client Components. */
export function KpiGrid({
  columns = 4,
  children,
  className,
  'aria-label': ariaLabel,
}: KpiGridProps) {
  return (
    <div
      className={cn('kpi-grid', `kpi-grid-cols-${columns}`, className)}
      role={ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

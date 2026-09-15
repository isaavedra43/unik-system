import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

export interface ErrorStateProps {
  title: string;
  message?: string;
  /** Shows a "Reintentar" button. Only available from Client Components. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Smaller paddings and icon, for cards and panels. */
  compact?: boolean;
  className?: string;
}

/** Error placeholder for data views (pairs with EmptyState and LoadingState). */
export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = 'Reintentar',
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn('ui-error-state', compact && 'ui-error-state-compact', className)}
      role="alert"
    >
      <span className="ui-error-state-icon" aria-hidden="true">
        <AlertTriangle size={compact ? 18 : 22} />
      </span>
      <p className="ui-error-state-title">{title}</p>
      {message ? <p className="ui-error-state-message">{message}</p> : null}
      {onRetry ? (
        <div className="ui-error-state-action">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

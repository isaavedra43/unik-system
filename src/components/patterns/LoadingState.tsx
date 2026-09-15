import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';

export type LoadingStateVariant = 'table' | 'kpi' | 'chat' | 'list';

export interface LoadingStateProps {
  variant: LoadingStateVariant;
  /** Number of placeholder rows / tiles / messages. */
  rows?: number;
  /** Text announced to assistive technology. */
  label?: string;
  className?: string;
}

const DEFAULT_ROWS: Record<LoadingStateVariant, number> = {
  table: 6,
  kpi: 4,
  chat: 4,
  list: 5,
};

const TABLE_COLUMNS = 4;

/** Skeleton placeholder shaped like the content being loaded. */
export function LoadingState({ variant, rows, label = 'Cargando…', className }: LoadingStateProps) {
  const count = Math.max(1, Math.floor(rows ?? DEFAULT_ROWS[variant]));
  const items = Array.from({ length: count }, (_, index) => index);

  return (
    <div
      className={cn('ui-loading-state', `ui-loading-state-${variant}`, className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      <div className="ui-loading-state-shapes" aria-hidden="true">
        {variant === 'table' ? <TableShapes rows={items} /> : null}
        {variant === 'kpi' ? <KpiShapes tiles={items} /> : null}
        {variant === 'chat' ? <ChatShapes messages={items} /> : null}
        {variant === 'list' ? <ListShapes rows={items} /> : null}
      </div>
    </div>
  );
}

function TableShapes({ rows }: { rows: number[] }) {
  const columns = Array.from({ length: TABLE_COLUMNS }, (_, index) => index);
  return (
    <>
      <div className="ui-loading-state-table-row ui-loading-state-table-head">
        {columns.map((column) => (
          <Skeleton key={column} className="ui-loading-state-line ui-loading-state-line-sm" />
        ))}
      </div>
      {rows.map((row) => (
        <div key={row} className="ui-loading-state-table-row">
          {columns.map((column) => (
            <Skeleton key={column} className="ui-loading-state-line" />
          ))}
        </div>
      ))}
    </>
  );
}

function KpiShapes({ tiles }: { tiles: number[] }) {
  const columns = tiles.length >= 4 ? 4 : tiles.length === 3 ? 3 : 2;
  return (
    <div className={`kpi-grid kpi-grid-cols-${columns}`}>
      {tiles.map((tile) => (
        <div key={tile} className="stat-card">
          <Skeleton className="ui-loading-state-icon" />
          <div className="stat-card-content">
            <Skeleton className="ui-loading-state-line ui-loading-state-line-sm" />
            <Skeleton className="stat-card-skeleton-value" />
            <Skeleton className="stat-card-skeleton-hint" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatShapes({ messages }: { messages: number[] }) {
  return (
    <>
      {messages.map((message) => (
        <div
          key={message}
          className={cn(
            'ui-loading-state-bubble-row',
            message % 2 === 1 && 'ui-loading-state-bubble-row-own'
          )}
        >
          <Skeleton className="ui-loading-state-avatar" />
          <Skeleton className="ui-loading-state-bubble" />
        </div>
      ))}
    </>
  );
}

function ListShapes({ rows }: { rows: number[] }) {
  return (
    <>
      {rows.map((row) => (
        <div key={row} className="ui-loading-state-list-item">
          <Skeleton className="ui-loading-state-avatar" />
          <div className="ui-loading-state-lines">
            <Skeleton className="ui-loading-state-line" />
            <Skeleton className="ui-loading-state-line ui-loading-state-line-sm" />
          </div>
        </div>
      ))}
    </>
  );
}

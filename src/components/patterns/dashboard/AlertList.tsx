import Link from 'next/link';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ALERT_SEVERITY_LABEL,
  formatAlertTime,
  limitItems,
  toDate,
  type AlertSeverity,
} from './dashboard-utils';

export type { AlertSeverity } from './dashboard-utils';

export interface AlertListItem {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  href?: string;
  /** ISO string or Date of the event behind the alert. */
  at?: string | Date;
}

export interface AlertListProps {
  items: AlertListItem[];
  emptyText: string;
  /** Maximum visible items; the rest are summarized as "y N más". */
  max?: number;
  /** Link for the overflow summary ("Ver N más"). */
  moreHref?: string;
  /** Accessible name of the list. */
  label?: string;
  className?: string;
}

const SEVERITY_ICON = {
  danger: AlertOctagon,
  warning: AlertTriangle,
  info: Info,
} as const;

/** Prioritized alerts with textual severity, optional link and timestamp. */
export function AlertList({
  items,
  emptyText,
  max,
  moreHref,
  label = 'Alertas',
  className,
}: AlertListProps) {
  if (items.length === 0) {
    return (
      <div className={cn('alert-list-empty', className)} role="status">
        <CheckCircle2 size={18} className="alert-list-empty-icon" aria-hidden="true" />
        <p className="alert-list-empty-text">{emptyText}</p>
      </div>
    );
  }

  const { visible, hidden } = limitItems(items, max);

  return (
    <div className={cn('alert-list', className)}>
      <ul className="alert-list-items" aria-label={label}>
        {visible.map((item) => {
          const Icon = SEVERITY_ICON[item.severity];
          const date = toDate(item.at);
          return (
            <li key={item.id} className={`alert-list-item alert-list-item-${item.severity}`}>
              <span className="alert-list-icon" aria-hidden="true">
                <Icon size={16} />
              </span>
              <div className="alert-list-body">
                <p className="alert-list-title">
                  <span className="alert-list-severity">
                    {ALERT_SEVERITY_LABEL[item.severity]}
                    <span className="sr-only">:</span>
                  </span>
                  {item.href ? (
                    <Link href={item.href} className="alert-list-link">
                      {item.title}
                    </Link>
                  ) : (
                    <span>{item.title}</span>
                  )}
                </p>
                {item.detail ? <p className="alert-list-detail">{item.detail}</p> : null}
              </div>
              {date ? (
                <time
                  className="alert-list-time"
                  dateTime={date.toISOString()}
                  suppressHydrationWarning
                >
                  {formatAlertTime(date)}
                </time>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        moreHref ? (
          <Link href={moreHref} className="alert-list-more alert-list-more-link">
            Ver {hidden.toLocaleString('es-MX')} más
          </Link>
        ) : (
          <p className="alert-list-more">y {hidden.toLocaleString('es-MX')} más</p>
        )
      ) : null}
    </div>
  );
}

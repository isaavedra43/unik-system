// `.ct-health-list` / `.ct-health-row` viven en esta hoja, que sólo importaba
// `/app/admin/control-tower/[view]/page.tsx`: la story salía sin estilo. Next dedupe
// la hoja, así que cargarla desde el componente no cambia nada en la app.
import '@/styles/operations/control-tower.css';
import type { ReactNode } from 'react';
import type { HealthTone } from './overview-model';

/**
 * Two-column list of "name → value" rows with a health tone (plan 7.7
 * `resumen`): the Zoho sync runs, the job queue, the freshness of the
 * projections and who carries the overdue work.
 *
 * Presentational and server-safe: it receives strings already formatted and
 * decides nothing. The tone is textual as well as coloured (the value carries
 * its own label), so colour is never the only carrier of meaning.
 */

export interface HealthListItem {
  id: string;
  label: string;
  /** Second line under the name (source, area, area of the number). */
  hint?: string;
  /** Already formatted for a person ("hace 3 min", "12", "$1,204.00"). */
  value: ReactNode;
  tone?: HealthTone;
}

export interface HealthListProps {
  items: HealthListItem[];
  /** Shown when there is nothing to list. */
  emptyText: string;
  /** Accessible name of the list. */
  label: string;
  /** Rows shown at most; the rest are summarized as "y N más". */
  max?: number;
}

export function HealthList({ items, emptyText, label, max }: HealthListProps) {
  if (items.length === 0) {
    return <p className="text-muted text-sm">{emptyText}</p>;
  }
  const visible = typeof max === 'number' ? items.slice(0, max) : items;
  const hidden = items.length - visible.length;

  return (
    <ul className="ct-health-list" aria-label={label}>
      {visible.map((item) => (
        <li key={item.id} className="ct-health-row">
          <span className="ct-health-name">
            {item.label}
            {item.hint ? <small>{item.hint}</small> : null}
          </span>
          <span className={`ct-health-value${item.tone ? ` ct-tone-${item.tone}` : ''}`}>
            {item.value}
          </span>
        </li>
      ))}
      {hidden > 0 ? (
        <li className="ct-health-row">
          <span className="ct-health-name">y {hidden} más</span>
          <span className="ct-health-value" />
        </li>
      ) : null}
    </ul>
  );
}

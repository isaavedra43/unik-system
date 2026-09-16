'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/primitives';
import {
  filterTimeline,
  mergeTimeline,
  timelineAreaFilters,
  type CaseTimelineEntry,
} from './case-model';

export interface CaseTimelineProps {
  caseId: string;
  /** Newest first, already rendered with `formatTimelineLine` on the server. */
  entries: CaseTimelineEntry[];
  /** Cursor for older entries, or null when the timeline reached the start. */
  olderCursor: string | null;
  /** Told the area the person is looking at, so the copilot sees the same view. */
  onFilterChange?: (areaKey: string) => void;
}

/**
 * Full timeline of the case (plan 2.7): every `OperationalEvent` except the AI
 * turn audit, in one line per fact, with area filters and older pages on
 * demand. The lines are written by `formatTimelineLine` on the server, so the
 * case room and this page never diverge.
 */
export function CaseTimeline({ caseId, entries, olderCursor, onFilterChange }: CaseTimelineProps) {
  const [loaded, setLoaded] = useState<CaseTimelineEntry[]>(entries);
  const [cursor, setCursor] = useState<string | null>(olderCursor);
  const [area, setArea] = useState('all');
  const [loading, setLoading] = useState(false);

  const filters = useMemo(() => timelineAreaFilters(loaded), [loaded]);
  const visible = useMemo(() => filterTimeline(loaded, area), [loaded, area]);

  function selectArea(next: string) {
    setArea(next);
    onFilterChange?.(next);
  }

  async function loadOlder() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/app/operations/cases/${encodeURIComponent(caseId)}/api/timeline?beforeId=${encodeURIComponent(cursor)}`
      );
      const json = (await response.json().catch(() => ({}))) as {
        entries?: CaseTimelineEntry[];
        olderCursor?: string | null;
        error?: string;
      };
      if (!response.ok || !json.entries) {
        throw new Error(json.error ?? 'No pudimos cargar más historia');
      }
      setLoaded((current) => mergeTimeline(current, json.entries ?? []));
      setCursor(json.olderCursor ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No pudimos cargar más historia');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-3">
      {filters.length > 1 ? (
        <div className="case-chips" role="group" aria-label="Filtrar la cronología por área">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={`case-chip ${filter.key === area ? 'case-chip-active' : ''}`.trim()}
              aria-pressed={filter.key === area}
              onClick={() => selectArea(filter.key)}
            >
              {filter.label} <span aria-hidden="true">·</span> {filter.count}
            </button>
          ))}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="case-empty">
          <strong>Sin movimientos en este filtro</strong>
          <p>Elige otra área para ver lo que ha pasado en el expediente.</p>
        </div>
      ) : (
        <ul className="case-timeline">
          {visible.map((entry) => (
            <li key={entry.id} className="case-timeline-item">
              <span>{entry.line}</span>
              <span className="case-timeline-meta">
                {entry.areaLabel ?? 'Sistema'}
                {entry.actorType === 'ai' ? ' · IA' : entry.actorType === 'zoho' ? ' · Zoho' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {cursor ? (
        <div className="case-timeline-more">
          <Button variant="secondary" size="sm" onClick={loadOlder} disabled={loading}>
            {loading ? 'Cargando…' : 'Ver historia anterior'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

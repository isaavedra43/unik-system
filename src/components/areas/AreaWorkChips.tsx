'use client';

// `.area-chips` / `.area-chip-group` viven aquí. La hoja la importaban sólo los
// layouts de área, así que la story salía sin estilo — y Storybook es la superficie
// de revisión de UI. El componente carga su propia hoja, como ScanInput u OfflineBadge.
import '@/styles/operations/area-shell.css';
import Link from 'next/link';
import type { AreaChip } from './area-workspace-model';

export interface AreaWorkChipGroup {
  /** Short label of the group ("Tipo", "Estado"); hidden from small screens. */
  label: string;
  chips: AreaChip[];
}

export interface AreaWorkChipsProps {
  groups: AreaWorkChipGroup[];
  /** Accessible name of the whole bar. */
  ariaLabel?: string;
}

/**
 * Filter chips of an area work centre: row kind and scope. They are links, so
 * the state lives in the URL, the page is shareable and the back button works.
 */
export function AreaWorkChips({ groups, ariaLabel = 'Filtros rápidos' }: AreaWorkChipsProps) {
  const visible = groups.filter((group) => group.chips.length > 0);
  if (visible.length === 0) return null;
  return (
    <div className="area-chips" role="group" aria-label={ariaLabel}>
      {visible.map((group) => (
        <div key={group.label} className="area-chip-group">
          <span className="area-chip-group-label" aria-hidden="true">
            {group.label}
          </span>
          {group.chips.map((chip) => (
            <Link
              key={chip.id}
              href={chip.href}
              className={`area-chip ${chip.active ? 'area-chip-active' : ''}`}
              aria-current={chip.active ? 'true' : undefined}
              title={chip.title}
              scroll={false}
            >
              {chip.label}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

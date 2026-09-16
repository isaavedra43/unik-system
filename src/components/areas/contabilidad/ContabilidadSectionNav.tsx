// `.fin-section-nav` vive en esta hoja: sin importarla aquí la story sale sin estilo.
import '@/styles/operations/contabilidad.css';
import Link from 'next/link';
import type { ContabilidadSection } from '@/modules/areas/contabilidad/contabilidad-model';

export interface ContabilidadSectionNavProps {
  /** Sections this person may open (`visibleContabilidadSections`). */
  sections: readonly ContabilidadSection[];
  /** Id of the section being shown; the rest are links. */
  activeId: string;
  /** Accessible name of the group. */
  label?: string;
}

/**
 * Links between the Contabilidad surfaces (Libro de caja, gastos, obligaciones,
 * nómina, presupuestos, cierre y catálogos). The area tabs cover the four
 * spaces of the registry; this strip covers the management pages, so a person
 * never has to go back to the menu to move inside Contabilidad.
 *
 * Works in Server and Client Components (only links, no state).
 */
export function ContabilidadSectionNav({
  sections,
  activeId,
  label = 'Secciones de Contabilidad',
}: ContabilidadSectionNavProps) {
  if (sections.length === 0) return null;
  return (
    <nav className="fin-section-nav" aria-label={label}>
      {sections.map((section) => {
        const active = section.id === activeId;
        return (
          <Link
            key={section.id}
            href={section.href}
            className={`fin-section-link${active ? ' fin-section-link-active' : ''}`}
            title={section.description}
            {...(active ? { 'aria-current': 'page' as const } : {})}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}

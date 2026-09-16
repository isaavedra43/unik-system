'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-is-mobile';

export interface CaseSectionProps {
  /** Anchor of the section (`#trabajos`), stable for deep links. */
  id: string;
  title: string;
  /** Short count shown next to the title ("3 abiertos"). */
  count?: ReactNode;
  /** Buttons of the section header (desktop only; on a phone they go inside). */
  actions?: ReactNode;
  /** Open when the phone first shows the page (plan 7.10: secciones colapsables). */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * One section of the Expediente 360. On a desktop it is a plain block with its
 * heading; at ≤768 px the heading becomes a button that folds the section, so
 * the phone shows the case as a short list instead of an endless page.
 */
export function CaseSection({
  id,
  title,
  count,
  actions,
  defaultOpen = false,
  children,
}: CaseSectionProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `${useId()}-body`;
  const expanded = !isMobile || open;

  return (
    <section className="case-section" id={id} aria-labelledby={`${id}-title`}>
      {isMobile ? (
        <button
          type="button"
          className="case-section-head"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <h2 id={`${id}-title`} className="case-section-title">
            {title}
            {count ? <span className="case-section-count">{count}</span> : null}
          </h2>
          <span className="case-section-chevron" aria-hidden="true">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>
      ) : (
        <div className="case-section-head">
          <h2 id={`${id}-title`} className="case-section-title">
            {title}
            {count ? <span className="case-section-count">{count}</span> : null}
          </h2>
          {actions ? <div className="case-item-actions">{actions}</div> : null}
        </div>
      )}

      <div className="case-section-body" id={bodyId} hidden={!expanded}>
        {isMobile && actions ? <div className="case-item-actions">{actions}</div> : null}
        {children}
      </div>
    </section>
  );
}

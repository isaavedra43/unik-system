import { cn } from '@/lib/utils';
import {
  describeStatusStrip,
  formatShare,
  segmentShare,
  totalSegments,
  type StatusSegment,
} from './dashboard-utils';

export type { StatusSegment } from './dashboard-utils';

export interface StatusStripProps {
  segments: StatusSegment[];
  /** Prefix of the accessible description, e.g. "Expedientes por fase". */
  label?: string;
  showLegend?: boolean;
  className?: string;
}

/**
 * Proportional stacked bar (pure CSS) with a legend. The bar is exposed as an
 * image with a descriptive aria-label; the legend repeats the numbers visibly.
 */
export function StatusStrip({
  segments,
  label = 'Distribución por estado',
  showLegend = true,
  className,
}: StatusStripProps) {
  const total = totalSegments(segments);

  return (
    <div className={cn('status-strip', className)}>
      <div
        className={cn('status-strip-bar', total === 0 && 'status-strip-bar-empty')}
        role="img"
        aria-label={describeStatusStrip(segments, label)}
      >
        {segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <span
              key={segment.key}
              className={`status-strip-segment status-strip-tone-${segment.tone}`}
              style={{ flexGrow: segment.count }}
            />
          ))}
      </div>
      {showLegend && segments.length > 0 ? (
        <ul className="status-strip-legend">
          {segments.map((segment) => (
            <li key={segment.key} className="status-strip-legend-item">
              <span
                className={`status-strip-swatch status-strip-tone-${segment.tone}`}
                aria-hidden="true"
              />
              <span className="status-strip-legend-label">{segment.label}</span>
              <span className="status-strip-legend-count">
                {Math.max(0, segment.count).toLocaleString('es-MX')}
              </span>
              {total > 0 ? (
                <span className="status-strip-legend-share">
                  {formatShare(segmentShare(segment.count, total))}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

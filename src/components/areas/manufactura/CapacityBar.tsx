// `.mfg-capacity*` viven en esta hoja: sin importarla aquí la story sale sin estilo.
import '@/styles/operations/manufactura.css';
import Link from 'next/link';
import {
  describeWindow,
  formatPercent,
  formatQuantity,
  utilizationTone,
  type BoardWindow,
} from '@/modules/areas/manufactura/board-model';

export interface CapacityBarProps {
  windows: BoardWindow[];
  /** Unit the centre measures its capacity in ("m²", "piezas", "minutos"). */
  capacityUnitLabel: string;
  /** Shift windows shown before "y N turnos más". */
  max?: number;
  /** Name of the centre, for the accessible description. */
  centerName: string;
}

const DEFAULT_MAX = 3;

/**
 * Load of the next shifts of a work centre (plan 7.6). Pure presentation: the
 * numbers come from `capacity-rules` through the board read, so the bars say
 * exactly what the scheduler used to plan.
 */
export function CapacityBar({
  windows,
  capacityUnitLabel,
  max = DEFAULT_MAX,
  centerName,
}: CapacityBarProps) {
  if (windows.length === 0) {
    return (
      <p className="mfg-capacity-empty">
        Sin turnos configurados:{' '}
        <Link href="/app/areas/manufactura/centros">defínelos en Centros de trabajo</Link> para ver
        la carga y programar con capacidad real.
      </p>
    );
  }

  const visible = windows.slice(0, max);
  const hidden = windows.length - visible.length;

  return (
    <ul className="mfg-capacity" aria-label={`Carga por turno de ${centerName}`}>
      {visible.map((window) => {
        const tone = utilizationTone(window.utilizationPct);
        // The bar never overflows its track: beyond 100 % the tone carries the message.
        const width = Math.max(0, Math.min(window.utilizationPct, 100));
        return (
          <li
            key={`${window.day}-${window.shiftName}-${window.start}`}
            className={`mfg-capacity-row mfg-capacity-${tone}`}
          >
            <span className="mfg-capacity-label" title={describeWindow(window)}>
              {window.shiftName}
            </span>
            <span className="mfg-capacity-value">{formatPercent(window.utilizationPct)}</span>
            <span
              className="mfg-capacity-track"
              role="meter"
              aria-valuenow={Math.round(window.utilizationPct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${describeWindow(window)} · ${formatQuantity(window.load, capacityUnitLabel)} de ${formatQuantity(window.capacity, capacityUnitLabel)}`}
            >
              <span className="mfg-capacity-fill" style={{ width: `${width}%` }} />
            </span>
          </li>
        );
      })}
      {hidden > 0 ? (
        <li className="mfg-capacity-empty">
          y {hidden} {hidden === 1 ? 'turno más' : 'turnos más'} en el rango
        </li>
      ) : null}
    </ul>
  );
}

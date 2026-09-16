import '@/styles/operations/manufactura.css';
import Link from 'next/link';
import { Badge } from '@/components/ui/primitives';
import { CapacityBar } from './CapacityBar';
import { productionOrderUrl } from '@/modules/manufacturing/manufacturing-types';
import type { ShiftLoadDTO } from '@/modules/manufacturing/manufacturing-queries';

/**
 * Carga comprometida de cada centro de trabajo (plan 6.2).
 *
 * The page defines the capacity; this panel shows what is already ON it: the
 * utilization per shift (the same `capacity-rules` numbers the scheduler and
 * the capacity alerts job use) and WHICH operations fill it, which is the one
 * thing the board cannot say — the board draws the bars, not what is behind
 * them.
 *
 * Presentation only: `getWorkCenterLoad` did the reading on the server.
 */

export interface WorkCenterLoadEntry {
  workCenter: { id: string; name: string; capacityUnitLabel: string };
  windows: ShiftLoadDTO[];
  summary: { windows: number; overloadedWindows: number; peakUtilizationPct: number };
  operations: Array<{
    operationId: string;
    productionOrderId: string;
    number: string;
    name: string;
    status: string;
    plannedStartAt: string;
    load: number;
  }>;
}

export interface WorkCenterLoadPanelProps {
  entries: WorkCenterLoadEntry[];
  /** Days the reading covers, for the heading. */
  days: number;
}

const MAX_OPERATIONS = 6;

function dayText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Mexico_City',
    }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}

export function WorkCenterLoadPanel({ entries, days }: WorkCenterLoadPanelProps) {
  if (entries.length === 0) return null;

  return (
    <section className="mfg-section" aria-labelledby="mfg-load">
      <h2 id="mfg-load" className="mfg-section-title">
        Carga comprometida · próximos {days} días
      </h2>
      <p className="mfg-section-hint">
        Lo que ya está programado contra la capacidad de arriba. Un turno sobrecargado también
        levanta su aviso en Mi trabajo.
      </p>

      <div className="mfg-grid-2">
        {entries.map((entry) => (
          <div key={entry.workCenter.id} className="mfg-trace">
            <h3 className="mfg-trace-group-title">
              {entry.workCenter.name}
              {entry.summary.overloadedWindows > 0 ? (
                <>
                  {' '}
                  <Badge variant="danger">
                    {entry.summary.overloadedWindows === 1
                      ? '1 turno sobrecargado'
                      : `${entry.summary.overloadedWindows} turnos sobrecargados`}
                  </Badge>
                </>
              ) : null}
            </h3>

            <CapacityBar
              windows={entry.windows}
              capacityUnitLabel={entry.workCenter.capacityUnitLabel}
              centerName={entry.workCenter.name}
              max={4}
            />

            {entry.operations.length === 0 ? (
              <p className="mfg-section-hint">Nada programado en esta ventana.</p>
            ) : (
              <ul className="mfg-trace-list">
                {entry.operations.slice(0, MAX_OPERATIONS).map((operation) => (
                  <li key={operation.operationId} className="mfg-trace-item">
                    <span className="mfg-trace-name">
                      <Link href={productionOrderUrl(operation.productionOrderId)}>
                        {operation.number} · {operation.name}
                      </Link>
                      <span className="mfg-trace-hint">{dayText(operation.plannedStartAt)}</span>
                    </span>
                    <span className="mfg-trace-qty">
                      {operation.load} {entry.workCenter.capacityUnitLabel}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {entry.operations.length > MAX_OPERATIONS ? (
              <p className="mfg-section-hint">
                y {entry.operations.length - MAX_OPERATIONS} operación(es) más en la ventana.
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

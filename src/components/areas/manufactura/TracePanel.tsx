import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import {
  stockTraceUrl,
  type TraceLine,
  type TraceView,
} from '@/modules/areas/manufactura/trace-model';

/**
 * Trazabilidad de una orden de producción (plan 6.2).
 *
 * `recordOutput` writes `originProductionOrderId` on every existence it
 * produces; this panel is where that data is finally READ: what material went
 * in, what came out (terminado, sobrante y merma) and para qué venta se hizo.
 * Each existence links to its own trace, so the chain can be walked in both
 * directions — de la orden a sus insumos y de una existencia a su orden.
 *
 * Server component: it only paints what `traceView` already decided.
 */

export interface TracePanelProps {
  view: TraceView;
  /** `false` on the page that is already showing that order's card. */
  showOrderLink?: boolean;
  orderHref?: string;
}

function TraceLines({ lines, emptyText }: { lines: TraceLine[]; emptyText: string }) {
  if (lines.length === 0) return <p className="mfg-section-hint">{emptyText}</p>;
  return (
    <ul className="mfg-trace-list">
      {lines.map((line) => (
        <li key={line.id} className="mfg-trace-item">
          <span className="mfg-trace-name">
            {line.stockItemId ? (
              <Link href={stockTraceUrl(line.stockItemId)}>{line.label}</Link>
            ) : (
              <span>{line.label}</span>
            )}
            {line.hint ? <span className="mfg-trace-hint">{line.hint}</span> : null}
          </span>
          <span className="mfg-trace-qty">
            {line.quantity} {line.unit}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TracePanel({ view, showOrderLink = false, orderHref }: TracePanelProps) {
  return (
    <section className="mfg-section mfg-trace" aria-labelledby="mfg-trace">
      <h2 id="mfg-trace" className="mfg-section-title">
        Trazabilidad
        {showOrderLink && orderHref ? (
          <Link className="btn btn-secondary btn-sm" href={orderHref}>
            Abrir {view.orderNumber}
          </Link>
        ) : (
          <Badge variant="default">{view.statusLabel}</Badge>
        )}
      </h2>

      <p className="mfg-section-hint">{view.summary}</p>

      <div className="mfg-trace-chain" aria-hidden="true">
        <span>Materia prima</span>
        <ArrowRight size={12} />
        <span>{view.orderNumber}</span>
        <ArrowRight size={12} />
        <span>Producto terminado</span>
        <ArrowRight size={12} />
        <span>{view.sale ? (view.sale.caseNumber ?? 'Venta') : 'Inventario'}</span>
      </div>

      <div className="mfg-grid-2">
        <div>
          <h3 className="mfg-trace-group-title">Material que entró</h3>
          <TraceLines
            lines={view.materials}
            emptyText="Todavía no se registra consumo real de material en esta orden."
          />
        </div>
        <div>
          {view.outputsByKind.length === 0 ? (
            <>
              <h3 className="mfg-trace-group-title">Lo que salió</h3>
              <p className="mfg-section-hint">
                Nada registrado todavía: el terminado, el sobrante y la merma aparecen aquí en
                cuanto la planta los captura.
              </p>
            </>
          ) : (
            view.outputsByKind.map((group) => (
              <div key={group.kind}>
                <h3 className="mfg-trace-group-title">{group.label}</h3>
                <TraceLines lines={group.lines} emptyText="Sin registros." />
              </div>
            ))
          )}
        </div>
      </div>

      {view.sale ? (
        <p className="mfg-section-hint">
          Se fabricó para{' '}
          <Link href={`/app/operations/cases/${view.sale.caseId}`}>
            {view.sale.caseNumber ?? 'el expediente'}
          </Link>
          {view.sale.salesOrderNumber ? ` · ${view.sale.salesOrderNumber}` : ''}
          {view.sale.customerName ? ` · ${view.sale.customerName}` : ''}.
        </p>
      ) : (
        <p className="mfg-section-hint">
          Orden para inventario: lo producido queda disponible en la bodega de salida, sin venta
          ligada.
        </p>
      )}
    </section>
  );
}

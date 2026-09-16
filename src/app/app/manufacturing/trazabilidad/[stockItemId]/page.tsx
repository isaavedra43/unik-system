import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/composite';
import { Alert, Badge } from '@/components/ui/primitives';
import { TracePanel } from '@/components/areas/manufactura/TracePanel';
import { requireAnyPermission } from '@/modules/auth/authorization';
import { areaHref } from '@/modules/areas/area-registry';
import { stockTraceView } from '@/modules/areas/manufactura/trace-model';
import { traceStockItem } from '@/modules/manufacturing/manufacturing-queries';
import { isOperationsError } from '@/modules/operations/errors';
import '@/styles/operations/manufactura.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Trazabilidad de UNA existencia (plan 6.2): de esta existencia hacia la orden
 * de producción que la produjo y, desde ahí, hacia las materias primas que
 * entraron y la venta para la que se hizo.
 *
 * Es la otra mitad del dato que `recordOutput` ya escribía
 * (`StockItem.originProductionOrderId` y los movimientos `produce`) y que hasta
 * ahora no tenía dónde consultarse. La consulta la hace `traceStockItem`, que
 * exige `manufacturing.view` o `inventory.view`: el almacén, que es quien tiene
 * la tarima enfrente, entra con su propio permiso.
 */

export default async function StockTracePage({
  params,
}: {
  params: Promise<{ stockItemId: string }>;
}) {
  const { stockItemId } = await params;
  const user = await requireAnyPermission(['manufacturing.view', 'inventory.view']);

  let result: Awaited<ReturnType<typeof traceStockItem>>;
  try {
    result = await traceStockItem(user, decodeURIComponent(stockItemId));
  } catch (error) {
    if (isOperationsError(error) && error.code === 'not_found') notFound();
    throw error;
  }

  const view = stockTraceView(result);

  return (
    <div className="mfg-order">
      <PageHeader
        title={`Trazabilidad · ${result.stockItem.containerKey || result.stockItem.zohoItemId}`}
        description="De esta existencia hacia la orden que la produjo, sus materias primas y la venta para la que se fabricó."
      />

      <div className="mfg-order-head">
        <Badge variant={view.external ? 'weak' : 'success'}>
          {view.external ? 'Sin orden de producción' : 'Producida en planta'}
        </Badge>
        <Link className="btn btn-secondary btn-sm" href={areaHref('inventario', 'mapa')}>
          Ver el mapa de inventario
        </Link>
      </div>

      <Alert variant={view.external ? 'info' : 'success'}>{view.headline}</Alert>

      {view.productions.length > 1 ? (
        <section className="mfg-section" aria-labelledby="mfg-trace-orders">
          <h2 id="mfg-trace-orders" className="mfg-section-title">
            Órdenes que produjeron en esta existencia
          </h2>
          <p className="mfg-section-hint">
            Varias órdenes dejaron material aquí; abajo se detalla la última. Abre cualquiera para
            ver sus insumos.
          </p>
          <ul className="mfg-trace-list">
            {view.productions.map((production) => (
              <li key={production.productionOrderId} className="mfg-trace-item">
                <span className="mfg-trace-name">
                  <Link href={production.href}>{production.number ?? 'Orden sin folio'}</Link>
                </span>
                <span className="mfg-trace-qty">{production.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.production ? (
        <TracePanel
          view={view.production}
          showOrderLink
          orderHref={view.productions[0]?.href ?? '#'}
        />
      ) : null}
    </div>
  );
}

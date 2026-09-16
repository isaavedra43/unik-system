import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { PageHeader } from '@/components/ui/composite';
import { Alert, Badge } from '@/components/ui/primitives';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { OrderMaterialsPanel } from '@/components/areas/manufactura/OrderMaterialsPanel';
import { OrderPlanPanel } from '@/components/areas/manufactura/OrderPlanPanel';
import { OrderQualityPanel } from '@/components/areas/manufactura/OrderQualityPanel';
import { TracePanel } from '@/components/areas/manufactura/TracePanel';
import { requirePermission } from '@/modules/auth/authorization';
import { areaHref } from '@/modules/areas/area-registry';
import {
  getProductionOrderDetail,
  getProductionTrace,
  listWorkCenters,
} from '@/modules/manufacturing/manufacturing-queries';
import { traceView } from '@/modules/areas/manufactura/trace-model';
import { isOperationsError } from '@/modules/operations/errors';
import '@/styles/operations/manufactura.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ficha completa de una orden de producción — the page
 * `manufacturing-types.productionOrderUrl` has always pointed at, and where the
 * work centre, the board and the notifications of Manufactura send people.
 *
 * Reservations, operations, real consumption, outputs (finished goods, saleable
 * leftovers and scrap with their measures), quality with evidence, the
 * substitution and scrap approvals and the release, each one running the
 * module's own command through `executeCommand`.
 */

const STATUS_TONE: Record<string, 'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak'> =
  {
    draft: 'weak',
    reserved: 'default',
    prepared: 'info',
    in_progress: 'info',
    inspection: 'warning',
    completed: 'success',
    released: 'success',
    cancelled: 'weak',
    blocked: 'danger',
  };

export default async function ProductionOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePermission('manufacturing.view');

  let detail: Awaited<ReturnType<typeof getProductionOrderDetail>>;
  try {
    detail = await getProductionOrderDetail(user, id);
  } catch (error) {
    if (isOperationsError(error) && error.code === 'not_found') notFound();
    throw error;
  }

  const { order } = detail;
  const operatorIds = [
    ...new Set(
      detail.operations
        .map((operation) => operation.assignedUserId)
        .filter((value): value is string => Boolean(value))
    ),
  ];
  const [centers, operators, trace] = await Promise.all([
    listWorkCenters(user, { status: 'active' }),
    operatorIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: operatorIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    // La cadena que escribe `recordOutput`: de dónde salió el material y a
    // dónde fue lo producido (plan 6.2).
    getProductionTrace(user, id),
  ]);
  const operatorNames = Object.fromEntries(operators.map((person) => [person.id, person.name]));

  const scrapPct = detail.scrap.maxPct;

  return (
    <div className="mfg-order">
      <PageHeader
        title={`${order.number} · ${order.outputName ?? order.outputZohoItemId}`}
        description={`${order.kindLabel} · ${order.plannedQty} ${order.plannedUnit} · se libera a ${order.releaseTargetLabel}`}
      />

      <div className="mfg-order-head">
        <Badge variant={STATUS_TONE[order.status] ?? 'default'}>{order.statusLabel}</Badge>
        {order.workCenterName ? <Badge variant="info">{order.workCenterName}</Badge> : null}
        {detail.case ? (
          <span className="area-row-sub">
            Expediente {detail.case.caseNumber}
            {detail.case.customerName ? ` · ${detail.case.customerName}` : ''}
            {detail.case.salesOrderNumber ? ` · ${detail.case.salesOrderNumber}` : ''}
          </span>
        ) : (
          <span className="area-row-sub">Orden para inventario, sin expediente de venta</span>
        )}
        <Link className="btn btn-secondary btn-sm" href={areaHref('manufactura', 'tablero')}>
          Ver el tablero
        </Link>
      </div>

      {order.blockedReason ? (
        <Alert variant="warning" title="Material faltante">
          {order.blockedReason} · Compras e Inventario ya tienen la solicitud correspondiente.
        </Alert>
      ) : null}

      <KpiGrid columns={4}>
        <StatCard
          label="Planeado"
          value={`${order.plannedQty} ${order.plannedUnit}`}
          hint={order.plannedStartAt ? 'Con fecha de inicio' : 'Sin programar'}
        />
        <StatCard
          label="Producido"
          value={`${order.producedQty} ${order.plannedUnit}`}
          tone={Number(order.producedQty) > 0 ? 'success' : 'default'}
        />
        <StatCard
          label="Merma"
          value={`${order.scrapQty} ${order.plannedUnit}`}
          tone={detail.scrap.exceeded ? 'danger' : 'default'}
          hint={
            scrapPct !== null ? `${scrapPct} % · tolerancia ${detail.scrap.allowancePct} %` : null
          }
        />
        <StatCard
          label="Sobrante"
          value={`${order.leftoverQty} ${order.plannedUnit}`}
          hint="Material vendible que regresó a inventario"
        />
      </KpiGrid>

      <OrderPlanPanel
        order={order}
        operations={detail.operations}
        centers={centers.map((center) => ({
          id: center.id,
          name: center.name,
          capacityUnitLabel: center.capacityUnitLabel,
        }))}
        operatorNames={operatorNames}
      />

      <OrderMaterialsPanel
        order={order}
        materials={detail.materials}
        consumptions={detail.consumptions}
        outputs={detail.outputs}
        balance={detail.balance}
      />

      <OrderQualityPanel
        order={order}
        operations={detail.operations}
        qualityChecks={detail.qualityChecks}
        scrap={detail.scrap}
        scrapApproval={detail.scrapApproval}
        release={detail.release}
        pendingSubstitutions={detail.pendingSubstitutionIds.length}
      />

      <TracePanel view={traceView(trace)} />

      {detail.requests.length > 0 ? (
        <section className="mfg-section" aria-labelledby="mfg-requests">
          <h2 id="mfg-requests" className="mfg-section-title">
            Solicitudes de esta orden
          </h2>
          <ul className="area-evidence-list">
            {detail.requests.map((request) => (
              <li key={request.id} className="area-evidence-item">
                {request.title} · {request.toAreaKey} · {request.status}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

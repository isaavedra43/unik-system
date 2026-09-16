'use client';

// Hoja del área de Compras (sólo tokens). Next permite CSS global desde un
// componente; este módulo es la raíz del cliente del área.
import '@/styles/operations/compras.css';

import { Badge } from '@/components/ui/primitives';
import { registerAreaClient, type AreaDetailExtrasProps } from '../area-client-registry';
import {
  COMPRAS_ROW_KIND_LABELS,
  formatMoney,
  formatQty,
} from '@/modules/areas/compras/compras-model';
import { extraNumber, extraString, type AreaWorkRow } from '@/modules/areas/area-work-row';
import type { EntityColumnDefinition } from '@/modules/shared/entity-workspace-types';
import { ReceiptCapturePanel } from './ReceiptCapturePanel';
import { RfqReviewPanel } from './RfqReviewPanel';
import { OrderOperationsPanel } from './OrderOperationsPanel';
import { PurchaseRequestConsolidationPanel } from './PurchaseRequestConsolidationPanel';
import { SourcingLab } from './SourcingLab';
import { SupplierEvaluationPanel } from './SupplierEvaluationPanel';

/**
 * Client side of the Compras area (plan 7.2): the labels of its row kinds, the
 * cells that say something the shared renderer cannot, and the specialized
 * view (Laboratorio de Sourcing, plan 7.6).
 *
 * Registering happens on import; `register-all-client.tsx` loads this file on
 * demand, only for Compras.
 */

/**
 * Cells of the Compras rows. Returning `undefined` leaves the column to the
 * shared renderer, which already handles every common column.
 */
function renderCell(row: AreaWorkRow, column: EntityColumnDefinition): React.ReactNode | undefined {
  if (column.id === 'title' && row.rowKind === 'supplier') {
    const products = extraNumber(row.extra, 'products') ?? 0;
    const rating = extraString(row.extra, 'rating');
    const number = extraString(row.extra, 'number');
    return (
      <span className="area-row-title">
        <span className="area-row-title-main">{row.title}</span>
        <span className="area-row-sub">
          {[
            number,
            rating ? `${rating} de 5` : 'Sin calificar',
            products === 1 ? '1 producto' : `${products} productos`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    );
  }

  // What is still expected from the supplier, never available stock.
  if (column.id === 'quantity' && row.rowKind === 'procurement_order') {
    const pending = extraNumber(row.extra, 'pendingQty');
    if (pending === null) return undefined;
    return pending > 0 ? (
      <span title="Cantidad que el proveedor todavía debe entregar">
        {formatQty(pending)} por recibir
      </span>
    ) : (
      <span className="text-muted">Todo recibido</span>
    );
  }

  if (column.id === 'amount' && row.rowKind === 'rfq') {
    if (row.amount === null) return <span className="text-muted">Sin respuestas</span>;
    const needsReview = extraNumber(row.extra, 'needsReview') ?? 0;
    return (
      <span title="Mejor costo puesto en bodega de las respuestas recibidas">
        {formatMoney(row.amount)}
        {needsReview > 0 ? <span className="area-row-sub">{needsReview} por revisar</span> : null}
      </span>
    );
  }

  if (column.id === 'status' && row.rowKind === 'goods_receipt') {
    const differences = extraNumber(row.extra, 'differences') ?? 0;
    if (differences > 0) {
      return (
        <Badge variant="danger">
          {row.statusLabel} · {differences === 1 ? '1 diferencia' : `${differences} diferencias`}
        </Badge>
      );
    }
    return undefined;
  }

  return undefined;
}

/**
 * Panel de gestión de UNA fila de Compras, en su página de detalle (plan 6.1):
 * los flujos que el diálogo compartido no puede recoger porque piden datos
 * estructurados.
 *
 * - `procurement_order`: captura de la recepción con cantidad aceptada y
 *   rechazada por partida, y resolución de las diferencias abiertas.
 * - `rfq`: respuestas de los proveedores sobre su comparación con puntaje, con
 *   confirmar, descartar y elegir (que crea el borrador de la orden).
 *
 * Cualquier otra clase de fila no pinta nada: la página ya está completa sin
 * esto.
 */
function DetailExtras({ rowKind, entityId, areaKey, canAct }: AreaDetailExtrasProps) {
  if (rowKind === 'procurement_order') {
    return (
      <>
        <OrderOperationsPanel areaKey={areaKey} orderId={entityId} canAct={canAct} />
        <ReceiptCapturePanel areaKey={areaKey} orderId={entityId} canAct={canAct} />
      </>
    );
  }
  if (rowKind === 'rfq') {
    return <RfqReviewPanel areaKey={areaKey} rfqId={entityId} canAct={canAct} />;
  }
  if (rowKind === 'purchase_request') {
    return (
      <PurchaseRequestConsolidationPanel areaKey={areaKey} requestId={entityId} canAct={canAct} />
    );
  }
  if (rowKind === 'supplier') {
    return <SupplierEvaluationPanel areaKey={areaKey} supplierId={entityId} canAct={canAct} />;
  }
  return null;
}

registerAreaClient('compras', {
  renderCell,
  rowKindLabels: COMPRAS_ROW_KIND_LABELS,
  SpecialView: SourcingLab,
  DetailExtras,
});

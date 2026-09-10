import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/modules/auth/authorization';
import { getPurchaseOrderById } from '@/modules/purchase-orders/purchase-orders-service';
import { getBillsByPurchaseOrderZohoId } from '@/modules/cross-module/relationships-service';

export const runtime = 'nodejs';

export default async function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('purchase_orders.view');
  const { id } = await params;
  const purchaseOrder = await getPurchaseOrderById(id);
  if (!purchaseOrder) notFound();

  let relatedBills: Awaited<ReturnType<typeof getBillsByPurchaseOrderZohoId>> = [];
  try {
    relatedBills = purchaseOrder.zohoPurchaseOrderId
      ? await getBillsByPurchaseOrderZohoId(purchaseOrder.zohoPurchaseOrderId)
      : [];
  } catch (error) {
    console.error('Error loading related bills:', error);
  }

  return (
    <div className="app-content">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
        <Link href="/app/purchase-orders" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Volver a órdenes de compra
        </Link>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{purchaseOrder.purchaseOrderNumber ?? '—'}</h1>
              <p className="text-sm text-muted-foreground">Orden de Compra · {purchaseOrder.vendorName ?? '—'}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
              {purchaseOrder.status ?? '—'}
            </span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard label="Fecha" value={purchaseOrder.date ? new Date(purchaseOrder.date).toLocaleDateString() : '—'} />
          <DetailCard label="Vencimiento" value={purchaseOrder.dueDate ? new Date(purchaseOrder.dueDate).toLocaleDateString() : '—'} />
          <DetailCard label="Entrega" value={purchaseOrder.deliveryDate ? new Date(purchaseOrder.deliveryDate).toLocaleDateString() : '—'} />
          <DetailCard label="Proveedor" value={purchaseOrder.vendorName ?? '—'} />
          <DetailCard label="Subtotal" value={purchaseOrder.subTotal ?? '—'} />
          <DetailCard label="Impuestos" value={purchaseOrder.taxTotal ?? '—'} />
          <DetailCard label="Descuento" value={purchaseOrder.discountTotal ?? '—'} />
          <DetailCard label="Envío" value={purchaseOrder.shippingCharge ?? '—'} />
          <DetailCard label="Total" value={purchaseOrder.total ?? '—'} />
          <DetailCard label="Saldo" value={purchaseOrder.balance ?? '—'} />
          <DetailCard label="Moneda" value={purchaseOrder.currencyCode ?? '—'} />
          <DetailCard label="Vendedor" value={purchaseOrder.salespersonName ?? '—'} />
          <DetailCard label="Referencia" value={purchaseOrder.referenceNumber ?? '—'} />
        </div>

        {purchaseOrder.items.length > 0 && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Conceptos</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Producto</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Descripción</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Cantidad</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Precio</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseOrder.items.map((item) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-3 py-2">{item.name ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{item.description ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{item.quantity ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{item.rate ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{item.lineTotal ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {purchaseOrder.notes && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Notas</h2>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{purchaseOrder.notes}</p>
          </div>
        )}

        {relatedBills.length > 0 && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Bills relacionados ({relatedBills.length})</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {relatedBills.map((bill) => (
                <Link
                  key={bill.id}
                  href={`/app/bills/${bill.id}`}
                  className="inline-flex items-center justify-between rounded-md border border-input bg-background px-4 py-2.5 text-sm hover:bg-accent transition-colors"
                >
                  <span className="font-medium">{bill.billNumber ?? '—'}</span>
                  <span className="text-muted-foreground text-xs">{bill.status ?? '—'} · {bill.total ?? '—'}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Sincronización</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Última modificación remota" value={new Date(purchaseOrder.sourceRemoteModifiedAt).toLocaleString()} />
            <DetailCard label="Última normalización" value={new Date(purchaseOrder.normalizedAt).toLocaleString()} />
            <DetailCard label="ID Zoho" value={purchaseOrder.zohoPurchaseOrderId} />
            <DetailCard label="ID Snapshot" value={purchaseOrder.sourceSnapshotId} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-1">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-sm font-medium truncate">{value}</p>
    </div>
  );
}

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/modules/auth/authorization';
import { getBillById } from '@/modules/bills/bills-service';

export const runtime = 'nodejs';

export default async function BillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('bills.view');
  const { id } = await params;
  const bill = await getBillById(id);
  if (!bill) notFound();

  return (
    <div className="app-content">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
        <Link href="/app/bills" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Volver a bills
        </Link>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{bill.billNumber ?? '—'}</h1>
              <p className="text-sm text-muted-foreground">Bill · {bill.vendorName ?? '—'}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
              {bill.status ?? '—'}
            </span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard label="Fecha" value={bill.date ? new Date(bill.date).toLocaleDateString() : '—'} />
          <DetailCard label="Vencimiento" value={bill.dueDate ? new Date(bill.dueDate).toLocaleDateString() : '—'} />
          <DetailCard label="Proveedor" value={bill.vendorName ?? '—'} />
          <DetailCard label="Orden de compra" value={bill.zohoPurchaseOrderId ?? '—'} />
          <DetailCard label="Subtotal" value={bill.subTotal ?? '—'} />
          <DetailCard label="Impuestos" value={bill.taxTotal ?? '—'} />
          <DetailCard label="Total" value={bill.total ?? '—'} />
          <DetailCard label="Saldo" value={bill.balance ?? '—'} />
          <DetailCard label="Créditos aplicados" value={bill.vendorCreditsApplied ?? '—'} />
          <DetailCard label="Moneda" value={bill.currencyCode ?? '—'} />
        </div>

        {bill.notes && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Notas</h2>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{bill.notes}</p>
          </div>
        )}

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Sincronización</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Última modificación remota" value={new Date(bill.sourceRemoteModifiedAt).toLocaleString()} />
            <DetailCard label="Última normalización" value={new Date(bill.normalizedAt).toLocaleString()} />
            <DetailCard label="ID Zoho" value={bill.zohoBillId} />
            <DetailCard label="ID Snapshot" value={bill.sourceSnapshotId} />
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

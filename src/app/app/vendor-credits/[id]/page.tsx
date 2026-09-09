import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/modules/auth/authorization';
import { getVendorCreditById } from '@/modules/vendor-credits/vendor-credits-service';

export const runtime = 'nodejs';

export default async function VendorCreditDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('vendor_credits.view');
  const { id } = await params;
  const vendorCredit = await getVendorCreditById(id);
  if (!vendorCredit) notFound();

  return (
    <div className="app-content">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
        <Link href="/app/vendor-credits" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Volver a créditos de proveedor
        </Link>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{vendorCredit.vendorCreditNumber ?? '—'}</h1>
              <p className="text-sm text-muted-foreground">Crédito de Proveedor · {vendorCredit.vendorName ?? '—'}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
              {vendorCredit.status ?? '—'}
            </span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard label="Fecha" value={vendorCredit.date ? new Date(vendorCredit.date).toLocaleDateString() : '—'} />
          <DetailCard label="Proveedor" value={vendorCredit.vendorName ?? '—'} />
          <DetailCard label="Total" value={vendorCredit.total ?? '—'} />
          <DetailCard label="Saldo" value={vendorCredit.balance ?? '—'} />
          <DetailCard label="Moneda" value={vendorCredit.currencyCode ?? '—'} />
        </div>

        {vendorCredit.notes && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Notas</h2>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{vendorCredit.notes}</p>
          </div>
        )}

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Sincronización</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Última modificación remota" value={new Date(vendorCredit.sourceRemoteModifiedAt).toLocaleString()} />
            <DetailCard label="Última normalización" value={new Date(vendorCredit.normalizedAt).toLocaleString()} />
            <DetailCard label="ID Zoho" value={vendorCredit.zohoVendorCreditId} />
            <DetailCard label="ID Snapshot" value={vendorCredit.sourceSnapshotId} />
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

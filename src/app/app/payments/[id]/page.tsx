import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/modules/auth/authorization';
import { getPaymentById } from '@/modules/payments/payments-service';

export const runtime = 'nodejs';

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('payments.view');
  const { id } = await params;
  const payment = await getPaymentById(id);
  if (!payment) notFound();

  return (
    <div className="app-content">
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
        <Link href="/app/payments" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Volver a pagos
        </Link>

        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{payment.paymentNumber ?? '—'}</h1>
              <p className="text-sm text-muted-foreground">Pago · {payment.paymentMode ?? '—'}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
              {payment.status ?? '—'}
            </span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailCard label="Fecha" value={payment.date ? new Date(payment.date).toLocaleDateString() : '—'} />
          <DetailCard label="Cliente" value={payment.customerName ?? '—'} />
          <DetailCard label="Monto" value={payment.amount ?? '—'} />
          <DetailCard label="Saldo" value={payment.balance ?? '—'} />
          <DetailCard label="Moneda" value={payment.currencyCode ?? '—'} />
          <DetailCard label="Referencia" value={payment.referenceNumber ?? '—'} />
          <DetailCard label="Tipo de cambio" value={payment.exchangeRate ?? '—'} />
          <DetailCard label="Cargos bancarios" value={payment.bankCharges ?? '—'} />
        </div>

        {payment.description && (
          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Descripción</h2>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{payment.description}</p>
          </div>
        )}

        <div className="rounded-lg border bg-card p-6 space-y-3">
          <h2 className="text-lg font-semibold">Sincronización</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <DetailCard label="Última modificación remota" value={new Date(payment.sourceRemoteModifiedAt).toLocaleString()} />
            <DetailCard label="Última normalización" value={new Date(payment.normalizedAt).toLocaleString()} />
            <DetailCard label="ID Zoho" value={payment.zohoPaymentId} />
            <DetailCard label="ID Snapshot" value={payment.sourceSnapshotId} />
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

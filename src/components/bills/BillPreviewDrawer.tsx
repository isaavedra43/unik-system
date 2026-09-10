'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { BillDetail } from '@/modules/bills/bills-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getBillStatusConfig,
} from '@/modules/bills/bills-helpers';

interface BillPreviewDrawerProps {
  billId: string;
  basePath: string;
  entityLabel: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
  watchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  unwatchAction: (
    prevState: { error: string | null; success: boolean; isWatched: boolean },
    formData: FormData
  ) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
}

export function BillPreviewDrawer({
  billId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: BillPreviewDrawerProps) {
  const router = useRouter();
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(isWatched);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${basePath}/${billId}/api`)
      .then((res) => {
        if (!res.ok) throw new Error('No se pudo cargar la factura de compra');
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setBill(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Error');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [billId, basePath]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', billId);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      onWatchChange(!watched);
      toast.success(watched ? `Dejaste de seguir la ${entityLabel.toLowerCase()}` : `${entityLabel} seguida`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const statusConfig = bill ? getBillStatusConfig(bill.status) : null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Cerrar"
      />
      <div className="relative ml-auto h-full w-full max-w-md bg-background shadow-xl overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
          <h2 className="text-sm font-semibold truncate">{entityLabel}</h2>
          <div className="flex items-center gap-1">
            {canWatch && (
              <button
                onClick={handleWatch}
                className="inline-flex items-center justify-center rounded-md p-1.5 hover:bg-accent transition-colors"
                aria-label={watched ? 'Dejar de seguir' : 'Seguir'}
              >
                {watched ? <BellRing className="h-4 w-4 text-primary" /> : <Bell className="h-4 w-4" />}
              </button>
            )}
            <button
              onClick={() => router.push(`${basePath}/${billId}`)}
              className="inline-flex items-center justify-center rounded-md p-1.5 hover:bg-accent transition-colors"
              aria-label="Abrir página completa"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-md p-1.5 hover:bg-accent transition-colors"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {bill && !loading && (
            <>
              <div className="space-y-1">
                <h3 className="text-lg font-bold">{bill.billNumber ?? '—'}</h3>
                {bill.vendorName && (
                  <p className="text-sm text-muted-foreground">{bill.vendorName}</p>
                )}
                {statusConfig && (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      statusConfig.tone === 'success'
                        ? 'bg-success/10 text-success'
                        : statusConfig.tone === 'danger'
                          ? 'bg-destructive/10 text-destructive'
                          : statusConfig.tone === 'warning'
                            ? 'bg-warning/10 text-warning'
                            : statusConfig.tone === 'info'
                              ? 'bg-info/10 text-info'
                              : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        statusConfig.tone === 'success'
                          ? 'bg-success'
                          : statusConfig.tone === 'danger'
                            ? 'bg-destructive'
                            : statusConfig.tone === 'warning'
                              ? 'bg-warning'
                              : statusConfig.tone === 'info'
                                ? 'bg-info'
                                : 'bg-muted-foreground'
                      }`}
                    />
                    {statusConfig.label}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <PreviewField label="Fecha" value={bill.date ? formatDateOnly(bill.date) : '—'} />
                <PreviewField label="Vencimiento" value={bill.dueDate ? formatDateOnly(bill.dueDate) : '—'} />
                <PreviewField label="Proveedor" value={bill.vendorName ?? '—'} />
                <PreviewField label="Moneda" value={bill.currencyCode ?? '—'} />
                <PreviewField label="Total" value={formatCurrency(bill.total, bill.currencyCode)} />
                <PreviewField label="Saldo" value={formatCurrency(bill.balance, bill.currencyCode)} />
              </div>

              {bill.notes && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Notas</p>
                  <p className="text-sm whitespace-pre-wrap">{bill.notes}</p>
                </div>
              )}

              <div className="space-y-1 border-t pt-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Sincronización</p>
                <p className="text-xs text-muted-foreground">
                  Últ. modificación remota: {formatDateTime(bill.sourceRemoteModifiedAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Últ. normalización: {formatDateTime(bill.normalizedAt)}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium truncate">{value}</p>
    </div>
  );
}

'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { VendorCreditDetail } from '@/modules/vendor-credits/vendor-credits-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getVendorCreditStatusConfig,
} from '@/modules/vendor-credits/vendor-credits-helpers';

interface VendorCreditPreviewDrawerProps {
  vendorCreditId: string;
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

export function VendorCreditPreviewDrawer({
  vendorCreditId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: VendorCreditPreviewDrawerProps) {
  const router = useRouter();
  const [vendorCredit, setVendorCredit] = useState<VendorCreditDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(isWatched);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${basePath}/${vendorCreditId}/api`)
      .then((res) => {
        if (!res.ok) throw new Error('No se pudo cargar el crédito de proveedor');
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setVendorCredit(data);
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
  }, [vendorCreditId, basePath]);

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
    formData.set('entityId', vendorCreditId);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    if (result.success) {
      setWatched(!watched);
      onWatchChange(!watched);
      toast.success(watched ? `Dejaste de seguir el ${entityLabel.toLowerCase()}` : `${entityLabel} seguido`);
    } else {
      toast.error(result.error ?? 'Error');
    }
  };

  const statusConfig = vendorCredit ? getVendorCreditStatusConfig(vendorCredit.status) : null;

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
              onClick={() => router.push(`${basePath}/${vendorCreditId}`)}
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

          {vendorCredit && !loading && (
            <>
              <div className="space-y-1">
                <h3 className="text-lg font-bold">{vendorCredit.vendorCreditNumber ?? '—'}</h3>
                <p className="text-sm text-muted-foreground">{vendorCredit.vendorName ?? '—'}</p>
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
                <PreviewField label="Fecha" value={vendorCredit.date ? formatDateOnly(vendorCredit.date) : '—'} />
                <PreviewField label="Moneda" value={vendorCredit.currencyCode ?? '—'} />
                <PreviewField label="Total" value={formatCurrency(vendorCredit.total, vendorCredit.currencyCode)} />
                <PreviewField label="Saldo" value={formatCurrency(vendorCredit.balance, vendorCredit.currencyCode)} />
              </div>

              {vendorCredit.notes && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Notas</p>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{vendorCredit.notes}</p>
                </div>
              )}

              <div className="space-y-1 border-t pt-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Sincronización</p>
                <p className="text-xs text-muted-foreground">
                  Últ. modificación remota: {formatDateTime(vendorCredit.sourceRemoteModifiedAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Últ. normalización: {formatDateTime(vendorCredit.normalizedAt)}
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

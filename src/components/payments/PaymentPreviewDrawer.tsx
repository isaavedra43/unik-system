'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PaymentDetail } from '@/modules/payments/payments-contract';
import {
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  getPaymentStatusConfig,
  type PaymentStatusConfig,
} from '@/modules/payments/payments-helpers';
import type { WatchAction } from '@/modules/shared/entity-workspace-types';

interface PaymentPreviewDrawerProps {
  entityId: string;
  basePath: string;
  entityLabel: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
}

export function PaymentPreviewDrawer({
  entityId,
  basePath,
  entityLabel,
  onClose,
  canWatch,
  isWatched,
  onWatchChange,
  watchAction,
  unwatchAction,
}: PaymentPreviewDrawerProps) {
  const router = useRouter();
  const paymentId = entityId;
  const [payment, setPayment] = useState<PaymentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(isWatched);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${basePath}/${paymentId}/api`)
      .then((res) => {
        if (!res.ok) throw new Error('No se pudo cargar el pago');
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setPayment(data);
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
  }, [paymentId, basePath]);

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
    formData.set('entityId', paymentId);
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

  const statusConfig = payment ? getPaymentStatusConfig(payment.status) : null;

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
                {watched ? (
                  <BellRing className="h-4 w-4 text-primary" />
                ) : (
                  <Bell className="h-4 w-4" />
                )}
              </button>
            )}
            <button
              onClick={() => router.push(`${basePath}/${paymentId}`)}
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

          {payment && !loading && (
            <>
              <div className="space-y-1">
                <h3 className="text-lg font-bold">{payment.paymentNumber ?? '—'}</h3>
                {payment.paymentMode && (
                  <p className="text-sm text-muted-foreground">{payment.paymentMode}</p>
                )}
                {statusConfig && (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClasses(statusConfig.tone)}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDotClasses(statusConfig.tone)}`} />
                    {statusConfig.label}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <PreviewField label="Fecha" value={payment.date ? formatDateOnly(payment.date) : '—'} />
                <PreviewField label="Cliente" value={payment.customerName ?? '—'} />
                <PreviewField label="Modo de pago" value={payment.paymentMode ?? '—'} />
                <PreviewField label="Monto" value={formatCurrency(payment.amount, payment.currencyCode)} />
                <PreviewField label="Saldo" value={formatCurrency(payment.balance, payment.currencyCode)} />
                <PreviewField label="Moneda" value={payment.currencyCode ?? '—'} />
                <PreviewField label="Referencia" value={payment.referenceNumber ?? '—'} />
                <PreviewField label="Tipo de cambio" value={payment.exchangeRate ?? '—'} />
                <PreviewField label="Cargos bancarios" value={payment.bankCharges ?? '—'} />
              </div>

              {payment.description && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Descripción</p>
                  <p className="text-sm whitespace-pre-wrap">{payment.description}</p>
                </div>
              )}

              <div className="space-y-1 border-t pt-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Sincronización</p>
                <p className="text-xs text-muted-foreground">
                  Últ. modificación remota: {formatDateTime(payment.sourceRemoteModifiedAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Últ. normalización: {formatDateTime(payment.normalizedAt)}
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

function statusBadgeClasses(tone: PaymentStatusConfig['tone']): string {
  switch (tone) {
    case 'success':
      return 'bg-success/10 text-success';
    case 'danger':
      return 'bg-destructive/10 text-destructive';
    case 'warning':
      return 'bg-warning/10 text-warning';
    case 'info':
      return 'bg-info/10 text-info';
    case 'muted':
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function statusDotClasses(tone: PaymentStatusConfig['tone']): string {
  switch (tone) {
    case 'success':
      return 'bg-success';
    case 'danger':
      return 'bg-destructive';
    case 'warning':
      return 'bg-warning';
    case 'info':
      return 'bg-info';
    case 'muted':
    default:
      return 'bg-muted-foreground';
  }
}

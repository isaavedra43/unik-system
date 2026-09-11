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
    setWatched(isWatched);
  }, [isWatched]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${basePath}/${paymentId}/api`);
        if (!res.ok) throw new Error('No se pudo cargar el pago');
        const json = (await res.json()) as PaymentDetail & { is_watched?: boolean };
        if (!cancelled) {
          setPayment(json);
          if (typeof json.is_watched === 'boolean') setWatched(json.is_watched);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [paymentId, basePath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <aside
        className="so-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Detalle de ${entityLabel.toLowerCase()}`}
      >
        <div className="so-detail-header">
          <div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
              {payment?.paymentNumber ?? 'Cargando...'}
            </h2>
            {payment?.customerName ? (
              <p style={{ color: 'var(--unik-text-muted)', fontSize: '0.875rem', margin: '4px 0 0' }}>
                {payment.customerName}
              </p>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {canWatch ? (
              <button className="btn btn-secondary btn-sm" onClick={handleWatch} aria-pressed={watched}>
                {watched ? <BellRing size={14} /> : <Bell size={14} />}
                {watched ? 'Siguiendo' : 'Seguir'}
              </button>
            ) : null}
            <button className="btn btn-secondary btn-sm" onClick={() => router.push(`${basePath}/${paymentId}`)}>
              <ExternalLink size={14} /> Abrir
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="so-detail-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <span className="spinner" /> Cargando...
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <p className="text-muted">{error}</p>
            </div>
          ) : payment ? (
            <>
              {/* Summary */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  padding: '0.75rem 1rem',
                  background: 'var(--unik-surface)',
                  borderRadius: 'var(--unik-radius-sm)',
                  border: '1px solid var(--unik-border-subtle)',
                  marginBottom: '1rem',
                }}
              >
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                    Monto
                  </div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                    {formatCurrency(payment.amount, payment.currencyCode)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                    Saldo
                  </div>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                    {formatCurrency(payment.balance, payment.currencyCode)}
                  </div>
                </div>
              </div>

              {/* Status strip */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Estado</h3>
                <div className="so-status-strip">
                  <StatusTile
                    label="Pago"
                    value={statusConfig?.label ?? '—'}
                    tone={statusConfig?.tone ?? 'muted'}
                  />
                </div>
              </div>

              {/* General */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <Field label="Fecha" value={formatDateOnly(payment.date)} />
                  <Field label="Cliente" value={payment.customerName} />
                  <Field label="Modo de pago" value={payment.paymentMode} />
                  <Field label="Referencia" value={payment.referenceNumber} />
                  <Field label="Moneda" value={payment.currencyCode} />
                  <Field label="Tipo de cambio" value={payment.exchangeRate} />
                  <Field label="Cargos bancarios" value={payment.bankCharges ? formatCurrency(payment.bankCharges, payment.currencyCode) : null} />
                </div>
              </div>

              {/* Totales */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Totales</h3>
                <div className="so-detail-grid">
                  <Field label="Monto" value={formatCurrency(payment.amount, payment.currencyCode)} highlighted />
                  <Field label="Saldo" value={formatCurrency(payment.balance, payment.currencyCode)} highlighted />
                </div>
              </div>

              {/* Descripción */}
              {payment.description ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Descripción</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>
                    {payment.description}
                  </p>
                </div>
              ) : null}

              {/* Sync */}
              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Sincronización</h3>
                <div className="so-detail-grid">
                  <Field label="Últ. modificación remota" value={formatDateTime(payment.sourceRemoteModifiedAt)} />
                  <Field label="Normalizado" value={formatDateTime(payment.normalizedAt)} />
                </div>
              </div>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function Field({
  label,
  value,
  highlighted,
}: {
  label: string;
  value: string | null;
  highlighted?: boolean;
}) {
  return (
    <div className="so-detail-field">
      <span className="so-detail-field-label">{label}</span>
      <span className="so-detail-field-value" style={highlighted ? { fontWeight: 700 } : undefined}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function StatusTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'muted';
}) {
  return (
    <div className="so-status-tile" title={`${label}: ${value}`}>
      <span className={`so-status-dot so-status-dot-${tone}`} />
      <div>
        <div className="so-status-tile-label">{label}</div>
        <div className="so-status-tile-value">{value}</div>
      </div>
    </div>
  );
}

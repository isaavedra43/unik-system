'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, BellRing, ExternalLink, FileDown, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import type { QuoteDetail } from '@/modules/quotes/quotes-contract';
import {
  formatCurrency, formatDateOnly, formatDateTime, getQuoteStatusConfig, getQuoteExpiryInfo, isQuoteEditable,
} from '@/modules/quotes/quotes-helpers';

interface QuotePreviewDrawerProps {
  quoteId: string;
  basePath: string;
  entityLabel: string;
  onClose: () => void;
  canWatch: boolean;
  isWatched: boolean;
  onWatchChange: (watched: boolean) => void;
  watchAction: (prevState: { error: string | null; success: boolean; isWatched: boolean }, formData: FormData) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  unwatchAction: (prevState: { error: string | null; success: boolean; isWatched: boolean }, formData: FormData) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
}

export function QuotePreviewDrawer({
  quoteId, basePath, entityLabel, onClose, canWatch, isWatched, onWatchChange, watchAction, unwatchAction,
}: QuotePreviewDrawerProps) {
  const router = useRouter();
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(isWatched);

  useEffect(() => { setWatched(isWatched); }, [isWatched]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      try {
        const res = await fetch(`${basePath}/${quoteId}/api`);
        if (!res.ok) throw new Error('No se pudo cargar la cotización');
        const json = (await res.json()) as QuoteDetail & { is_watched?: boolean };
        if (!cancelled) {
          setQuote(json);
          if (typeof json.is_watched === 'boolean') setWatched(json.is_watched);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [quoteId, basePath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleWatch = async () => {
    if (!canWatch) return;
    const formData = new FormData();
    formData.set('entityId', quoteId);
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

  const statusConfig = quote ? getQuoteStatusConfig(quote.status) : null;
  const expiry = quote ? getQuoteExpiryInfo(quote.expiryDate, quote.status) : null;
  const hasBilling = quote && Boolean(quote.billingAddress || quote.billingCity || quote.billingState || quote.billingZip || quote.billingCountry);

  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <aside className="so-detail-drawer" role="dialog" aria-modal="true" aria-label={`Detalle de ${entityLabel.toLowerCase()}`}>
        <div className="so-detail-header">
          <div>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>{quote?.estimateNumber ?? 'Cargando...'}</h2>
            {quote?.customerName ? (
              <p style={{ color: 'var(--unik-text-muted)', fontSize: '0.875rem', margin: '4px 0 0' }}>{quote.customerName}</p>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {canWatch ? (
              <button className="btn btn-secondary btn-sm" onClick={handleWatch} aria-pressed={watched}>
                {watched ? <BellRing size={14} /> : <Bell size={14} />}
                {watched ? 'Siguiendo' : 'Seguir'}
              </button>
            ) : null}
            {quote ? (
              <a className="btn btn-secondary btn-sm" href={`${basePath}/${quoteId}/pdf`} target="_blank" rel="noopener noreferrer" title="PDF oficial de Zoho">
                <FileDown size={14} /> PDF
              </a>
            ) : null}
            {quote && isQuoteEditable(quote.status) ? (
              <button className="btn btn-secondary btn-sm" onClick={() => router.push(`${basePath}/${quoteId}/edit`)}>
                <Pencil size={14} /> Editar
              </button>
            ) : null}
            <button className="btn btn-secondary btn-sm" onClick={() => router.push(`${basePath}/${quoteId}`)}>
              <ExternalLink size={14} /> Abrir
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
          </div>
        </div>

        <div className="so-detail-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}><span className="spinner" /> Cargando...</div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}><p className="text-muted">{error}</p></div>
          ) : quote ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', padding: '0.75rem 1rem', background: 'var(--unik-surface)', borderRadius: 'var(--unik-radius-sm)', border: '1px solid var(--unik-border-subtle)', marginBottom: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>Total</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{formatCurrency(quote.total, quote.currencyCode)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>Vencimiento</div>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>{formatDateOnly(quote.expiryDate)}</div>
                  {expiry ? <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)' }}>{expiry.label}</div> : null}
                </div>
              </div>

              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Estado</h3>
                <div className="so-status-strip">
                  <StatusTile label="Cotización" value={statusConfig?.label ?? '—'} tone={statusConfig?.tone ?? 'muted'} />
                  <StatusTile label="Origen" value={quote.createdInUnik ? 'Creada en UNIK' : 'Creada en Zoho'} tone={quote.createdInUnik ? 'info' : 'muted'} />
                  {quote.isViewedByClient ? <StatusTile label="Cliente" value="Vista por el cliente" tone="info" /> : null}
                </div>
              </div>

              <div className="so-detail-section">
                <h3 className="so-detail-section-title">General</h3>
                <div className="so-detail-grid">
                  <Field label="Fecha" value={formatDateOnly(quote.date)} />
                  <Field label="Vence" value={formatDateOnly(quote.expiryDate)} />
                  <Field label="Vendedor" value={quote.salespersonName} />
                  <Field label="Referencia" value={quote.referenceNumber} />
                  <Field label="Moneda" value={quote.currencyCode} />
                  <Field label="Plantilla PDF" value={quote.templateName} />
                </div>
              </div>

              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Cliente</h3>
                <div className="so-detail-grid">
                  <Field label="Nombre" value={quote.customerName} />
                  {quote.relatedContact ? <Field label="Empresa" value={quote.relatedContact.companyName} /> : null}
                </div>
                {quote.relatedContact?.id ? (
                  <Link href={`/app/contacts/customers/${quote.relatedContact.id}`} style={{ fontSize: '0.875rem', color: 'var(--unik-accent)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.5rem' }}>
                    <ExternalLink size={12} /> Ver cliente
                  </Link>
                ) : null}
              </div>

              {hasBilling ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Dirección de facturación</h3>
                  <div className="so-detail-grid">
                    <Field label="Dirección" value={[quote.billingAddress, quote.billingStreet2].filter(Boolean).join(', ') || null} />
                    <Field label="Ciudad" value={quote.billingCity} />
                    <Field label="Estado" value={quote.billingState} />
                    <Field label="Código postal" value={quote.billingZip} />
                    <Field label="País" value={quote.billingCountry} />
                  </div>
                </div>
              ) : null}

              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Totales</h3>
                <div className="so-detail-grid">
                  <Field label="Subtotal" value={formatCurrency(quote.subTotal, quote.currencyCode)} />
                  <Field label="Descuento" value={formatCurrency(quote.discountTotal ?? quote.discount, quote.currencyCode)} />
                  <Field label="Impuestos" value={formatCurrency(quote.taxTotal, quote.currencyCode)} />
                  <Field label="Envío" value={formatCurrency(quote.shippingCharge, quote.currencyCode)} />
                  <Field label="Ajuste" value={formatCurrency(quote.adjustment, quote.currencyCode)} />
                  <Field label="Total" value={formatCurrency(quote.total, quote.currencyCode)} highlighted />
                </div>
              </div>

              {quote.items.length > 0 ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Conceptos ({quote.items.length})</h3>
                  <div className="table-wrap">
                    <table className="table so-table-compact">
                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th style={{ textAlign: 'right' }}>Cantidad</th>
                          <th style={{ textAlign: 'right' }}>Precio</th>
                          <th style={{ textAlign: 'right' }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {quote.items.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <div>{item.name ?? '—'}</div>
                              {item.sku ? <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)' }}>SKU {item.sku}</div> : null}
                              {item.description ? <div style={{ fontSize: '0.75rem', color: 'var(--unik-text-muted)' }}>{item.description}</div> : null}
                            </td>
                            <td style={{ textAlign: 'right' }}>{item.quantity ?? '—'} {item.unit ?? ''}</td>
                            <td style={{ textAlign: 'right' }}>{formatCurrency(item.rate, quote.currencyCode)}</td>
                            <td style={{ textAlign: 'right' }}>{formatCurrency(item.lineTotal, quote.currencyCode)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {quote.notes ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Notas</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>{quote.notes}</p>
                </div>
              ) : null}

              {quote.terms ? (
                <div className="so-detail-section">
                  <h3 className="so-detail-section-title">Términos</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--unik-text-secondary)', whiteSpace: 'pre-wrap' }}>{quote.terms}</p>
                </div>
              ) : null}

              <div className="so-detail-section">
                <h3 className="so-detail-section-title">Sincronización</h3>
                <div className="so-detail-grid">
                  <Field label="Últ. modificación en Zoho" value={formatDateTime(quote.zohoLastModifiedTime ?? quote.sourceRemoteModifiedAt)} />
                  <Field label="Normalizado" value={formatDateTime(quote.normalizedAt)} />
                  <Field label="ID Zoho" value={quote.zohoEstimateId} />
                </div>
              </div>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function Field({ label, value, highlighted }: { label: string; value: string | null; highlighted?: boolean }) {
  return (
    <div className="so-detail-field">
      <span className="so-detail-field-label">{label}</span>
      <span className="so-detail-field-value" style={highlighted ? { fontWeight: 700 } : undefined}>{value ?? '—'}</span>
    </div>
  );
}

function StatusTile({ label, value, tone }: { label: string; value: string; tone: 'success' | 'info' | 'warning' | 'danger' | 'muted' }) {
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

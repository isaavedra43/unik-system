'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import type { StatusCount, VendorTransactionRow, VendorTransactionType } from '@/modules/contacts/vendor-profile-service';
import { DocumentTable, TYPE_LABELS, statusConfigFor } from './vendor-ui';

const LIST_PATH: Record<VendorTransactionType, string> = {
  purchase_orders: '/app/purchase-orders',
  bills: '/app/bills',
  vendor_credits: '/app/vendor-credits',
};

interface PageResponse {
  rows: VendorTransactionRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Full, paginated history of one document type, filterable by status. */
export function VendorTransactionsTable({
  contactId,
  vendorName,
  type,
  total,
  statuses,
}: {
  contactId: string;
  vendorName: string;
  type: VendorTransactionType;
  total: number;
  statuses: StatusCount[];
}) {
  const [status, setStatus] = useState<string>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
  }, [status, type]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ type, page: String(page), pageSize: '25' });
    if (status) params.set('status', status);
    fetch(`/app/contacts/vendors/${contactId}/transactions?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `Error ${res.status}`);
        return json as PageResponse;
      })
      .then((json) => !cancelled && setData(json))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Error'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [contactId, type, page, status]);

  const shownTotal = data?.total ?? (status ? 0 : total);
  const pageSize = data?.pageSize ?? 25;
  const from = shownTotal === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, shownTotal);
  const lastPage = Math.max(1, Math.ceil(shownTotal / pageSize));

  return (
    <section className="vd-card" aria-label={TYPE_LABELS[type].plural}>
      <div className="vd-card-head">
        <div>
          <h2 className="vd-card-title">{TYPE_LABELS[type].plural}</h2>
          <p className="vd-card-sub">
            {total.toLocaleString('es-MX')} en total · ligadas por el ID de proveedor de Zoho
          </p>
        </div>
        <Link href={`${LIST_PATH[type]}?search=${encodeURIComponent(vendorName)}`} className="btn btn-secondary btn-sm">
          Abrir en el módulo <ExternalLink size={13} aria-hidden="true" />
        </Link>
      </div>

      {statuses.length > 1 ? (
        <div className="vd-chips" role="group" aria-label="Filtrar por estado">
          <button type="button" className="vd-chip" aria-pressed={status === ''} onClick={() => setStatus('')}>
            Todos <span>{total.toLocaleString('es-MX')}</span>
          </button>
          {statuses.map((s) => (
            <button
              key={s.status ?? 'none'}
              type="button"
              className="vd-chip"
              aria-pressed={status === (s.status ?? '')}
              onClick={() => setStatus(s.status ?? '')}
              disabled={!s.status}
            >
              {statusConfigFor(type, s.status).label} <span>{s.count.toLocaleString('es-MX')}</span>
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="vd-alert vd-alert-danger" role="alert">
          <AlertTriangle size={15} aria-hidden="true" /> {error}
        </div>
      ) : loading && !data ? (
        <div className="vd-loading">
          <Loader2 size={18} className="vd-spin" aria-hidden="true" /> Cargando historial…
        </div>
      ) : (
        <div className={loading ? 'vd-dim' : undefined} aria-busy={loading}>
          <DocumentTable type={type} rows={data?.rows ?? []} emptyText="No hay documentos con ese estado." />
        </div>
      )}

      <div className="vd-pager">
        <span className="vd-muted">
          {from.toLocaleString('es-MX')}–{to.toLocaleString('es-MX')} de {shownTotal.toLocaleString('es-MX')}
        </span>
        <div className="vd-pager-buttons">
          <button type="button" className="icon-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} aria-label="Página anterior">
            <ChevronLeft size={16} />
          </button>
          <span className="vd-muted">
            Página {page} de {lastPage}
          </span>
          <button type="button" className="icon-btn" onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage || loading} aria-label="Página siguiente">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}

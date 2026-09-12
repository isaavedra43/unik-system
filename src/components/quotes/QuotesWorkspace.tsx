'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileSignature,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { getFileAccessUrl } from '@/lib/upload-client';
import { Modal } from '@/components/ui/composite';
import { QuoteItemsEditor } from './QuoteItemsEditor';
import { QuoteScenarioSimulator } from './QuoteScenarioSimulator';
import { QuoteApprovalDialog } from './QuoteApprovalDialog';
import {
  api,
  emptyItem,
  money,
  QUOTE_STATUS_LABEL,
  type QuoteDTO,
  type QuoteItem,
} from './quotes-client';

interface ListResponse {
  quotes: QuoteDTO[];
  booksMode: { mock: boolean; reason: string };
  canApprove: boolean;
}

interface Draft {
  customerName: string;
  zohoCustomerId: string;
  currency: string;
  notes: string;
  items: QuoteItem[];
}

const NEW_ID = '__new__';

function draftFrom(quote: QuoteDTO | null): Draft {
  return {
    customerName: quote?.customerName ?? '',
    zohoCustomerId: quote?.zohoCustomerId ?? '',
    currency: quote?.currency ?? 'MXN',
    notes: quote?.notes ?? '',
    items: quote?.items.length ? quote.items.map((i) => ({ ...i })) : [emptyItem()],
  };
}

export function QuotesWorkspace({
  canApprove,
  currentUserId,
}: {
  canApprove: boolean;
  currentUserId: string;
}) {
  const [quotes, setQuotes] = useState<QuoteDTO[]>([]);
  const [booksMode, setBooksMode] = useState<{ mock: boolean; reason: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [busy, setBusy] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showSimulator, setShowSimulator] = useState(false);

  const selected = useMemo(
    () => quotes.find((q) => q.id === selectedId) ?? null,
    [quotes, selectedId]
  );
  const isNew = selectedId === NEW_ID;
  const editable =
    isNew || (selected !== null && selected.status !== 'synced' && selected.status !== 'sent');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
      const data = await api<ListResponse>(`/app/quotes/api/quotes${params}`);
      setQuotes(data.quotes);
      setBooksMode(data.booksMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las cotizaciones');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isNew) setDraft(draftFrom(selected));
  }, [selected, isNew]);

  const upsertQuote = (quote: QuoteDTO) => {
    setQuotes((prev) => {
      const exists = prev.some((q) => q.id === quote.id);
      return exists ? prev.map((q) => (q.id === quote.id ? quote : q)) : [quote, ...prev];
    });
    setSelectedId(quote.id);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado');
    } finally {
      setBusy(false);
    }
  };

  const payload = () => ({
    customerName: draft.customerName.trim(),
    zohoCustomerId: draft.zohoCustomerId.trim() || undefined,
    currency: draft.currency.trim().toUpperCase(),
    notes: draft.notes.trim() || undefined,
    items: draft.items.map((i) => ({
      ...i,
      sku: i.sku?.trim() || undefined,
      description: i.description?.trim() || undefined,
    })),
  });

  const save = () =>
    run(async () => {
      if (isNew) {
        const { quote } = await api<{ quote: QuoteDTO }>('/app/quotes/api/quotes', {
          method: 'POST',
          body: JSON.stringify(payload()),
        });
        upsertQuote(quote);
        setNotice('Borrador creado');
      } else if (selected) {
        const { quote } = await api<{ quote: QuoteDTO }>(`/app/quotes/api/quotes/${selected.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload()),
        });
        upsertQuote(quote);
        setNotice(
          quote.invalidationReason === 'Contenido modificado'
            ? 'Guardado. La aprobación anterior quedó invalidada (nueva versión).'
            : `Guardado (versión ${quote.version})`
        );
      }
    });

  const action = (path: string, body?: unknown, done?: (data: Record<string, unknown>) => void) =>
    run(async () => {
      if (!selected) return;
      const data = await api<Record<string, unknown>>(
        `/app/quotes/api/quotes/${selected.id}/${path}`,
        { method: 'POST', body: JSON.stringify(body ?? {}) }
      );
      if (data.quote) upsertQuote(data.quote as QuoteDTO);
      done?.(data);
    });

  const downloadPackage = () =>
    action('package', undefined, async (data) => {
      const documentId = data.documentId as string;
      setNotice(`Paquete comercial generado (${data.pageCount as number} páginas).`);
      const access = await getFileAccessUrl(documentId, 'attachment');
      window.open(access.url, '_blank', 'noopener');
      await load();
    });

  const approve = (expectedContentHash: string) =>
    action('approve', { expectedContentHash }, (data) => {
      setApprovalOpen(false);
      const books = data.books as {
        mock: boolean;
        estimateNumber: string;
        url: string | null;
      } | null;
      if (data.uncertain) {
        setNotice(
          'Resultado incierto: verifica en Zoho Books antes de reintentar. La cotización sigue pendiente con nota.'
        );
      } else if (books) {
        setNotice(
          books.mock
            ? `Creada en modo SIMULADO (${books.estimateNumber}). No existe en Books real.`
            : `Creada en Zoho Books: ${books.estimateNumber}`
        );
      }
    });

  const statusInfo = (status: string) =>
    QUOTE_STATUS_LABEL[status] ?? { label: status, badge: 'badge-weak' };

  return (
    <div className="assistant-admin-panel" style={{ display: 'grid', gap: '1rem' }}>
      {booksMode ? (
        <div className={`alert ${booksMode.mock ? 'alert-warning' : 'alert-info'}`} role="status">
          Zoho Books: <strong>{booksMode.mock ? 'modo simulado (mock)' : 'modo real'}</strong> ·{' '}
          {booksMode.reason}
          {booksMode.mock ? ' — una cotización "oficial" en este modo NO existe en Books.' : ''}
        </div>
      ) : null}
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert-success" role="status">
          {notice}
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(16rem, 1fr) minmax(0, 2.2fr)',
          gap: '1rem',
          alignItems: 'start',
        }}
        className="quotes-layout"
      >
        <section className="card" aria-label="Lista de cotizaciones">
          <div
            className="assistant-admin-filters"
            style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
          >
            <select
              className="assistant-admin-select"
              value={statusFilter}
              aria-label="Filtrar por estado"
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">Todos los estados</option>
              {Object.entries(QUOTE_STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Recargar"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw size={16} />
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setSelectedId(NEW_ID);
                setDraft(draftFrom(null));
                setShowSimulator(false);
              }}
            >
              <Plus size={16} /> Nueva
            </button>
          </div>
          {loading ? <div className="assistant-admin-loading">Cargando…</div> : null}
          {!loading && quotes.length === 0 ? (
            <div className="empty-state">
              <FileSignature size={32} aria-hidden="true" />
              <h3 className="empty-state-title">Sin cotizaciones</h3>
              <p>Crea la primera con “Nueva” o pídesela al asistente.</p>
            </div>
          ) : null}
          {quotes.length > 0 ? (
            <div className="table-wrap">
              <table className="assistant-admin-table">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Estado</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.map((q) => (
                    <tr
                      key={q.id}
                      className="assistant-admin-row-clickable"
                      onClick={() => {
                        setSelectedId(q.id);
                        setShowSimulator(false);
                      }}
                      aria-selected={q.id === selectedId}
                      style={q.id === selectedId ? { fontWeight: 600 } : undefined}
                    >
                      <td>
                        {q.customerName}
                        <div className="assistant-admin-muted" style={{ fontSize: '0.8em' }}>
                          {q.number ?? q.id.slice(-8)} · v{q.version}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${statusInfo(q.status).badge}`}>
                          {statusInfo(q.status).label}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {money(q.total, q.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="card" aria-label="Detalle de cotización">
          {!selected && !isNew ? (
            <div className="empty-state">
              <h3 className="empty-state-title">Selecciona una cotización</h3>
              <p>O crea una nueva para empezar.</p>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              style={{ display: 'grid', gap: '0.75rem' }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <h2 style={{ margin: 0 }}>
                  {isNew
                    ? 'Nueva cotización'
                    : `Cotización ${selected?.number ?? selected?.id.slice(-8)}`}
                </h2>
                {selected ? (
                  <div
                    style={{
                      display: 'flex',
                      gap: '0.5rem',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span className={`badge ${statusInfo(selected.status).badge}`}>
                      {statusInfo(selected.status).label}
                    </span>
                    {selected.zohoEstimateId ? (
                      <span
                        className={`badge ${selected.zohoEstimateId.startsWith('mock-') ? 'badge-warning' : 'badge-success'}`}
                      >
                        {selected.zohoEstimateId.startsWith('mock-')
                          ? 'Books simulado'
                          : 'Books real'}{' '}
                        · {selected.zohoEstimateId}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {selected?.invalidationReason ? (
                <div
                  className={`alert ${selected.invalidationReason.startsWith('Pendiente de revisión') ? 'alert-warning' : 'alert-info'}`}
                  role="status"
                >
                  <AlertTriangle size={16} /> {selected.invalidationReason}
                </div>
              ) : null}
              {selected &&
              (selected.status === 'pending_approval' || selected.status === 'approved') &&
              editable ? (
                <div className="alert alert-info" role="status">
                  Editar esta cotización creará una nueva versión e invalidará la aprobación
                  pendiente.
                </div>
              ) : null}

              <div className="form-grid">
                <label className="form-field">
                  <span>Cliente</span>
                  <input
                    className="assistant-admin-filter-input"
                    value={draft.customerName}
                    required
                    disabled={!editable || busy}
                    onChange={(e) => setDraft({ ...draft, customerName: e.target.value })}
                  />
                </label>
                <label className="form-field">
                  <span>Id de cliente en Zoho (opcional)</span>
                  <input
                    className="assistant-admin-filter-input"
                    value={draft.zohoCustomerId}
                    disabled={!editable || busy}
                    onChange={(e) => setDraft({ ...draft, zohoCustomerId: e.target.value })}
                  />
                </label>
                <label className="form-field">
                  <span>Moneda</span>
                  <input
                    className="assistant-admin-filter-input"
                    value={draft.currency}
                    maxLength={3}
                    disabled={!editable || busy}
                    onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
                  />
                </label>
              </div>
              <QuoteItemsEditor
                items={draft.items}
                currency={draft.currency || 'MXN'}
                disabled={!editable || busy}
                onChange={(items) => setDraft({ ...draft, items })}
              />
              <label className="form-field">
                <span>Notas</span>
                <textarea
                  className="assistant-admin-filter-input"
                  rows={2}
                  value={draft.notes}
                  disabled={!editable || busy}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
              </label>
              {selected ? (
                <div className="assistant-admin-muted" style={{ fontSize: '0.85em' }}>
                  Totales del servidor: {money(selected.subtotal, selected.currency)} +{' '}
                  {money(selected.tax, selected.currency)} ={' '}
                  <strong>{money(selected.total, selected.currency)}</strong> · hash{' '}
                  {selected.contentHash?.slice(0, 12)}…
                  {selected.createdBy === currentUserId ? ' · creada por ti' : ''}
                </div>
              ) : null}

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {editable ? (
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={
                      busy ||
                      !draft.customerName.trim() ||
                      draft.items.length === 0 ||
                      draft.items.some((i) => !i.name.trim())
                    }
                  >
                    <Save size={16} /> {isNew ? 'Crear borrador' : 'Guardar'}
                  </button>
                ) : null}
                {selected && (selected.status === 'draft' || selected.status === 'rejected') ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() =>
                      action('request-approval', undefined, () =>
                        setNotice('Solicitud de aprobación enviada')
                      )
                    }
                  >
                    <Send size={16} /> Solicitar aprobación
                  </button>
                ) : null}
                {selected ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={downloadPackage}
                  >
                    <Download size={16} /> Paquete comercial (PDF)
                  </button>
                ) : null}
                {selected ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => setShowSimulator((v) => !v)}
                  >
                    {showSimulator ? 'Ocultar simulador' : 'Simular escenarios'}
                  </button>
                ) : null}
                {selected &&
                canApprove &&
                (selected.status === 'pending_approval' || selected.status === 'approved') ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => setApprovalOpen(true)}
                    >
                      <ShieldCheck size={16} /> Aprobar y crear en Books
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy}
                      onClick={() => setRejectOpen(true)}
                    >
                      <XCircle size={16} /> Rechazar
                    </button>
                  </>
                ) : null}
              </div>
            </form>
          )}
          {selected && showSimulator ? (
            <div style={{ marginTop: '1rem' }}>
              <QuoteScenarioSimulator quoteId={selected.id} />
            </div>
          ) : null}
        </section>
      </div>

      {selected && booksMode ? (
        <QuoteApprovalDialog
          quote={selected}
          mock={booksMode.mock}
          open={approvalOpen}
          busy={busy}
          onClose={() => setApprovalOpen(false)}
          onConfirm={approve}
        />
      ) : null}
      {selected ? (
        <Modal
          open={rejectOpen}
          onClose={() => setRejectOpen(false)}
          title="Rechazar cotización"
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setRejectOpen(false)}
                disabled={busy}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() =>
                  action('reject', { reason: rejectReason }, () => {
                    setRejectOpen(false);
                    setRejectReason('');
                    setNotice('Cotización rechazada');
                  })
                }
              >
                Rechazar
              </button>
            </>
          }
        >
          <label className="form-field">
            <span>Motivo</span>
            <textarea
              className="assistant-admin-filter-input"
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </label>
        </Modal>
      ) : null}
      <style>{`@media (max-width: 900px) { .quotes-layout { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

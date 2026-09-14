'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, FileSpreadsheet, FileText, Info, Loader2, Printer, RefreshCw } from 'lucide-react';
import { formatCurrency, formatDateOnly, formatDateTime } from '@/modules/contacts/contacts-helpers';
import type { StatementSyncDiagnostics } from '@/modules/contacts/vendor-statement-service';
import { presetRange, type StatementPreset, type StatementShow, type VendorStatement as Statement } from '@/modules/contacts/vendor-statement';
import { toast } from 'sonner';
import { StatusPill } from './vendor-ui';

const PRESETS: Array<{ id: StatementPreset; label: string }> = [
  { id: 'all', label: 'Todo el historial' },
  { id: 'this_month', label: 'Este mes' },
  { id: 'last_month', label: 'Mes pasado' },
  { id: 'last_90_days', label: 'Últimos 90 días' },
  { id: 'this_year', label: 'Este año' },
  { id: 'custom', label: 'Personalizado' },
];

const SHOW_OPTIONS: Array<{ id: StatementShow; label: string }> = [
  { id: 'all', label: 'Todo' },
  { id: 'bills', label: 'Solo facturas' },
  { id: 'credits', label: 'Solo créditos' },
];

type StatementResponse = Statement & { company: { name: string; phone: string | null; address: string | null }; sync: StatementSyncDiagnostics | null };

interface VendorStatementProps {
  contactId: string;
  vendorName: string;
  vendorRfc: string | null;
  currencyCode: string | null;
}

/**
 * Statement tab, laid out like Zoho's: company header, "Para", account summary and the ledger
 * (opening balance + bills − credits with a running balance). Default is the whole history;
 * a period lists only its documents with the balance carried in from before.
 */
export function VendorStatement({ contactId, vendorName, vendorRfc, currencyCode }: VendorStatementProps) {
  const [preset, setPreset] = useState<StatementPreset>('all');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [show, setShow] = useState<StatementShow>('all');
  const [data, setData] = useState<StatementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const range = useMemo(() => (preset === 'custom' ? { from: custom.from || null, to: custom.to || null } : presetRange(preset)), [preset, custom]);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    if (show !== 'all') p.set('show', show);
    return p.toString();
  }, [range, show]);

  useEffect(() => {
    if (preset === 'custom' && !custom.from && !custom.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/app/contacts/vendors/${contactId}/statement${query ? `?${query}` : ''}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `Error ${res.status}`);
        return json as StatementResponse;
      })
      .then((json) => !cancelled && setData(json))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Error'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [contactId, query, preset, custom.from, custom.to, reloadKey]);

  /** Pull the latest bills and credits from Zoho, then recompute. */
  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const results = await Promise.all(
        ['/app/bills/sync', '/app/vendor-credits/sync'].map((url) => fetch(url, { method: 'POST' }).then((r) => r.ok || r.status === 202 || r.status === 409))
      );
      if (results.every(Boolean)) toast.success('Sincronización iniciada; el estado de cuenta se actualizó con lo ya descargado.');
      else toast.error('No se pudo iniciar la sincronización de facturas o créditos.');
    } catch {
      toast.error('No se pudo iniciar la sincronización.');
    } finally {
      setSyncing(false);
      setReloadKey((k) => k + 1);
    }
  }, []);

  const syncNotes = useMemo(() => {
    const sync = data?.sync;
    if (!sync) return [] as string[];
    const notes: string[] = [];
    if (sync.bills.pendingSnapshots > 0) notes.push(`${sync.bills.pendingSnapshots} factura(s) descargadas de Zoho aún sin procesar`);
    if (sync.vendorCredits.pendingSnapshots > 0) notes.push(`${sync.vendorCredits.pendingSnapshots} crédito(s) descargados de Zoho aún sin procesar`);
    if (sync.bills.failedSnapshots > 0) notes.push(`${sync.bills.failedSnapshots} factura(s) no se pudieron procesar`);
    if (sync.vendorCredits.failedSnapshots > 0) notes.push(`${sync.vendorCredits.failedSnapshots} crédito(s) no se pudieron procesar`);
    if (sync.unlinkedBills > 0) notes.push(`${sync.unlinkedBills} factura(s) con este nombre están ligadas a otro proveedor en Zoho`);
    if (sync.unlinkedCredits > 0) notes.push(`${sync.unlinkedCredits} crédito(s) con este nombre están ligados a otro proveedor en Zoho`);
    if (sync.bills.lastStatus && sync.bills.lastStatus !== 'completed') notes.push(`la última sincronización de facturas terminó en "${sync.bills.lastStatus}"`);
    return notes;
  }, [data?.sync]);

  const money = (n: number) => formatCurrency(n, currencyCode);
  const download = (format: 'pdf' | 'xlsx' | 'csv') => `/app/contacts/vendors/${contactId}/statement?${query ? `${query}&` : ''}format=${format}`;
  const periodLabel = data
    ? data.from || data.to
      ? `Del ${data.from ? formatDateOnly(data.from) : 'inicio'} al ${data.to ? formatDateOnly(data.to) : formatDateOnly(new Date())}`
      : `Todo el historial${data.firstDocumentDate ? ` · desde ${formatDateOnly(data.firstDocumentDate)}` : ''}`
    : '';

  return (
    <section className="vd-card" aria-label="Estado de cuenta">
      <div className="vd-statement-toolbar">
        <div className="vd-statement-filters">
          <div className="vd-chips" role="group" aria-label="Periodo">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className="vd-chip" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'custom' ? (
            <div className="vd-range">
              <label>
                Desde
                <input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
              </label>
              <label>
                Hasta
                <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
              </label>
              {!custom.from && !custom.to ? <span className="vd-muted">Elige al menos una fecha.</span> : null}
            </div>
          ) : null}
          <label className="vd-inline-select">
            Mostrar
            <select value={show} onChange={(e) => setShow(e.target.value as StatementShow)}>
              {SHOW_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="vd-statement-actions">
          <a className="btn btn-secondary btn-sm" href={download('pdf')}>
            <FileText size={13} aria-hidden="true" /> PDF
          </a>
          <a className="btn btn-secondary btn-sm" href={download('xlsx')}>
            <FileSpreadsheet size={13} aria-hidden="true" /> Excel
          </a>
          <a className="btn btn-secondary btn-sm" href={download('csv')}>
            <FileSpreadsheet size={13} aria-hidden="true" /> CSV
          </a>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>
            <Printer size={13} aria-hidden="true" /> Imprimir
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={syncNow} disabled={syncing} title="Trae de Zoho las facturas y créditos más recientes">
            {syncing ? <Loader2 size={13} className="vd-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />} Sincronizar
          </button>
        </div>
      </div>

      {data?.sync ? (
        <div className={`vd-alert ${syncNotes.length ? 'vd-alert-warning' : 'vd-alert-info'} vd-statement-sync`} role="status">
          {syncNotes.length ? <AlertTriangle size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
          <div>
            Facturas sincronizadas {data.sync.bills.lastCompletedAt ? formatDateTime(data.sync.bills.lastCompletedAt) : 'nunca'} · créditos{' '}
            {data.sync.vendorCredits.lastCompletedAt ? formatDateTime(data.sync.vendorCredits.lastCompletedAt) : 'nunca'}.
            {syncNotes.length ? <> Si falta un documento de Zoho: {syncNotes.join('; ')}. Usa “Sincronizar”.</> : ' Si falta una factura reciente de Zoho, usa “Sincronizar”.'}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="vd-alert vd-alert-danger" role="alert">
          <AlertTriangle size={15} aria-hidden="true" /> {error}
        </div>
      ) : null}

      {data ? (
        <article className={`vd-doc${loading ? ' vd-dim' : ''}`} aria-busy={loading}>
          <header className="vd-doc-header">
            <div className="vd-doc-company">
              <span className="vd-doc-logo">{data.company.name}</span>
              {data.company.address ? <span>{data.company.address}</span> : null}
              {data.company.phone ? <span>{data.company.phone}</span> : null}
            </div>
            <div className="vd-doc-title">
              <h2>ESTADO DE CUENTA</h2>
              <span>{periodLabel}</span>
            </div>
          </header>

          <div className="vd-doc-meta">
            <div>
              <span className="vd-kpi-label">Para</span>
              <strong>{vendorName}</strong>
              {vendorRfc ? <span className="vd-muted">RFC {vendorRfc}</span> : null}
            </div>
            <dl className="vd-doc-summary">
              <div>
                <dt>Saldo de inicio</dt>
                <dd>{money(data.openingBalance)}</dd>
              </div>
              <div>
                <dt>Facturas (cargos)</dt>
                <dd>{money(data.billsTotal)}</dd>
              </div>
              <div>
                <dt>Créditos (abonos)</dt>
                <dd>− {money(data.creditsTotal)}</dd>
              </div>
              <div className="vd-doc-summary-total">
                <dt>Saldo actual</dt>
                <dd>{money(data.closingBalance)}</dd>
              </div>
            </dl>
          </div>

          <div className="vd-table-wrap">
            <table className="vd-table vd-doc-table">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Transacción</th>
                  <th scope="col">Folio</th>
                  <th scope="col">Estado</th>
                  <th scope="col" className="vd-num">Cargo</th>
                  <th scope="col" className="vd-num">Abono</th>
                  <th scope="col" className="vd-num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                <tr className="vd-statement-opening">
                  <td className="vd-nowrap">{data.from ? formatDateOnly(data.from) : data.firstDocumentDate ? formatDateOnly(data.firstDocumentDate) : '—'}</td>
                  <td colSpan={5}>
                    <strong>Saldo de inicio</strong>
                    {!data.from ? <span className="vd-muted-inline"> · desde la primera factura o crédito</span> : null}
                  </td>
                  <td className="vd-num vd-num-strong">{money(data.openingBalance)}</td>
                </tr>
                {data.rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td className="vd-nowrap">{formatDateOnly(r.date)}</td>
                    <td>{r.kind === 'bill' ? 'Factura de proveedor' : 'Crédito'}</td>
                    <td>
                      <Link href={r.href} className="vd-doc-link">
                        {r.number ?? '—'}
                      </Link>
                      {r.kind === 'bill' && r.dueDate ? <span className="vd-muted-inline"> · vence {formatDateOnly(r.dueDate)}</span> : null}
                    </td>
                    <td>
                      <StatusPill type={r.kind === 'bill' ? 'bills' : 'vendor_credits'} status={r.status} />
                    </td>
                    <td className="vd-num">{r.kind === 'bill' ? money(Math.abs(r.amount)) : ''}</td>
                    <td className="vd-num vd-num-credit">{r.kind === 'credit' ? `(${money(Math.abs(r.amount))})` : ''}</td>
                    <td className="vd-num vd-num-strong">{money(r.runningBalance)}</td>
                  </tr>
                ))}
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="vd-empty">
                      No hay {show === 'bills' ? 'facturas' : show === 'credits' ? 'créditos' : 'facturas ni créditos'} en este periodo.
                    </td>
                  </tr>
                ) : null}
                <tr className="vd-statement-total">
                  <td colSpan={4}>
                    <strong>Saldo actual</strong>
                    <span className="vd-muted-inline">
                      {' '}· {data.billsCount} factura{data.billsCount === 1 ? '' : 's'} · {data.creditsCount} crédito{data.creditsCount === 1 ? '' : 's'}
                      {data.excluded ? ` · ${data.excluded} en borrador/cancelados excluidos` : ''}
                    </span>
                  </td>
                  <td className="vd-num">{money(data.billsTotal)}</td>
                  <td className="vd-num vd-num-credit">({money(data.creditsTotal)})</td>
                  <td className="vd-num vd-num-strong">{money(data.closingBalance)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="vd-foot">
            {show !== 'all' ? 'Los saldos de inicio y actual incluyen facturas y créditos; la lista muestra solo lo filtrado. ' : ''}
            Saldo real = facturas del proveedor (cargos) − créditos aplicados (abonos), en orden de fecha.
          </p>
        </article>
      ) : loading ? (
        <div className="vd-loading">
          <Loader2 size={18} className="vd-spin" aria-hidden="true" /> Calculando el estado de cuenta…
        </div>
      ) : null}
    </section>
  );
}

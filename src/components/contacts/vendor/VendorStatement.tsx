'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { formatCurrency, formatDateOnly } from '@/modules/contacts/contacts-helpers';
import { presetRange, type StatementPreset, type VendorStatement as Statement } from '@/modules/contacts/vendor-statement';
import { StatusPill } from './vendor-ui';

const PRESETS: Array<{ id: StatementPreset; label: string }> = [
  { id: 'all', label: 'Todo el historial' },
  { id: 'this_month', label: 'Este mes' },
  { id: 'last_month', label: 'Mes pasado' },
  { id: 'last_90_days', label: 'Últimos 90 días' },
  { id: 'this_year', label: 'Este año' },
  { id: 'custom', label: 'Personalizado' },
];

/**
 * Statement tab: opening balance + bills (charges) − credits (abatements) with a running balance.
 * Default is the whole history (opening 0, from the first document); a period shows only its
 * documents with the balance carried in from before.
 */
export function VendorStatement({ contactId, vendorName, currencyCode }: { contactId: string; vendorName: string; currencyCode: string | null }) {
  const [preset, setPreset] = useState<StatementPreset>('all');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [data, setData] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => (preset === 'custom' ? { from: custom.from || null, to: custom.to || null } : presetRange(preset)), [preset, custom]);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    return p.toString();
  }, [range]);

  useEffect(() => {
    if (preset === 'custom' && !custom.from && !custom.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/app/contacts/vendors/${contactId}/statement${query ? `?${query}` : ''}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `Error ${res.status}`);
        return json as Statement;
      })
      .then((json) => !cancelled && setData(json))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Error'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [contactId, query, preset, custom.from, custom.to]);

  const money = (n: number) => formatCurrency(n, currencyCode);
  const hasPeriod = Boolean(range.from || range.to);

  return (
    <section className="vd-card" aria-label="Estado de cuenta">
      <div className="vd-card-head">
        <div>
          <h2 className="vd-card-title">Estado de cuenta de {vendorName}</h2>
          <p className="vd-card-sub">
            Saldo real = facturas del proveedor (cargos) − créditos (abonos), en orden de fecha.
            {data?.excluded ? ` Se excluyen ${data.excluded} documento${data.excluded === 1 ? '' : 's'} en borrador o cancelados.` : ''}
          </p>
        </div>
        <a className="btn btn-secondary btn-sm" href={`/app/contacts/vendors/${contactId}/statement?${query ? `${query}&` : ''}format=pdf`}>
          <Download size={13} aria-hidden="true" /> Descargar PDF
        </a>
      </div>

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

      {error ? (
        <div className="vd-alert vd-alert-danger" role="alert">
          <AlertTriangle size={15} aria-hidden="true" /> {error}
        </div>
      ) : null}

      {data ? (
        <div className={loading ? 'vd-dim' : undefined} aria-busy={loading}>
          <div className="vd-statement-summary">
            <div>
              <span className="vd-kpi-label">Saldo inicial</span>
              <strong>{money(data.openingBalance)}</strong>
              <span className="vd-muted">
                {hasPeriod ? `Acumulado antes del ${data.from ? formatDateOnly(data.from) : 'periodo'}` : 'Desde la primera factura o crédito'}
              </span>
            </div>
            <div>
              <span className="vd-kpi-label">Facturas (cargos)</span>
              <strong className="vd-kpi-warning">+ {money(data.billsTotal)}</strong>
              <span className="vd-muted">{data.billsCount} factura{data.billsCount === 1 ? '' : 's'}</span>
            </div>
            <div>
              <span className="vd-kpi-label">Créditos (abonos)</span>
              <strong className="vd-kpi-success">− {money(data.creditsTotal)}</strong>
              <span className="vd-muted">{data.creditsCount} crédito{data.creditsCount === 1 ? '' : 's'}</span>
            </div>
            <div className="vd-statement-closing">
              <span className="vd-kpi-label">Saldo actual</span>
              <strong>{money(data.closingBalance)}</strong>
              <span className="vd-muted">{data.to ? `Al ${formatDateOnly(data.to)}` : 'A la fecha'}</span>
            </div>
          </div>

          <div className="vd-table-wrap">
            <table className="vd-table">
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
                    <strong>Saldo inicial</strong>
                  </td>
                  <td className="vd-num vd-num-strong">{money(data.openingBalance)}</td>
                </tr>
                {data.rows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    <td className="vd-nowrap">{formatDateOnly(r.date)}</td>
                    <td>{r.kind === 'bill' ? 'Factura del proveedor' : 'Crédito'}</td>
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
                      No hay facturas ni créditos en este periodo.
                    </td>
                  </tr>
                ) : null}
                <tr className="vd-statement-total">
                  <td colSpan={6}>
                    <strong>Saldo actual</strong>
                  </td>
                  <td className="vd-num vd-num-strong">{money(data.closingBalance)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : loading ? (
        <div className="vd-loading">
          <Loader2 size={18} className="vd-spin" aria-hidden="true" /> Calculando el estado de cuenta…
        </div>
      ) : null}
    </section>
  );
}

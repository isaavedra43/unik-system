'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Plus, RefreshCw } from 'lucide-react';
import { CampaignWizard } from './CampaignWizard';
import { CampaignProgress } from './CampaignProgress';
import {
  ACTIVE_STATUSES,
  api,
  CAMPAIGN_STATUS_LABEL,
  CHANNEL_LABEL,
  money,
  type CampaignDTO,
} from './campaigns-client';

interface ListResponse {
  campaigns: CampaignDTO[];
  canManage: boolean;
  canApprove: boolean;
}

export function CampaignsWorkspace({
  canManage,
  canApprove,
}: {
  canManage: boolean;
  canApprove: boolean;
}) {
  const [campaigns, setCampaigns] = useState<CampaignDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selected = useMemo(
    () => campaigns.find((c) => c.id === selectedId) ?? null,
    [campaigns, selectedId]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
      const data = await api<ListResponse>(`/app/campaigns/api/campaigns${params}`);
      setCampaigns(data.campaigns);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las campañas');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = (campaign: CampaignDTO) => {
    setCampaigns((prev) =>
      prev.some((c) => c.id === campaign.id)
        ? prev.map((c) => (c.id === campaign.id ? campaign : c))
        : [campaign, ...prev]
    );
    setSelectedId(campaign.id);
    setCreating(false);
  };

  const info = (status: string) =>
    CAMPAIGN_STATUS_LABEL[status] ?? { label: status, badge: 'badge-weak' };
  const progressPct = (c: CampaignDTO) => {
    const total = c.audience?.count ?? c.stats.total;
    if (!total) return 0;
    const done =
      c.stats.counts.sent +
      c.stats.counts.delivered +
      c.stats.counts.failed +
      c.stats.counts.skipped +
      c.stats.counts.opted_out;
    return Math.round((done / total) * 100);
  };

  return (
    <div className="assistant-admin-panel" style={{ display: 'grid', gap: '1rem' }}>
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      <div
        className="campaigns-layout"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(16rem, 1fr) minmax(0, 2.4fr)',
          gap: '1rem',
          alignItems: 'start',
        }}
      >
        <section className="card" aria-label="Lista de campañas">
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
              {Object.entries(CAMPAIGN_STATUS_LABEL).map(([k, v]) => (
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
            {canManage ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setCreating(true);
                  setSelectedId(null);
                }}
              >
                <Plus size={16} /> Nueva campaña
              </button>
            ) : null}
          </div>
          {loading ? <div className="assistant-admin-loading">Cargando…</div> : null}
          {!loading && campaigns.length === 0 ? (
            <div className="empty-state">
              <Megaphone size={32} aria-hidden="true" />
              <h3 className="empty-state-title">Sin campañas</h3>
              <p>
                {canManage
                  ? 'Crea la primera con “Nueva campaña”.'
                  : 'Aún no hay campañas para mostrar.'}
              </p>
            </div>
          ) : null}
          {campaigns.length > 0 ? (
            <div className="table-wrap">
              <table className="assistant-admin-table">
                <thead>
                  <tr>
                    <th>Campaña</th>
                    <th>Estado</th>
                    <th style={{ textAlign: 'right' }}>Avance</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr
                      key={c.id}
                      className="assistant-admin-row-clickable"
                      onClick={() => {
                        setSelectedId(c.id);
                        setCreating(false);
                      }}
                      aria-selected={c.id === selectedId}
                      style={c.id === selectedId ? { fontWeight: 600 } : undefined}
                    >
                      <td>
                        {c.name}
                        <div className="assistant-admin-muted" style={{ fontSize: '0.8em' }}>
                          {CHANNEL_LABEL[c.channel] ?? c.channel} · {c.accountLabel ?? '—'} ·{' '}
                          {c.audience?.count ?? '—'} dest. · {money(c.budgetSpent)}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${info(c.status).badge}`}>
                          {info(c.status).label}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {ACTIVE_STATUSES.has(c.status) ? `${progressPct(c)} %` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="card" aria-label="Detalle de campaña">
          {creating ? (
            <CampaignWizard
              campaign={null}
              canManage={canManage}
              canApprove={canApprove}
              onChange={upsert}
              onCancel={() => setCreating(false)}
            />
          ) : !selected ? (
            <div className="empty-state">
              <h3 className="empty-state-title">Selecciona una campaña</h3>
              <p>
                {canManage
                  ? 'O crea una nueva para iniciar el asistente paso a paso.'
                  : 'Verás su audiencia, contenido y progreso.'}
              </p>
            </div>
          ) : ACTIVE_STATUSES.has(selected.status) ? (
            <CampaignProgress campaign={selected} canManage={canManage} onChange={upsert} />
          ) : (
            <CampaignWizard
              campaign={selected}
              canManage={canManage}
              canApprove={canApprove}
              onChange={upsert}
              onCancel={() => setSelectedId(null)}
            />
          )}
        </section>
      </div>
      <style>{`@media (max-width: 900px) { .campaigns-layout { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

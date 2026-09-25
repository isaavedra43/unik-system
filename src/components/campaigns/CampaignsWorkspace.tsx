'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  Megaphone,
  MessageSquare,
  PauseCircle,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Send,
  Snowflake,
} from 'lucide-react';
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

const CHANNEL_ICON: Record<
  string,
  React.ComponentType<{ size?: number | string; className?: string }>
> = {
  whatsapp: MessageSquare,
  sms: Phone,
  telegram: Send,
};

const STATUS_FILTERS = [
  { id: '', label: 'Todas' },
  { id: 'active', label: 'Activas' },
  { id: 'draft', label: 'Borradores' },
  { id: 'pending_approval', label: 'Por aprobar' },
  { id: 'completed', label: 'Completadas' },
];

function progressPct(c: CampaignDTO): number {
  const total = c.audience?.count ?? c.stats.total;
  if (!total) return 0;
  const done =
    c.stats.counts.sent +
    c.stats.counts.delivered +
    c.stats.counts.failed +
    c.stats.counts.skipped +
    c.stats.counts.opted_out;
  return Math.min(100, Math.round((done / total) * 100));
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
  const [query, setQuery] = useState('');
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
      const data = await api<ListResponse>('/app/campaigns/api/campaigns');
      setCampaigns(data.campaigns);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las campañas');
    } finally {
      setLoading(false);
    }
  }, []);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (statusFilter === 'active' && !['scheduled', 'running', 'paused'].includes(c.status))
        return false;
      if (statusFilter && statusFilter !== 'active' && c.status !== statusFilter) return false;
      if (
        q &&
        !`${c.name} ${c.accountLabel ?? ''} ${CHANNEL_LABEL[c.channel] ?? ''}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [campaigns, statusFilter, query]);

  const kpis = useMemo(() => {
    const running = campaigns.filter((c) => c.status === 'running').length;
    const pending = campaigns.filter((c) => c.status === 'pending_approval').length;
    const recipients = campaigns.reduce((acc, c) => acc + (c.audience?.count ?? 0), 0);
    const sent = campaigns.reduce(
      (acc, c) => acc + c.stats.counts.sent + c.stats.counts.delivered,
      0
    );
    return { total: campaigns.length, running, pending, recipients, sent };
  }, [campaigns]);

  const info = (status: string) =>
    CAMPAIGN_STATUS_LABEL[status] ?? { label: status, badge: 'badge-weak' };

  return (
    <div className="assistant-admin-panel" style={{ display: 'grid', gap: '1rem' }}>
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="assistant-admin-stat-grid camp-kpis">
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">Campañas</div>
          <div className="assistant-admin-stat-value">{kpis.total}</div>
        </div>
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">
            <Send size={13} style={{ marginRight: '0.3rem', verticalAlign: '-2px' }} />
            En envío ahora
          </div>
          <div className="assistant-admin-stat-value">{kpis.running}</div>
        </div>
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">
            <Clock3 size={13} style={{ marginRight: '0.3rem', verticalAlign: '-2px' }} />
            Por aprobar
          </div>
          <div className="assistant-admin-stat-value">{kpis.pending}</div>
        </div>
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">Mensajes enviados</div>
          <div className="assistant-admin-stat-value">{kpis.sent.toLocaleString('es-MX')}</div>
        </div>
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">Alcance congelado</div>
          <div className="assistant-admin-stat-value">
            {kpis.recipients.toLocaleString('es-MX')}
          </div>
        </div>
      </div>

      <div className="campaigns-layout">
        <section className="card camp-list" aria-label="Lista de campañas">
          <div className="camp-list-toolbar">
            <div className="camp-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                placeholder="Buscar campaña…"
                aria-label="Buscar campaña"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Recargar"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw size={16} className={loading ? 'camp-spin' : undefined} />
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
                <Plus size={16} /> Nueva
              </button>
            ) : null}
          </div>
          <div className="camp-chips" role="tablist" aria-label="Filtro por estado">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={statusFilter === f.id}
                className={`camp-chip${statusFilter === f.id ? ' active' : ''}`}
                onClick={() => setStatusFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {loading && campaigns.length === 0 ? (
            <div className="assistant-admin-loading">Cargando…</div>
          ) : null}
          {!loading && filtered.length === 0 ? (
            <div className="empty-state">
              <Megaphone size={32} aria-hidden="true" />
              <h3 className="empty-state-title">
                {campaigns.length === 0 ? 'Sin campañas' : 'Sin resultados'}
              </h3>
              <p>
                {campaigns.length === 0
                  ? canManage
                    ? 'Crea la primera con “Nueva”.'
                    : 'Aún no hay campañas para mostrar.'
                  : 'Ajusta la búsqueda o el filtro de estado.'}
              </p>
            </div>
          ) : null}

          <div className="camp-cards" role="listbox" aria-label="Campañas">
            {filtered.map((c) => {
              const pct = progressPct(c);
              const st = info(c.status);
              const Icon = CHANNEL_ICON[c.channel] ?? Megaphone;
              const isSel = c.id === selectedId;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  className={`camp-card${isSel ? ' selected' : ''}`}
                  onClick={() => {
                    setSelectedId(c.id);
                    setCreating(false);
                  }}
                >
                  <div className="camp-card-head">
                    <span className={`camp-chan camp-chan-${c.channel}`} aria-hidden="true">
                      <Icon size={14} />
                    </span>
                    <span className="camp-card-name">{c.name}</span>
                    <span className={`badge ${st.badge}`}>{st.label}</span>
                  </div>
                  <div className="camp-card-meta">
                    {CHANNEL_LABEL[c.channel] ?? c.channel} · {c.accountLabel ?? '—'}
                  </div>
                  <div className="camp-card-stats">
                    <span>
                      {c.audience?.count != null
                        ? `${c.audience.count.toLocaleString('es-MX')} dest.`
                        : 'Sin audiencia'}
                    </span>
                    <span>{money(c.budgetSpent)} gastados</span>
                    {c.scheduledAt && c.status === 'scheduled' ? (
                      <span>
                        <Clock3 size={11} style={{ verticalAlign: '-1px' }} />{' '}
                        {new Date(c.scheduledAt).toLocaleString('es-MX', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    ) : null}
                  </div>
                  {ACTIVE_STATUSES.has(c.status) && c.audience?.count ? (
                    <div
                      className="camp-card-progress"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`Avance ${pct}%`}
                    >
                      <div style={{ width: `${pct}%` }} />
                    </div>
                  ) : null}
                  {c.status === 'paused' && c.stats.pauseReason === 'budget_exceeded' ? (
                    <span className="camp-card-flag">
                      <PauseCircle size={12} /> Pausada por presupuesto
                    </span>
                  ) : null}
                  {c.frozen && !ACTIVE_STATUSES.has(c.status) ? (
                    <span className="camp-card-flag info">
                      <Snowflake size={12} /> Audiencia congelada
                    </span>
                  ) : null}
                  {c.status === 'completed' ? (
                    <span className="camp-card-flag ok">
                      <CheckCircle2 size={12} /> Envío finalizado
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
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
              key={selected.id}
              campaign={selected}
              canManage={canManage}
              canApprove={canApprove}
              onChange={upsert}
              onCancel={() => setSelectedId(null)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

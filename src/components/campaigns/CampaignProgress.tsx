'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Eye, Pause, Play, RefreshCw, XCircle } from 'lucide-react';
import { Modal } from '@/components/ui/composite';
import { MessageBubble } from './MessageBubble';
import {
  api,
  CAMPAIGN_STATUS_LABEL,
  CHANNEL_LABEL,
  money,
  RECIPIENT_STATUS_LABEL,
  type CampaignDTO,
  type RecipientStatus,
  type RenderedRecipient,
} from './campaigns-client';

interface RecipientRow {
  id: string;
  displayName: string;
  identifier: string;
  status: RecipientStatus;
  batchNo: number;
  error: string | null;
  sentAt: string | null;
}

interface RecipientsPage {
  items: RecipientRow[];
  total: number;
  page: number;
  pageSize: number;
}

const ORDER: RecipientStatus[] = [
  'delivered',
  'sent',
  'queued',
  'pending',
  'failed',
  'skipped',
  'opted_out',
];

const SEG_CLASS: Record<RecipientStatus, string> = {
  delivered: 'ok2',
  sent: 'ok',
  queued: 'info',
  pending: 'weak',
  failed: 'danger',
  skipped: 'weak',
  opted_out: 'warn',
};

/**
 * Live progress over SSE (`campaign:{id}`), stacked per-status bar, budget
 * meter, pause / resume / cancel and the paginated recipient list with the
 * exact message each one receives.
 */
export function CampaignProgress({
  campaign,
  canManage,
  onChange,
}: {
  campaign: CampaignDTO;
  canManage: boolean;
  onChange: (c: CampaignDTO) => void;
}) {
  const [live, setLive] = useState<{
    counts: CampaignDTO['stats']['counts'];
    total: number;
    budgetSpent: string;
    status: string;
  }>({
    counts: campaign.stats.counts,
    total: campaign.audience?.count ?? campaign.stats.total,
    budgetSpent: campaign.budgetSpent,
    status: campaign.status,
  });
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<RecipientsPage | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<RenderedRecipient | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { campaign: fresh } = await api<{ campaign: CampaignDTO }>(
        `/app/campaigns/api/campaigns/${campaign.id}`
      );
      onChange(fresh);
      setLive({
        counts: fresh.stats.counts,
        total: fresh.audience?.count ?? fresh.stats.total,
        budgetSpent: fresh.budgetSpent,
        status: fresh.status,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar');
    }
  }, [campaign.id, onChange]);

  useEffect(() => {
    setLive({
      counts: campaign.stats.counts,
      total: campaign.audience?.count ?? campaign.stats.total,
      budgetSpent: campaign.budgetSpent,
      status: campaign.status,
    });
  }, [campaign]);

  useEffect(() => {
    const source = new EventSource(
      `/app/realtime/api/stream?channels=${encodeURIComponent(`campaign:${campaign.id}`)}`
    );
    source.addEventListener('ready', () => setConnected(true));
    source.addEventListener('campaign.progress', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          payload: {
            counts: CampaignDTO['stats']['counts'];
            total: number;
            budgetSpent: string;
            status: string;
          };
        };
        setLive((prev) => ({
          ...prev,
          counts: data.payload.counts,
          total: data.payload.total || prev.total,
          budgetSpent: data.payload.budgetSpent,
          status: data.payload.status,
        }));
      } catch {
        // ignore malformed events
      }
    });
    source.addEventListener('campaign.status', () => void refresh());
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [campaign.id, refresh]);

  const loadRecipients = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' });
      if (statusFilter) params.set('status', statusFilter);
      setRecipients(
        await api<RecipientsPage>(
          `/app/campaigns/api/campaigns/${campaign.id}/recipients?${params.toString()}`
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los destinatarios');
    }
  }, [campaign.id, page, statusFilter]);

  useEffect(() => {
    void loadRecipients();
  }, [loadRecipients]);

  const act = (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    api<{ campaign: CampaignDTO }>(`/app/campaigns/api/campaigns/${campaign.id}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    })
      .then(({ campaign: updated }) => {
        onChange(updated);
        setCancelOpen(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Error inesperado'))
      .finally(() => setBusy(false));
  };

  const showPreview = async (recipientId: string) => {
    try {
      setPreview(
        await api<RenderedRecipient>(
          `/app/campaigns/api/campaigns/${campaign.id}/preview/${recipientId}`
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar la vista');
    }
  };

  const info = CAMPAIGN_STATUS_LABEL[live.status] ?? { label: live.status, badge: 'badge-weak' };
  const total = Math.max(live.total, 1);
  const done =
    live.counts.sent +
    live.counts.delivered +
    live.counts.failed +
    live.counts.skipped +
    live.counts.opted_out;
  const pct = Math.min(100, Math.round((done / total) * 100));
  const pending = live.counts.pending + live.counts.queued;
  const etaMinutes =
    live.status === 'running' && campaign.ratePerMinute > 0
      ? pending / campaign.ratePerMinute
      : null;
  const budgetLimit = campaign.budgetLimit !== null ? Number(campaign.budgetLimit) : null;
  const budgetPct =
    budgetLimit && budgetLimit > 0
      ? Math.min(100, Math.round((Number(live.budgetSpent) / budgetLimit) * 100))
      : null;
  const pages = recipients ? Math.max(1, Math.ceil(recipients.total / recipients.pageSize)) : 1;

  return (
    <div style={{ display: 'grid', gap: '0.9rem' }}>
      <div className="camp-wiz-head">
        <div>
          <h2 style={{ margin: 0 }}>{campaign.name}</h2>
          <span className="assistant-admin-muted" style={{ fontSize: '0.85em' }}>
            {CHANNEL_LABEL[campaign.channel]} · {campaign.accountLabel ?? campaign.accountId} ·
            lotes de {campaign.batchSize} a {campaign.ratePerMinute}/min
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge ${info.badge}`}>{info.label}</span>
          <span
            className={`camp-live${connected ? ' on' : ''}`}
            aria-live="polite"
            title={connected ? 'Actualizando en tiempo real' : 'Sin conexión en vivo'}
          >
            <span className="camp-live-dot" aria-hidden="true" />
            {connected ? 'En vivo' : 'Sin conexión'}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Actualizar ahora"
            onClick={() => void refresh()}
            disabled={busy}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {campaign.stats.pauseReason === 'budget_exceeded' ? (
        <div className="alert alert-warning" role="status">
          Pausada automáticamente: el siguiente envío excedería el presupuesto. Amplía el
          presupuesto y reanuda.
        </div>
      ) : null}
      {campaign.status === 'scheduled' && campaign.scheduledAt ? (
        <div className="alert alert-info" role="status">
          Programada para iniciar el{' '}
          <strong>{new Date(campaign.scheduledAt).toLocaleString('es-MX')}</strong>. El scheduler la
          arranca automáticamente.
        </div>
      ) : null}

      <div className="assistant-admin-stat-grid">
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">Avance</div>
          <div className="assistant-admin-stat-value">{pct}%</div>
          <div className="assistant-admin-muted" style={{ fontSize: '0.78em' }}>
            {done.toLocaleString('es-MX')} de {live.total.toLocaleString('es-MX')}
          </div>
        </div>
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">Entregados / enviados</div>
          <div className="assistant-admin-stat-value">
            {(live.counts.delivered + live.counts.sent).toLocaleString('es-MX')}
          </div>
          <div className="assistant-admin-muted" style={{ fontSize: '0.78em' }}>
            {live.counts.failed.toLocaleString('es-MX')} fallidos · {live.counts.opted_out} bajas
          </div>
        </div>
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">Restantes</div>
          <div className="assistant-admin-stat-value">{pending.toLocaleString('es-MX')}</div>
          <div className="assistant-admin-muted" style={{ fontSize: '0.78em' }}>
            {etaMinutes ? `~${Math.ceil(etaMinutes)} min restantes` : '—'}
          </div>
        </div>
        <div className="assistant-admin-stat-card">
          <div className="assistant-admin-stat-label">Presupuesto</div>
          <div className="assistant-admin-stat-value" style={{ fontSize: '1rem' }}>
            {money(live.budgetSpent)}
            {budgetLimit !== null ? ` / ${money(campaign.budgetLimit)}` : ''}
          </div>
          {budgetPct !== null ? (
            <div
              className="camp-budget"
              role="progressbar"
              aria-valuenow={budgetPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Presupuesto usado"
            >
              <div style={{ width: `${budgetPct}%` }} data-hot={budgetPct > 85} />
            </div>
          ) : (
            <div className="assistant-admin-muted" style={{ fontSize: '0.78em' }}>
              sin límite
            </div>
          )}
        </div>
      </div>

      <div aria-label="Distribución por estado">
        <div
          className="camp-segbar"
          role="img"
          aria-label={ORDER.map(
            (s) => `${RECIPIENT_STATUS_LABEL[s].label}: ${live.counts[s] ?? 0}`
          ).join(', ')}
        >
          {ORDER.map((status) => {
            const n = live.counts[status] ?? 0;
            if (!n) return null;
            return (
              <span
                key={status}
                className={`camp-seg ${SEG_CLASS[status]}`}
                style={{ flexGrow: n }}
                title={`${RECIPIENT_STATUS_LABEL[status].label}: ${n}`}
              />
            );
          })}
          {live.total === 0 ? <span className="camp-seg weak" style={{ flexGrow: 1 }} /> : null}
        </div>
        <div className="camp-legend">
          {ORDER.map((status) => {
            const n = live.counts[status] ?? 0;
            return (
              <span key={status} className="camp-legend-item">
                <span className={`camp-seg-dot ${SEG_CLASS[status]}`} aria-hidden="true" />
                {RECIPIENT_STATUS_LABEL[status].label} <strong>{n.toLocaleString('es-MX')}</strong>
              </span>
            );
          })}
        </div>
      </div>

      {canManage ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {live.status === 'running' || live.status === 'scheduled' ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => act('pause', { reason: 'manual' })}
            >
              <Pause size={16} /> Pausar
            </button>
          ) : null}
          {live.status === 'paused' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => act('resume')}
            >
              <Play size={16} /> Reanudar
            </button>
          ) : null}
          {live.status !== 'completed' && live.status !== 'cancelled' ? (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() => setCancelOpen(true)}
            >
              <XCircle size={16} /> Cancelar campaña
            </button>
          ) : null}
        </div>
      ) : null}

      <section aria-label="Destinatarios">
        <div
          className="assistant-admin-filters"
          style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}
        >
          <select
            className="assistant-admin-select"
            value={statusFilter}
            aria-label="Filtrar destinatarios"
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {ORDER.map((s) => (
              <option key={s} value={s}>
                {RECIPIENT_STATUS_LABEL[s].label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void loadRecipients()}
          >
            Actualizar lista
          </button>
          <span className="assistant-admin-muted">
            {recipients ? `${recipients.total.toLocaleString('es-MX')} destinatarios` : 'Cargando…'}
          </span>
        </div>
        {recipients && recipients.items.length === 0 ? (
          <div className="empty-state">
            <p>Sin destinatarios en este filtro.</p>
          </div>
        ) : null}
        {recipients && recipients.items.length > 0 ? (
          <div className="table-wrap">
            <table className="assistant-admin-table">
              <thead>
                <tr>
                  <th>Contacto</th>
                  <th>Identificador</th>
                  <th>Lote</th>
                  <th>Estado</th>
                  <th>Detalle</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {recipients.items.map((r) => (
                  <tr key={r.id}>
                    <td>{r.displayName || '—'}</td>
                    <td style={{ fontFamily: 'monospace' }}>{r.identifier}</td>
                    <td>{r.batchNo + 1}</td>
                    <td>
                      <span
                        className={`badge ${RECIPIENT_STATUS_LABEL[r.status]?.badge ?? 'badge-weak'}`}
                      >
                        {RECIPIENT_STATUS_LABEL[r.status]?.label ?? r.status}
                      </span>
                    </td>
                    <td className="assistant-admin-muted">
                      {r.error ?? (r.sentAt ? new Date(r.sentAt).toLocaleString('es-MX') : '')}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={`Ver mensaje exacto de ${r.displayName || r.identifier}`}
                        onClick={() => void showPreview(r.id)}
                      >
                        <Eye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {recipients && pages > 1 ? (
          <div
            className="assistant-admin-pagination"
            style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}
          >
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Anterior
            </button>
            <span>
              Página {page} de {pages}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguiente
            </button>
          </div>
        ) : null}
      </section>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Mensaje exacto para el destinatario"
      >
        {preview ? (
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            <div className="assistant-admin-muted">
              Destino: <span style={{ fontFamily: 'monospace' }}>{preview.to}</span> · estado{' '}
              {preview.status ?? '—'}
            </div>
            <div className={`camp-phone camp-phone-${campaign.channel}`}>
              <MessageBubble body={preview.body} channel={campaign.channel} mode="highlight" />
            </div>
            {preview.missing.length ? (
              <div className="alert alert-warning">
                Variables sin valor: {preview.missing.join(', ')}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancelar campaña"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setCancelOpen(false)}
              disabled={busy}
            >
              Volver
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => act('cancel')}
            >
              Cancelar definitivamente
            </button>
          </>
        }
      >
        <p>
          Se detendrán los lotes pendientes y los destinatarios no enviados quedarán como omitidos.
          Los mensajes ya enviados no se pueden revertir.
        </p>
      </Modal>
    </div>
  );
}

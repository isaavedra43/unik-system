'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Check, Lock, PlayCircle, Send, ShieldCheck, Snowflake, Unlock, Users } from 'lucide-react';
import { Modal } from '@/components/ui/composite';
import {
  api,
  CHANNEL_LABEL,
  CHANNEL_PROVIDER,
  money,
  type Account,
  type AudienceFilter,
  type CampaignDTO,
  type RenderedRecipient,
} from './campaigns-client';

/**
 * Step-by-step campaign builder: channel/account → audience (count with
 * consent breakdown) → content with {{variables}} → freeze + rehearsal →
 * budget → approval. Every step persists through the API; freezing is
 * explicit and reversible only through "Descongelar".
 */

type Step = 1 | 2 | 3 | 4 | 5 | 6;
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 1, label: 'Canal y cuenta' },
  { id: 2, label: 'Audiencia' },
  { id: 3, label: 'Contenido' },
  { id: 4, label: 'Ensayo' },
  { id: 5, label: 'Presupuesto' },
  { id: 6, label: 'Aprobación' },
];

interface Preview {
  count: number;
  excluded: { noConsent: number; optedOut: number; noIdentifier: number };
  truncated: boolean;
  sample: Array<{ contactId: string; displayName: string; identifier: string }>;
}

interface Rehearsal {
  sampleSize: number;
  failed: number;
  results: RenderedRecipient[];
  campaign: CampaignDTO;
}

const VARIABLE_HINT =
  '{{nombre}}, {{primer_nombre}}, {{telefono}}, {{email}} y variables fijas definidas abajo';

function initialStep(c: CampaignDTO | null): Step {
  if (!c) return 1;
  if (c.status === 'pending_approval') return 6;
  if (c.frozen) return 4;
  if (!c.content) return 3;
  if (!c.audience?.filter.tags.length && c.audience?.count === null) return 2;
  return 3;
}

export function CampaignWizard({
  campaign,
  canManage,
  canApprove,
  onChange,
  onCancel,
}: {
  campaign: CampaignDTO | null;
  canManage: boolean;
  canApprove: boolean;
  onChange: (campaign: CampaignDTO) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>(initialStep(campaign));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);

  // Step 1
  const [name, setName] = useState(campaign?.name ?? '');
  const [channel, setChannel] = useState<CampaignDTO['channel']>(campaign?.channel ?? 'whatsapp');
  const [accountId, setAccountId] = useState(campaign?.accountId ?? '');
  // Step 2
  const [filter, setFilter] = useState<AudienceFilter>(
    campaign?.audience?.filter ?? { tags: [], tagMode: 'any', excludeTags: [] }
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  // Step 3
  const [body, setBody] = useState(campaign?.content?.body ?? '');
  const [templateKey, setTemplateKey] = useState(campaign?.content?.templateKey ?? '');
  const [variables, setVariables] = useState<Array<{ key: string; value: string }>>(
    Object.entries(campaign?.content?.variables ?? {}).map(([key, value]) => ({ key, value }))
  );
  // Step 4
  const [sampleSize, setSampleSize] = useState(5);
  const [rehearsal, setRehearsal] = useState<Rehearsal | null>(null);
  // Step 5
  const [budgetLimit, setBudgetLimit] = useState(campaign?.budgetLimit ?? '');
  const [costPerMessage, setCostPerMessage] = useState(campaign?.costPerMessage ?? '0');
  const [batchSize, setBatchSize] = useState(campaign?.batchSize ?? 500);
  const [ratePerMinute, setRatePerMinute] = useState(campaign?.ratePerMinute ?? 60);
  // Step 6
  const [scheduledAt, setScheduledAt] = useState('');
  const [allowPartial, setAllowPartial] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const frozen = Boolean(campaign?.frozen);
  const editable =
    canManage &&
    !frozen &&
    (!campaign || ['draft', 'rehearsal', 'pending_approval'].includes(campaign.status));

  useEffect(() => {
    api<{ accounts: Account[] }>('/app/campaigns/api/accounts')
      .then((d) => setAccounts(d.accounts))
      .catch(() => setAccounts([]));
    api<{ tags: Array<{ tag: string; count: number }> }>('/app/campaigns/api/audience')
      .then((d) => setTags(d.tags))
      .catch(() => setTags([]));
  }, []);

  const channelAccounts = useMemo(
    () => accounts.filter((a) => a.provider === CHANNEL_PROVIDER[channel]),
    [accounts, channel]
  );
  const detectedVariables = useMemo(
    () => [...new Set([...body.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1]))],
    [body]
  );

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

  const post = (path: string, body?: unknown) =>
    api<{ campaign: CampaignDTO }>(`/app/campaigns/api/campaigns/${campaign!.id}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  const patch = (data: unknown) =>
    api<{ campaign: CampaignDTO }>(`/app/campaigns/api/campaigns/${campaign!.id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });

  const saveStep1 = () =>
    run(async () => {
      if (!campaign) {
        const { campaign: created } = await api<{ campaign: CampaignDTO }>(
          '/app/campaigns/api/campaigns',
          { method: 'POST', body: JSON.stringify({ name, channel, accountId }) }
        );
        onChange(created);
      } else {
        const { campaign: updated } = await patch({ name, channel, accountId });
        onChange(updated);
      }
      setStep(2);
    });

  const calcAudience = () =>
    run(async () => {
      setPreview(
        await api<Preview>('/app/campaigns/api/audience', {
          method: 'POST',
          body: JSON.stringify({ channel, filter }),
        })
      );
    });

  const saveStep2 = () =>
    run(async () => {
      const { campaign: updated } = await patch({ audienceFilter: filter });
      onChange(updated);
      setStep(3);
    });

  const saveStep3 = () =>
    run(async () => {
      const vars: Record<string, string> = {};
      for (const v of variables) if (v.key.trim()) vars[v.key.trim()] = v.value;
      const { campaign: updated } = await patch({
        content: { body, templateKey: templateKey.trim() || undefined, variables: vars },
      });
      onChange(updated);
      setStep(4);
    });

  const freeze = () =>
    run(async () => {
      const { campaign: updated } = await post('freeze');
      onChange(updated);
      setRehearsal(null);
      setNotice(`Audiencia congelada: ${updated.audience?.count ?? 0} destinatarios.`);
    });

  const unfreeze = () =>
    run(async () => {
      const { campaign: updated } = await post('unfreeze');
      onChange(updated);
      setRehearsal(null);
      setStep(2);
    });

  const rehearse = () =>
    run(async () => {
      const result = await api<Rehearsal>(`/app/campaigns/api/campaigns/${campaign!.id}/rehearse`, {
        method: 'POST',
        body: JSON.stringify({ sampleSize }),
      });
      setRehearsal(result);
      onChange(result.campaign);
    });

  const saveStep5 = () =>
    run(async () => {
      const { campaign: updated } = await patch({
        budgetLimit: budgetLimit === '' ? null : Number(budgetLimit),
        costPerMessage: Number(costPerMessage) || 0,
        batchSize: Number(batchSize) || 500,
        ratePerMinute: Number(ratePerMinute) || 60,
      });
      onChange(updated);
      setStep(6);
    });

  const submit = () =>
    run(async () => {
      const { campaign: updated } = await post('submit');
      onChange(updated);
      setNotice('Solicitud de aprobación enviada.');
    });

  const approve = () =>
    run(async () => {
      const { campaign: updated } = await post('approve', {
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
        allowPartialBudget: allowPartial,
      });
      setConfirmOpen(false);
      onChange(updated);
    });

  const estimated =
    campaign?.audience?.count !== null && campaign?.audience?.count !== undefined
      ? Number(costPerMessage || 0) * campaign.audience.count
      : null;
  const overBudget = estimated !== null && budgetLimit !== '' && estimated > Number(budgetLimit);

  const toggleTag = (list: 'tags' | 'excludeTags', tag: string) =>
    setFilter((f) => ({
      ...f,
      [list]: f[list].includes(tag) ? f[list].filter((t) => t !== tag) : [...f[list], tag],
    }));

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ margin: 0 }}>{campaign ? campaign.name : 'Nueva campaña'}</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {frozen ? (
            <span className="badge badge-info">
              <Lock size={12} /> Congelada
            </span>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cerrar
          </button>
        </div>
      </div>
      <nav className="assistant-admin-tabs" aria-label="Pasos" style={{ flexWrap: 'wrap' }}>
        {STEPS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`assistant-admin-tab${step === s.id ? ' active' : ''}`}
            aria-current={step === s.id ? 'step' : undefined}
            disabled={!campaign && s.id > 1}
            onClick={() => setStep(s.id)}
          >
            {s.id}. {s.label}
          </button>
        ))}
      </nav>
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

      {step === 1 ? (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void saveStep1();
          }}
        >
          <label className="form-field">
            <span>Nombre</span>
            <input
              className="assistant-admin-filter-input"
              value={name}
              required
              disabled={!editable || busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Canal</span>
            <select
              className="assistant-admin-select"
              value={channel}
              disabled={!editable || busy}
              onChange={(e) => {
                setChannel(e.target.value as CampaignDTO['channel']);
                setAccountId('');
              }}
            >
              {Object.entries(CHANNEL_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Cuenta de envío</span>
            <select
              className="assistant-admin-select"
              value={accountId}
              required
              disabled={!editable || busy}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Selecciona…</option>
              {channelAccounts.map((a) => (
                <option key={a.id} value={a.id} disabled={a.status !== 'active'}>
                  {a.label} · {a.identifier}
                  {a.status !== 'active' ? ' (pausada)' : ''}
                </option>
              ))}
            </select>
            {channelAccounts.length === 0 ? (
              <span className="assistant-admin-muted">
                No hay cuentas activas para este canal (configúralas en la bandeja).
              </span>
            ) : null}
          </label>
          <div>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!editable || busy || !name.trim() || !accountId}
            >
              Guardar y continuar
            </button>
          </div>
        </form>
      ) : null}

      {step === 2 ? (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <p className="assistant-admin-muted">
            Solo se incluyen contactos con consentimiento <strong>opted_in</strong> vigente para{' '}
            {CHANNEL_LABEL[channel]}, sin baja registrada y con identificador válido. Los contactos
            duplicados fusionados se excluyen.
          </p>
          <div className="form-grid">
            <fieldset className="form-field" disabled={!editable || busy}>
              <legend>Incluir etiquetas ({filter.tagMode === 'all' ? 'todas' : 'alguna'})</legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {tags.length === 0 ? (
                  <span className="assistant-admin-muted">
                    Sin etiquetas en contactos (vacío = todos los contactos elegibles).
                  </span>
                ) : null}
                {tags.map((t) => (
                  <label
                    key={t.tag}
                    className={`badge ${filter.tags.includes(t.tag) ? 'badge-info' : 'badge-weak'}`}
                    style={{ cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={filter.tags.includes(t.tag)}
                      onChange={() => toggleTag('tags', t.tag)}
                      style={{ marginRight: '0.25rem' }}
                    />
                    {t.tag} ({t.count})
                  </label>
                ))}
              </div>
              <label
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  alignItems: 'center',
                  marginTop: '0.5rem',
                }}
              >
                <select
                  className="assistant-admin-select"
                  value={filter.tagMode}
                  onChange={(e) =>
                    setFilter({ ...filter, tagMode: e.target.value as 'any' | 'all' })
                  }
                >
                  <option value="any">Con alguna de las etiquetas</option>
                  <option value="all">Con todas las etiquetas</option>
                </select>
              </label>
            </fieldset>
            <fieldset className="form-field" disabled={!editable || busy}>
              <legend>Excluir etiquetas</legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {tags.map((t) => (
                  <label
                    key={t.tag}
                    className={`badge ${filter.excludeTags.includes(t.tag) ? 'badge-danger' : 'badge-weak'}`}
                    style={{ cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={filter.excludeTags.includes(t.tag)}
                      onChange={() => toggleTag('excludeTags', t.tag)}
                      style={{ marginRight: '0.25rem' }}
                    />
                    {t.tag}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={calcAudience}
            >
              <Users size={16} /> Calcular audiencia
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!editable || busy}
              onClick={saveStep2}
            >
              Guardar y continuar
            </button>
          </div>
          {preview ? (
            <div className="assistant-admin-stat-grid">
              <div className="assistant-admin-stat-card">
                <div className="assistant-admin-stat-label">Elegibles</div>
                <div className="assistant-admin-stat-value">
                  {preview.count}
                  {preview.truncated ? '+' : ''}
                </div>
              </div>
              <div className="assistant-admin-stat-card">
                <div className="assistant-admin-stat-label">Sin consentimiento</div>
                <div className="assistant-admin-stat-value">{preview.excluded.noConsent}</div>
              </div>
              <div className="assistant-admin-stat-card">
                <div className="assistant-admin-stat-label">Con baja</div>
                <div className="assistant-admin-stat-value">{preview.excluded.optedOut}</div>
              </div>
              <div className="assistant-admin-stat-card">
                <div className="assistant-admin-stat-label">Sin identificador válido</div>
                <div className="assistant-admin-stat-value">{preview.excluded.noIdentifier}</div>
              </div>
              {preview.sample.length ? (
                <div className="assistant-admin-muted" style={{ gridColumn: '1 / -1' }}>
                  Muestra:{' '}
                  {preview.sample.map((s) => `${s.displayName} (${s.identifier})`).join(', ')}
                </div>
              ) : null}
            </div>
          ) : null}
          {campaign?.audience?.frozenAt ? (
            <div className="alert alert-info">
              Audiencia congelada el {new Date(campaign.audience.frozenAt).toLocaleString('es-MX')}{' '}
              con {campaign.audience.count} destinatarios. Para cambiarla, descongela en el paso 4.
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 3 ? (
        <form
          style={{ display: 'grid', gap: '0.75rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            void saveStep3();
          }}
        >
          <label className="form-field">
            <span>Mensaje</span>
            <textarea
              className="assistant-admin-filter-input"
              rows={5}
              value={body}
              required
              maxLength={4000}
              disabled={!editable || busy}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hola {{nombre}}, …"
            />
            <span className="assistant-admin-muted">
              Variables disponibles: {VARIABLE_HINT}. Detectadas:{' '}
              {detectedVariables.length ? detectedVariables.join(', ') : 'ninguna'}.
            </span>
          </label>
          <label className="form-field">
            <span>Plantilla del proveedor (opcional, p. ej. Content SID de WhatsApp)</span>
            <input
              className="assistant-admin-filter-input"
              value={templateKey}
              disabled={!editable || busy}
              onChange={(e) => setTemplateKey(e.target.value)}
            />
          </label>
          <fieldset className="form-field" disabled={!editable || busy}>
            <legend>Variables fijas</legend>
            {variables.map((v, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.35rem' }}>
                <input
                  className="assistant-admin-filter-input"
                  placeholder="clave"
                  aria-label={`Clave variable ${i + 1}`}
                  value={v.key}
                  onChange={(e) =>
                    setVariables((p) =>
                      p.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x))
                    )
                  }
                />
                <input
                  className="assistant-admin-filter-input"
                  placeholder="valor"
                  aria-label={`Valor variable ${i + 1}`}
                  value={v.value}
                  onChange={(e) =>
                    setVariables((p) =>
                      p.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x))
                    )
                  }
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Quitar variable ${i + 1}`}
                  onClick={() => setVariables((p) => p.filter((_, idx) => idx !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setVariables((p) => [...p, { key: '', value: '' }])}
            >
              Agregar variable
            </button>
          </fieldset>
          <div>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!editable || busy || !body.trim()}
            >
              Guardar y continuar
            </button>
          </div>
        </form>
      ) : null}

      {step === 4 && campaign ? (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {!frozen ? (
            <>
              <p className="assistant-admin-muted">
                Congelar materializa la lista exacta de destinatarios y fija el contenido. Después,
                cambios de etiquetas o contactos no afectan la campaña.
              </p>
              <div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!canManage || busy || !campaign.content}
                  onClick={freeze}
                >
                  <Snowflake size={16} /> Congelar audiencia y contenido
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="assistant-admin-stat-grid">
                <div className="assistant-admin-stat-card">
                  <div className="assistant-admin-stat-label">Destinatarios congelados</div>
                  <div className="assistant-admin-stat-value">{campaign.audience?.count ?? 0}</div>
                </div>
                <div className="assistant-admin-stat-card">
                  <div className="assistant-admin-stat-label">Lotes de {campaign.batchSize}</div>
                  <div className="assistant-admin-stat-value">
                    {Math.ceil((campaign.audience?.count ?? 0) / campaign.batchSize)}
                  </div>
                </div>
                <div className="assistant-admin-stat-card">
                  <div className="assistant-admin-stat-label">Último ensayo</div>
                  <div className="assistant-admin-stat-value">
                    {campaign.stats.rehearsal
                      ? `${campaign.stats.rehearsal.sampleSize} muestras`
                      : '—'}
                  </div>
                </div>
              </div>
              <div
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}
              >
                <label className="form-field" style={{ margin: 0 }}>
                  <span>Muestras</span>
                  <input
                    className="assistant-admin-filter-input"
                    type="number"
                    min={1}
                    max={50}
                    value={sampleSize}
                    onChange={(e) => setSampleSize(Number(e.target.value))}
                    style={{ width: '5rem' }}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!canManage || busy}
                  onClick={rehearse}
                >
                  <PlayCircle size={16} /> Ensayar (sin enviar)
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!canManage || busy || campaign.status === 'scheduled'}
                  onClick={unfreeze}
                >
                  <Unlock size={16} /> Descongelar
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => setStep(5)}
                >
                  Continuar
                </button>
              </div>
              {rehearsal ? (
                <div className="table-wrap">
                  <table className="assistant-admin-table" aria-label="Resultado del ensayo">
                    <thead>
                      <tr>
                        <th>Destino</th>
                        <th>Mensaje exacto</th>
                        <th>Resultado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rehearsal.results.map((r) => (
                        <tr key={r.recipientId}>
                          <td style={{ whiteSpace: 'nowrap' }}>{r.to}</td>
                          <td style={{ whiteSpace: 'pre-wrap' }}>
                            {r.body}
                            {r.missing.length ? (
                              <div className="assistant-admin-muted">
                                Variables sin valor: {r.missing.join(', ')}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <span
                              className={`badge ${r.status === 'failed' ? 'badge-danger' : 'badge-success'}`}
                            >
                              {r.status === 'failed' ? `Fallaría: ${r.error}` : 'Simulado OK'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {step === 5 && campaign ? (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void saveStep5();
          }}
        >
          <label className="form-field">
            <span>Costo por mensaje</span>
            <input
              className="assistant-admin-filter-input"
              type="number"
              min={0}
              step="0.0001"
              value={costPerMessage}
              disabled={!canManage || busy}
              onChange={(e) => setCostPerMessage(e.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Límite de presupuesto (vacío = sin límite)</span>
            <input
              className="assistant-admin-filter-input"
              type="number"
              min={0}
              step="0.01"
              value={budgetLimit}
              disabled={!canManage || busy}
              onChange={(e) => setBudgetLimit(e.target.value)}
            />
          </label>
          <label className="form-field">
            <span>Tamaño de lote</span>
            <input
              className="assistant-admin-filter-input"
              type="number"
              min={1}
              max={10000}
              value={batchSize}
              disabled={!canManage || busy || frozen}
              onChange={(e) => setBatchSize(Number(e.target.value))}
            />
          </label>
          <label className="form-field">
            <span>Mensajes por minuto</span>
            <input
              className="assistant-admin-filter-input"
              type="number"
              min={1}
              max={600}
              value={ratePerMinute}
              disabled={!canManage || busy}
              onChange={(e) => setRatePerMinute(Number(e.target.value))}
            />
          </label>
          <div style={{ gridColumn: '1 / -1' }}>
            {estimated !== null ? (
              <div className={`alert ${overBudget ? 'alert-warning' : 'alert-info'}`}>
                Costo estimado: <strong>{money(estimated)}</strong> para {campaign.audience?.count}{' '}
                destinatarios.
                {overBudget
                  ? ' Excede el presupuesto: la campaña se pausará automáticamente al agotarlo.'
                  : ''}
              </div>
            ) : (
              <div className="assistant-admin-muted">
                Congela la audiencia para estimar el costo.
              </div>
            )}
          </div>
          <div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!canManage || busy}>
              Guardar y continuar
            </button>
          </div>
        </form>
      ) : null}

      {step === 6 && campaign ? (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <dl className="assistant-admin-config-grid">
            <div className="assistant-admin-config-field">
              <dt className="assistant-admin-muted">Canal / cuenta</dt>
              <dd style={{ margin: 0 }}>
                {CHANNEL_LABEL[campaign.channel]} · {campaign.accountLabel ?? campaign.accountId}
              </dd>
            </div>
            <div className="assistant-admin-config-field">
              <dt className="assistant-admin-muted">Destinatarios</dt>
              <dd style={{ margin: 0 }}>
                {campaign.audience?.count ?? '—'}{' '}
                {frozen ? <Check size={14} aria-label="congelados" /> : '(sin congelar)'}
              </dd>
            </div>
            <div className="assistant-admin-config-field">
              <dt className="assistant-admin-muted">Costo estimado / presupuesto</dt>
              <dd style={{ margin: 0 }}>
                {money(campaign.estimatedCost)} /{' '}
                {campaign.budgetLimit === null ? 'sin límite' : money(campaign.budgetLimit)}
              </dd>
            </div>
            <div className="assistant-admin-config-field">
              <dt className="assistant-admin-muted">Ensayo</dt>
              <dd style={{ margin: 0 }}>
                {campaign.stats.rehearsal
                  ? `${campaign.stats.rehearsal.sampleSize} muestras, ${campaign.stats.rehearsal.failed} fallidas`
                  : 'Pendiente'}
              </dd>
            </div>
          </dl>
          {campaign.content ? (
            <div className="card" style={{ whiteSpace: 'pre-wrap' }}>
              {campaign.content.body}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'end' }}>
            {canManage && campaign.status === 'rehearsal' ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy || !campaign.stats.rehearsal}
                onClick={submit}
              >
                <Send size={16} /> Solicitar aprobación
              </button>
            ) : null}
            {canApprove &&
            frozen &&
            (campaign.status === 'pending_approval' || campaign.status === 'rehearsal') ? (
              <>
                <label className="form-field" style={{ margin: 0 }}>
                  <span>Iniciar el</span>
                  <input
                    className="assistant-admin-filter-input"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                  />
                </label>
                <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={allowPartial}
                    onChange={(e) => setAllowPartial(e.target.checked)}
                  />{' '}
                  Aceptar envío parcial si el presupuesto no alcanza
                </label>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || !campaign.stats.rehearsal}
                  onClick={() => setConfirmOpen(true)}
                >
                  <ShieldCheck size={16} /> Aprobar y programar
                </button>
              </>
            ) : null}
          </div>
          {campaign.status === 'pending_approval' && !canApprove ? (
            <div className="alert alert-info">
              Esperando aprobación de una persona con permiso para aprobar envíos masivos.
            </div>
          ) : null}
          <Modal
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title="Confirmar envío masivo"
            footer={
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirmOpen(false)}
                  disabled={busy}
                >
                  Cancelar
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>
                  {busy ? 'Programando…' : 'Aprobar'}
                </button>
              </>
            }
          >
            <p>
              Se enviará <strong>{campaign.name}</strong> por {CHANNEL_LABEL[campaign.channel]} a{' '}
              <strong>{campaign.audience?.count}</strong> destinatarios congelados
              {scheduledAt
                ? ` a partir de ${new Date(scheduledAt).toLocaleString('es-MX')}`
                : ' de inmediato'}
              .
            </p>
            <p>
              Costo estimado {money(campaign.estimatedCost)} · presupuesto{' '}
              {campaign.budgetLimit === null ? 'sin límite' : money(campaign.budgetLimit)}.
            </p>
            <p className="assistant-admin-muted">
              Los envíos reales se realizan por lotes en segundo plano; puedes pausar o cancelar en
              cualquier momento.
            </p>
          </Modal>
        </div>
      ) : null}
    </div>
  );
}

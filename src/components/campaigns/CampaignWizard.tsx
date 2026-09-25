'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleDollarSign,
  Clock3,
  Lock,
  MessageSquare,
  Phone,
  PlayCircle,
  Send,
  ShieldCheck,
  Snowflake,
  Unlock,
  Users,
  Variable,
} from 'lucide-react';
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
import {
  MessageBubble,
  PERSONALIZATION_VARS,
  smsSegments,
  splitByVariables,
} from './MessageBubble';

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
  { id: 4, label: 'Congelar y ensayar' },
  { id: 5, label: 'Presupuesto' },
  { id: 6, label: 'Aprobación' },
];

const CHANNEL_CARDS: Array<{
  id: CampaignDTO['channel'];
  icon: typeof MessageSquare;
  desc: string;
}> = [
  { id: 'whatsapp', icon: MessageSquare, desc: 'Mensajes ricos vía Twilio' },
  { id: 'sms', icon: Phone, desc: 'Texto plano vía Twilio' },
  { id: 'telegram', icon: Send, desc: 'Bot de Telegram' },
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

function initialStep(c: CampaignDTO | null): Step {
  if (!c) return 1;
  if (c.status === 'pending_approval') return 6;
  if (c.frozen) return 4;
  if (!c.content?.body) return c.audience ? 3 : 2;
  return 3;
}

function formatEta(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 60) return `~${Math.ceil(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return `~${h} h ${m} min`;
  return `~${Math.round(h / 24)} días`;
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
  const [accountsLoading, setAccountsLoading] = useState(true);
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
  const [previewName, setPreviewName] = useState('María García');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
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
    setAccountsLoading(true);
    api<{ accounts: Account[] }>('/app/campaigns/api/accounts')
      .then((d) => setAccounts(d.accounts))
      .catch(() => setAccounts([]))
      .finally(() => setAccountsLoading(false));
    api<{ tags: Array<{ tag: string; count: number }> }>('/app/campaigns/api/audience')
      .then((d) => setTags(d.tags))
      .catch(() => setTags([]));
  }, []);

  const channelAccounts = useMemo(
    () => accounts.filter((a) => a.provider === CHANNEL_PROVIDER[channel]),
    [accounts, channel]
  );
  const detectedVariables = useMemo(
    () => [...new Set(splitByVariables(body).flatMap((p) => (p.variable ? [p.variable] : [])))],
    [body]
  );
  const knownVariableKeys = useMemo(
    () =>
      new Set([
        ...PERSONALIZATION_VARS.map((v) => v.key),
        ...variables.map((v) => v.key.trim()).filter(Boolean),
      ]),
    [variables]
  );
  const unknownVariables = detectedVariables.filter((v) => !knownVariableKeys.has(v));
  const smsInfo = useMemo(() => (channel === 'sms' ? smsSegments(body) : null), [body, channel]);

  const stepDone: Record<Step, boolean> = {
    1: Boolean(campaign),
    2: Boolean(campaign?.audience),
    3: Boolean(campaign?.content?.body),
    4: Boolean(campaign?.stats.rehearsal),
    5: Boolean(campaign) && (Number(costPerMessage) > 0 || campaign?.budgetLimit != null),
    6: campaign?.status === 'scheduled' || campaign?.status === 'running',
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

  const post = (path: string, payload?: unknown) =>
    api<{ campaign: CampaignDTO }>(`/app/campaigns/api/campaigns/${campaign!.id}/${path}`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
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
  const etaMinutes =
    campaign?.audience?.count && ratePerMinute > 0
      ? campaign.audience.count / Number(ratePerMinute)
      : null;
  const previewVars = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const v of variables) if (v.key.trim()) vars[v.key.trim()] = v.value;
    return vars;
  }, [variables]);
  const previewPersonalization = useMemo(
    () => ({
      nombre: previewName,
      primer_nombre: previewName.split(' ')[0] ?? previewName,
    }),
    [previewName]
  );

  const insertVariable = (key: string) => {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? start;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const toggleTag = (list: 'tags' | 'excludeTags', tag: string) =>
    setFilter((f) => ({
      ...f,
      [list]: f[list].includes(tag) ? f[list].filter((t) => t !== tag) : [...f[list], tag],
    }));

  const audienceTotal = preview
    ? preview.count +
      preview.excluded.noConsent +
      preview.excluded.optedOut +
      preview.excluded.noIdentifier
    : 0;

  return (
    <div style={{ display: 'grid', gap: '0.9rem' }}>
      <div className="camp-wiz-head">
        <div>
          <h2 style={{ margin: 0 }}>{campaign ? campaign.name : 'Nueva campaña'}</h2>
          {campaign ? (
            <span className="assistant-admin-muted" style={{ fontSize: '0.85em' }}>
              {CHANNEL_LABEL[campaign.channel]} · {campaign.accountLabel ?? campaign.accountId}
            </span>
          ) : null}
        </div>
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

      <ol className="camp-stepper" aria-label="Pasos de la campaña">
        {STEPS.map((s, i) => {
          const done = stepDone[s.id];
          const active = step === s.id;
          return (
            <li key={s.id} className={`camp-step${active ? ' active' : ''}${done ? ' done' : ''}`}>
              <button
                type="button"
                aria-current={active ? 'step' : undefined}
                disabled={!campaign && s.id > 1}
                onClick={() => setStep(s.id)}
              >
                <span className="camp-step-dot">
                  {done ? <Check size={13} aria-label="completado" /> : s.id}
                </span>
                <span className="camp-step-label">{s.label}</span>
              </button>
              {i < STEPS.length - 1 ? <span className="camp-step-line" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>

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
          style={{ display: 'grid', gap: '0.9rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            void saveStep1();
          }}
        >
          <label className="form-field">
            <span>Nombre de la campaña</span>
            <input
              className="assistant-admin-filter-input"
              value={name}
              required
              maxLength={120}
              placeholder='Ej. "Promo mayo — clientes VIP"'
              disabled={!editable || busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <fieldset className="form-field" disabled={!editable || busy}>
            <legend>Canal de envío</legend>
            <div className="camp-channel-grid" role="radiogroup" aria-label="Canal">
              {CHANNEL_CARDS.map((ch) => {
                const Icon = ch.icon;
                const available = accounts.some((a) => a.provider === CHANNEL_PROVIDER[ch.id]);
                return (
                  <button
                    key={ch.id}
                    type="button"
                    role="radio"
                    aria-checked={channel === ch.id}
                    className={`camp-channel-card${channel === ch.id ? ' active' : ''}`}
                    onClick={() => {
                      setChannel(ch.id);
                      setAccountId('');
                    }}
                  >
                    <span className={`camp-chan camp-chan-${ch.id}`} aria-hidden="true">
                      <Icon size={16} />
                    </span>
                    <span className="camp-channel-name">{CHANNEL_LABEL[ch.id]}</span>
                    <span className="camp-channel-desc">{ch.desc}</span>
                    <span className={`camp-channel-avail${available ? ' ok' : ''}`}>
                      {accountsLoading ? '…' : available ? 'Cuenta disponible' : 'Sin cuenta'}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label className="form-field">
            <span>Cuenta de envío</span>
            <select
              className="assistant-admin-select"
              value={accountId}
              required
              disabled={!editable || busy || accountsLoading}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">{accountsLoading ? 'Cargando cuentas…' : 'Selecciona…'}</option>
              {channelAccounts.map((a) => (
                <option key={a.id} value={a.id} disabled={a.status !== 'active'}>
                  {a.label} · {a.identifier}
                  {a.status !== 'active' ? ' (pausada)' : ''}
                </option>
              ))}
            </select>
            {!accountsLoading && channelAccounts.length === 0 ? (
              <span className="assistant-admin-muted">
                No hay cuentas para {CHANNEL_LABEL[channel]}. Configúralas en la bandeja de
                comunicaciones primero.
              </span>
            ) : null}
          </label>

          <div>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!editable || busy || !name.trim() || !accountId}
            >
              {busy ? 'Guardando…' : 'Guardar y continuar'}
            </button>
          </div>
        </form>
      ) : null}

      {step === 2 ? (
        <div style={{ display: 'grid', gap: '0.9rem' }}>
          <p className="assistant-admin-muted" style={{ margin: 0 }}>
            Solo se incluyen contactos con consentimiento <strong>opted_in</strong> vigente para{' '}
            {CHANNEL_LABEL[channel]}, sin baja registrada y con identificador válido. Los duplicados
            fusionados se excluyen.
          </p>
          <div className="form-grid">
            <fieldset className="form-field" disabled={!editable || busy}>
              <legend>Incluir etiquetas ({filter.tagMode === 'all' ? 'todas' : 'alguna'})</legend>
              <div className="camp-tagset">
                {tags.length === 0 ? (
                  <span className="assistant-admin-muted">
                    Sin etiquetas en contactos (vacío = todos los elegibles).
                  </span>
                ) : null}
                {tags.map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    aria-pressed={filter.tags.includes(t.tag)}
                    className={`camp-tag${filter.tags.includes(t.tag) ? ' on' : ''}`}
                    onClick={() => toggleTag('tags', t.tag)}
                  >
                    {t.tag} <em>{t.count}</em>
                  </button>
                ))}
              </div>
              {filter.tags.length > 0 ? (
                <select
                  className="assistant-admin-select"
                  style={{ marginTop: '0.5rem', maxWidth: '22rem' }}
                  value={filter.tagMode}
                  onChange={(e) =>
                    setFilter({ ...filter, tagMode: e.target.value as 'any' | 'all' })
                  }
                >
                  <option value="any">Con alguna de las etiquetas</option>
                  <option value="all">Con todas las etiquetas</option>
                </select>
              ) : null}
            </fieldset>
            <fieldset className="form-field" disabled={!editable || busy}>
              <legend>Excluir etiquetas</legend>
              <div className="camp-tagset">
                {tags.map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    aria-pressed={filter.excludeTags.includes(t.tag)}
                    className={`camp-tag danger${filter.excludeTags.includes(t.tag) ? ' on' : ''}`}
                    onClick={() => toggleTag('excludeTags', t.tag)}
                  >
                    {t.tag}
                  </button>
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
              <Users size={16} /> {preview ? 'Recalcular audiencia' : 'Calcular audiencia'}
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
            <div className="camp-funnel" aria-live="polite">
              <div
                className="camp-funnel-bar"
                role="img"
                aria-label={`${preview.count} elegibles de ${audienceTotal} contactos filtrados`}
              >
                {preview.count > 0 ? (
                  <span
                    className="camp-funnel-seg ok"
                    style={{ flexGrow: preview.count }}
                    title={`${preview.count} elegibles`}
                  />
                ) : null}
                {preview.excluded.noConsent > 0 ? (
                  <span
                    className="camp-funnel-seg warn"
                    style={{ flexGrow: preview.excluded.noConsent }}
                    title={`${preview.excluded.noConsent} sin consentimiento`}
                  />
                ) : null}
                {preview.excluded.optedOut > 0 ? (
                  <span
                    className="camp-funnel-seg danger"
                    style={{ flexGrow: preview.excluded.optedOut }}
                    title={`${preview.excluded.optedOut} con baja`}
                  />
                ) : null}
                {preview.excluded.noIdentifier > 0 ? (
                  <span
                    className="camp-funnel-seg weak"
                    style={{ flexGrow: preview.excluded.noIdentifier }}
                    title={`${preview.excluded.noIdentifier} sin identificador`}
                  />
                ) : null}
              </div>
              <div className="assistant-admin-stat-grid">
                <div className="assistant-admin-stat-card camp-stat-ok">
                  <div className="assistant-admin-stat-label">Elegibles</div>
                  <div className="assistant-admin-stat-value">
                    {preview.count.toLocaleString('es-MX')}
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
                  <div className="assistant-admin-stat-label">Sin identificador</div>
                  <div className="assistant-admin-stat-value">{preview.excluded.noIdentifier}</div>
                </div>
              </div>
              {preview.sample.length ? (
                <div className="assistant-admin-muted">
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
          style={{ display: 'grid', gap: '0.9rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            void saveStep3();
          }}
        >
          <div className="camp-composer">
            <div style={{ display: 'grid', gap: '0.75rem', alignContent: 'start' }}>
              <label className="form-field">
                <span>Mensaje</span>
                <textarea
                  ref={bodyRef}
                  className="assistant-admin-filter-input"
                  rows={7}
                  value={body}
                  required
                  maxLength={4000}
                  disabled={!editable || busy}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Hola {{nombre}}, …"
                  style={{ minHeight: '8rem', lineHeight: 1.5 }}
                />
                <span className="camp-charcount">
                  {body.length.toLocaleString('es-MX')} / 4000
                  {smsInfo
                    ? ` · ~${smsInfo.segments} segmento${smsInfo.segments > 1 ? 's' : ''} SMS (${smsInfo.charset})`
                    : ''}
                </span>
              </label>

              <div className="form-field">
                <span className="assistant-admin-muted" style={{ fontSize: '0.85em' }}>
                  <Variable size={13} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />
                  Insertar variable (click en el texto donde va):
                </span>
                <div className="camp-tagset">
                  {PERSONALIZATION_VARS.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      className="camp-tag"
                      disabled={!editable || busy}
                      onClick={() => insertVariable(v.key)}
                    >
                      {`{{${v.key}}}`}
                    </button>
                  ))}
                  {variables
                    .filter((v) => v.key.trim())
                    .map((v) => (
                      <button
                        key={`fixed-${v.key}`}
                        type="button"
                        className="camp-tag"
                        disabled={!editable || busy}
                        onClick={() => insertVariable(v.key.trim())}
                      >
                        {`{{${v.key.trim()}}}`}
                      </button>
                    ))}
                </div>
                {unknownVariables.length ? (
                  <div className="alert alert-warning" style={{ marginTop: '0.5rem' }}>
                    Sin valor definido: {unknownVariables.map((v) => `{{${v}}}`).join(', ')} — se
                    enviarán vacías. Agrégalas como variables fijas abajo.
                  </div>
                ) : null}
              </div>

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
            </div>

            <div className="camp-preview-pane">
              <div className="camp-preview-title">Vista previa — {CHANNEL_LABEL[channel]}</div>
              <label className="form-field" style={{ margin: 0 }}>
                <span className="assistant-admin-muted" style={{ fontSize: '0.8em' }}>
                  Nombre de ejemplo para {'{{nombre}}'}
                </span>
                <input
                  className="assistant-admin-filter-input"
                  value={previewName}
                  onChange={(e) => setPreviewName(e.target.value)}
                  aria-label="Nombre de ejemplo para la vista previa"
                />
              </label>
              <div className={`camp-phone camp-phone-${channel}`}>
                {body.trim() ? (
                  <MessageBubble
                    body={body}
                    channel={channel}
                    variables={{ ...previewVars, ...previewPersonalization }}
                  />
                ) : (
                  <span className="assistant-admin-muted">Escribe el mensaje para verlo aquí…</span>
                )}
              </div>
              <span className="assistant-admin-muted" style={{ fontSize: '0.78em' }}>
                La vista usa datos de ejemplo; el paso 4 muestra el mensaje exacto por destinatario
                real.
              </span>
            </div>
          </div>

          <div>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!editable || busy || !body.trim()}
            >
              {busy ? 'Guardando…' : 'Guardar y continuar'}
            </button>
          </div>
        </form>
      ) : null}

      {step === 4 && campaign ? (
        <div style={{ display: 'grid', gap: '0.9rem' }}>
          {!frozen ? (
            <>
              <p className="assistant-admin-muted" style={{ margin: 0 }}>
                Congelar materializa la lista exacta de destinatarios y fija el contenido. Después,
                cambios de etiquetas o contactos no afectan la campaña.
              </p>
              <div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!canManage || busy || !campaign.content?.body}
                  onClick={freeze}
                >
                  <Snowflake size={16} /> {busy ? 'Congelando…' : 'Congelar audiencia y contenido'}
                </button>
                {!campaign.content?.body ? (
                  <span className="assistant-admin-muted" style={{ marginLeft: '0.5rem' }}>
                    Falta el contenido (paso 3).
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="assistant-admin-stat-grid">
                <div className="assistant-admin-stat-card camp-stat-ok">
                  <div className="assistant-admin-stat-label">Destinatarios congelados</div>
                  <div className="assistant-admin-stat-value">
                    {(campaign.audience?.count ?? 0).toLocaleString('es-MX')}
                  </div>
                </div>
                <div className="assistant-admin-stat-card">
                  <div className="assistant-admin-stat-label">Lotes de {campaign.batchSize}</div>
                  <div className="assistant-admin-stat-value">
                    {Math.ceil((campaign.audience?.count ?? 0) / campaign.batchSize)}
                  </div>
                </div>
                <div className="assistant-admin-stat-card">
                  <div className="assistant-admin-stat-label">Duración estimada</div>
                  <div className="assistant-admin-stat-value" style={{ fontSize: '1rem' }}>
                    {etaMinutes ? formatEta(etaMinutes) : '—'}
                  </div>
                </div>
                <div className="assistant-admin-stat-card">
                  <div className="assistant-admin-stat-label">Último ensayo</div>
                  <div className="assistant-admin-stat-value" style={{ fontSize: '1rem' }}>
                    {campaign.stats.rehearsal
                      ? `${campaign.stats.rehearsal.sampleSize} muestras · ${campaign.stats.rehearsal.failed} fallidas`
                      : '—'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'end', flexWrap: 'wrap' }}>
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
                  <PlayCircle size={16} /> {busy ? 'Ensayando…' : 'Ensayar (sin enviar)'}
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
                <div className="camp-rehearsal">
                  <div className="assistant-admin-muted">
                    Ensayo: {rehearsal.sampleSize} muestras ·{' '}
                    {rehearsal.failed === 0 ? (
                      <strong style={{ color: 'var(--unik-success, #16a34a)' }}>
                        todas simuladas correctamente
                      </strong>
                    ) : (
                      <strong style={{ color: 'var(--unik-danger, #dc2626)' }}>
                        {rehearsal.failed} fallarían
                      </strong>
                    )}
                  </div>
                  <div className="camp-rehearsal-grid">
                    {rehearsal.results.map((r) => (
                      <div key={r.recipientId} className="camp-rehearsal-item">
                        <div className="camp-rehearsal-to">
                          <code>{r.to}</code>
                          <span
                            className={`badge ${r.status === 'failed' ? 'badge-danger' : 'badge-success'}`}
                          >
                            {r.status === 'failed' ? 'Fallaría' : 'OK'}
                          </span>
                        </div>
                        <MessageBubble body={r.body} channel={campaign.channel} mode="highlight" />
                        {r.status === 'failed' && r.error ? (
                          <div className="assistant-admin-muted" style={{ fontSize: '0.8em' }}>
                            {r.error}
                          </div>
                        ) : null}
                        {r.missing.length ? (
                          <div className="assistant-admin-muted" style={{ fontSize: '0.8em' }}>
                            Variables sin valor: {r.missing.join(', ')}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {step === 5 && campaign ? (
        <form
          style={{ display: 'grid', gap: '0.9rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            void saveStep5();
          }}
        >
          <div className="form-grid">
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
          </div>

          {estimated !== null ? (
            <div className={`camp-cost-card${overBudget ? ' over' : ''}`}>
              <CircleDollarSign size={20} aria-hidden="true" />
              <div>
                <div className="camp-cost-main">
                  {money(estimated)} <span>estimados</span>
                </div>
                <div className="assistant-admin-muted" style={{ fontSize: '0.85em' }}>
                  {campaign.audience?.count?.toLocaleString('es-MX')} destinatarios ×{' '}
                  {money(costPerMessage)} c/u
                  {etaMinutes ? ` · duración aprox. ${formatEta(etaMinutes)}` : ''}
                  {budgetLimit !== '' ? ` · límite ${money(budgetLimit)}` : ' · sin límite'}
                </div>
                {overBudget ? (
                  <div className="camp-cost-warn">
                    Excede el presupuesto: la campaña se pausará automáticamente al agotarlo (los
                    enviados no se reembolsan).
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="assistant-admin-muted">
              Congela la audiencia (paso 4) para estimar el costo total.
            </div>
          )}

          <div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!canManage || busy}>
              {busy ? 'Guardando…' : 'Guardar y continuar'}
            </button>
          </div>
        </form>
      ) : null}

      {step === 6 && campaign ? (
        <div style={{ display: 'grid', gap: '0.9rem' }}>
          <ul className="camp-checklist" aria-label="Resumen antes de enviar">
            <li className="ok">
              <Check size={15} /> Canal y cuenta:{' '}
              <strong>
                {CHANNEL_LABEL[campaign.channel]} · {campaign.accountLabel ?? campaign.accountId}
              </strong>
            </li>
            <li className={frozen ? 'ok' : 'warn'}>
              {frozen ? <Check size={15} /> : <Clock3 size={15} />} Audiencia:{' '}
              <strong>
                {campaign.audience?.count != null
                  ? `${campaign.audience.count.toLocaleString('es-MX')} destinatarios${frozen ? ' congelados' : ' (sin congelar)'}`
                  : 'sin definir'}
              </strong>
            </li>
            <li className={campaign.content?.body ? 'ok' : 'warn'}>
              {campaign.content?.body ? <Check size={15} /> : <Clock3 size={15} />} Contenido:{' '}
              <strong>{campaign.content?.body ? 'definido' : 'pendiente'}</strong>
            </li>
            <li className={campaign.stats.rehearsal ? 'ok' : 'warn'}>
              {campaign.stats.rehearsal ? <Check size={15} /> : <Clock3 size={15} />} Ensayo:{' '}
              <strong>
                {campaign.stats.rehearsal
                  ? `${campaign.stats.rehearsal.sampleSize} muestras, ${campaign.stats.rehearsal.failed} fallidas`
                  : 'pendiente (requerido para aprobar)'}
              </strong>
            </li>
            <li className="ok">
              <Check size={15} /> Presupuesto:{' '}
              <strong>
                {money(campaign.estimatedCost)} estimados ·{' '}
                {campaign.budgetLimit === null
                  ? 'sin límite'
                  : `límite ${money(campaign.budgetLimit)}`}
              </strong>
            </li>
            {etaMinutes ? (
              <li className="ok">
                <Clock3 size={15} /> Duración aprox.: <strong>{formatEta(etaMinutes)}</strong> a{' '}
                {campaign.ratePerMinute}/min
              </li>
            ) : null}
          </ul>

          {campaign.content?.body ? (
            <div className="camp-preview-pane">
              <div className="camp-preview-title">Mensaje que se enviará</div>
              <div className={`camp-phone camp-phone-${campaign.channel}`}>
                <MessageBubble
                  body={campaign.content.body}
                  channel={campaign.channel}
                  variables={{
                    ...campaign.content.variables,
                    ...previewPersonalization,
                  }}
                />
              </div>
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
                  <span>Iniciar el (vacío = ahora)</span>
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

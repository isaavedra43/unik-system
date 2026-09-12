'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Clock,
  Phone,
  Radio,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { AssistantAdminStatCard } from '@/components/assistant/admin/AssistantAdminStatCard';
import type { VoiceSettings } from '@/modules/voice/voice-settings';

interface Payload {
  settings: VoiceSettings;
  retention: { recordingRetentionDays: number; transcriptRetentionDays: number };
  accounts: Array<{
    id: string;
    label: string;
    identifier: string;
    status: string;
    teamKeys: string[];
  }>;
  status: {
    livekit: {
      mock: boolean;
      configured: boolean;
      sipConfigured: boolean;
      sipDomain: string | null;
      egressUsesDedicatedToken: boolean;
      agentName?: string;
      missingVars: string[];
    };
    twilioWebhookConfigured: boolean;
    voiceAgent?: { agentName: string; lastSeenAt: string | null };
  };
}

type TabId = 'status' | 'ai' | 'recording';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'status', label: 'Estado' },
  { id: 'ai', label: 'IA por cuenta' },
  { id: 'recording', label: 'Grabación y retención' },
];

export function VoiceAdminPanel() {
  const [tab, setTab] = useState<TabId>('status');
  const [data, setData] = useState<Payload | null>(null);
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/admin/voice/api/settings');
      if (!res.ok) {
        setError('No se pudo cargar la configuración de telefonía');
        return;
      }
      const payload = (await res.json()) as Payload;
      setData(payload);
      setSettings((prev) => prev ?? payload.settings);
    } catch {
      setError('Error de red');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/app/admin/voice/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const payload = (await res.json().catch(() => ({}))) as Payload & { error?: string };
      if (!res.ok) {
        setError(payload.error ?? 'No se pudo guardar');
        return;
      }
      setData(payload);
      setSettings(payload.settings);
      setNotice('Configuración guardada');
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) return <div className="assistant-admin-loading">Cargando…</div>;
  if (!data || !settings)
    return <div className="assistant-admin-error">{error ?? 'Sin datos'}</div>;

  const lk = data.status.livekit;

  return (
    <div className="assistant-admin-panel">
      <div className="assistant-admin-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`assistant-admin-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="assistant-admin-error" role="alert">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {notice && (
        <div className="assistant-admin-success" role="status">
          <CheckCircle2 size={16} /> {notice}
        </div>
      )}

      <div className="assistant-admin-tab-content">
        {tab === 'status' && (
          <div className="assistant-admin-overview">
            <div className="assistant-admin-stat-grid">
              <AssistantAdminStatCard
                label="LiveKit"
                value={lk.mock ? 'Simulado' : 'Configurado'}
                hint={lk.mock ? `Faltan: ${lk.missingVars.join(', ')}` : 'Salas, tokens y egress'}
                icon={<Radio size={20} />}
                tone={lk.mock ? 'warning' : 'success'}
              />
              <AssistantAdminStatCard
                label="SIP (Twilio ↔ LiveKit)"
                value={lk.sipConfigured ? 'Trunk configurado' : 'Sin trunk'}
                hint={
                  lk.sipDomain
                    ? `Dominio: ${lk.sipDomain}`
                    : 'LIVEKIT_SIP_TRUNK_ID / LIVEKIT_SIP_DOMAIN'
                }
                icon={<Phone size={20} />}
                tone={lk.sipConfigured ? 'success' : 'warning'}
              />
              <AssistantAdminStatCard
                label="Webhook Twilio"
                value={data.status.twilioWebhookConfigured ? 'Firma validada' : 'No configurado'}
                hint="TWILIO_AUTH_TOKEN + TWILIO_WEBHOOK_BASE_URL"
                icon={<ShieldCheck size={20} />}
                tone={data.status.twilioWebhookConfigured ? 'success' : 'warning'}
              />
              <AssistantAdminStatCard
                label="Agente de voz"
                value={
                  data.status.voiceAgent?.lastSeenAt
                    ? 'Conectado'
                    : lk.mock
                      ? 'Simulado'
                      : 'Sin actividad'
                }
                hint={
                  data.status.voiceAgent?.lastSeenAt
                    ? `Último contacto ${new Date(data.status.voiceAgent.lastSeenAt).toLocaleTimeString('es-MX')} · agente "${data.status.voiceAgent.agentName}"`
                    : `Despliega services/voice-agent con VOICE_AGENT_NAME="${data.status.voiceAgent?.agentName ?? 'unik-voice'}"`
                }
                icon={<Bot size={20} />}
                tone={data.status.voiceAgent?.lastSeenAt ? 'success' : 'warning'}
              />
              <AssistantAdminStatCard
                label="Egress → R2"
                value={lk.egressUsesDedicatedToken ? 'Token dedicado' : 'Token de almacenamiento'}
                hint={
                  lk.egressUsesDedicatedToken
                    ? 'R2_EGRESS_* (solo escritura)'
                    : 'Recomendado en producción: R2_EGRESS_ACCESS_KEY_ID / R2_EGRESS_SECRET_ACCESS_KEY de solo escritura'
                }
                icon={<Clock size={20} />}
                tone={lk.egressUsesDedicatedToken ? 'success' : 'default'}
              />
            </div>
            <div className="assistant-admin-section">
              <h3 className="assistant-admin-section-title">Límites conocidos</h3>
              <ul className="assistant-admin-muted">
                <li>
                  La IA habla en las llamadas a través del worker <code>services/voice-agent</code>{' '}
                  (OpenAI Realtime). Sin worker desplegado, las llamadas con &quot;IA atiende&quot;
                  entran pero la IA no habla; el ciclo STT→LLM→TTS por HTTP sigue disponible para
                  pruebas.
                </li>
                <li>
                  Cliente WebRTC en el navegador: requiere instalar <code>livekit-client</code>;
                  mientras tanto la UI muestra sala y token.
                </li>
                <li>
                  Susurro: LiveKit no enruta audio a un solo participante; el cliente de cada
                  participante debe ignorar pistas cuyo metadato <code>whisperTo</code> no lo
                  señale.
                </li>
              </ul>
            </div>
          </div>
        )}

        {tab === 'ai' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">
              <Bot size={16} /> IA en llamadas
            </h3>
            <div className="assistant-admin-config-grid">
              <div className="assistant-admin-config-field">
                <label htmlFor="voice-aiAnswerDefault">
                  La IA atiende llamadas entrantes (por defecto)
                </label>
                <input
                  id="voice-aiAnswerDefault"
                  type="checkbox"
                  checked={settings.aiAnswerDefault}
                  onChange={(e) => setSettings({ ...settings, aiAnswerDefault: e.target.checked })}
                />
                <span className="assistant-admin-config-hint">
                  Aplica a cuentas sin ajuste propio y a llamadas sin cuenta.
                </span>
              </div>
              <div className="assistant-admin-config-field">
                <label htmlFor="voice-copilotEnabled">Copiloto en llamadas humanas</label>
                <input
                  id="voice-copilotEnabled"
                  type="checkbox"
                  checked={settings.copilotEnabled}
                  onChange={(e) => setSettings({ ...settings, copilotEnabled: e.target.checked })}
                />
                <span className="assistant-admin-config-hint">
                  Escucha, transcribe y sugiere; nunca habla.
                </span>
              </div>
              <div className="assistant-admin-config-field">
                <label htmlFor="voice-copilotEveryN">Sugerencias cada N segmentos</label>
                <input
                  id="voice-copilotEveryN"
                  type="number"
                  min={1}
                  max={50}
                  value={settings.copilotEveryNSegments}
                  onChange={(e) =>
                    setSettings({ ...settings, copilotEveryNSegments: Number(e.target.value) })
                  }
                />
              </div>
              <div className="assistant-admin-config-field">
                <label htmlFor="voice-maxAiAnswerSeconds">
                  Máximo de segundos atendiendo antes de ofrecer transferencia
                </label>
                <input
                  id="voice-maxAiAnswerSeconds"
                  type="number"
                  min={30}
                  max={3600}
                  value={settings.maxAiAnswerSeconds}
                  onChange={(e) =>
                    setSettings({ ...settings, maxAiAnswerSeconds: Number(e.target.value) })
                  }
                />
              </div>
            </div>
            <h4 className="assistant-admin-section-title">Por cuenta telefónica</h4>
            {data.accounts.length === 0 ? (
              <div className="assistant-admin-empty">No hay cuentas Twilio registradas.</div>
            ) : (
              <div className="assistant-admin-table-wrap">
                <table className="assistant-admin-table">
                  <thead>
                    <tr>
                      <th>Cuenta</th>
                      <th>Número</th>
                      <th>Equipos</th>
                      <th>Estado</th>
                      <th>IA atiende</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.accounts.map((a) => {
                      const explicit = a.id in settings.aiAnswerByAccount;
                      const value = explicit
                        ? settings.aiAnswerByAccount[a.id]
                        : settings.aiAnswerDefault;
                      return (
                        <tr key={a.id}>
                          <td>{a.label}</td>
                          <td>{a.identifier}</td>
                          <td>
                            {a.teamKeys.length ? (
                              a.teamKeys.join(', ')
                            ) : (
                              <span className="assistant-admin-muted">
                                sin equipos (solo super admin supervisa)
                              </span>
                            )}
                          </td>
                          <td>
                            <span
                              className={`assistant-admin-badge ${a.status === 'active' ? 'assistant-admin-badge-success' : ''}`}
                            >
                              {a.status}
                            </span>
                          </td>
                          <td>
                            <select
                              aria-label={`IA atiende para ${a.label}`}
                              className="assistant-admin-filter-input"
                              value={explicit ? (value ? 'on' : 'off') : 'default'}
                              onChange={(e) => {
                                const next = { ...settings.aiAnswerByAccount };
                                if (e.target.value === 'default') delete next[a.id];
                                else next[a.id] = e.target.value === 'on';
                                setSettings({ ...settings, aiAnswerByAccount: next });
                              }}
                            >
                              <option value="default">
                                Por defecto ({settings.aiAnswerDefault ? 'sí' : 'no'})
                              </option>
                              <option value="on">Sí</option>
                              <option value="off">No</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <button
              type="button"
              className="assistant-admin-save-btn"
              onClick={save}
              disabled={saving}
            >
              <Save size={16} /> {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}

        {tab === 'recording' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Grabación y retención</h3>
            <div className="assistant-admin-config-grid">
              <div className="assistant-admin-config-field">
                <label htmlFor="voice-recordByDefault">
                  Grabar automáticamente al iniciar la llamada
                </label>
                <input
                  id="voice-recordByDefault"
                  type="checkbox"
                  checked={settings.recordByDefault}
                  onChange={(e) => setSettings({ ...settings, recordByDefault: e.target.checked })}
                />
                <span className="assistant-admin-config-hint">
                  El control de grabación sigue visible y puede detenerse en cualquier momento. La
                  grabación es independiente de la IA.
                </span>
              </div>
              <div className="assistant-admin-config-field">
                <label>Retención de grabaciones</label>
                <input
                  type="number"
                  value={data.retention.recordingRetentionDays}
                  readOnly
                  aria-readonly="true"
                />
                <span className="assistant-admin-config-hint">
                  Días. Se ajusta en Archivos → Cuotas y retención.
                </span>
              </div>
              <div className="assistant-admin-config-field">
                <label>Retención de transcripciones y resúmenes</label>
                <input
                  type="number"
                  value={data.retention.transcriptRetentionDays}
                  readOnly
                  aria-readonly="true"
                />
                <span className="assistant-admin-config-hint">
                  Días. Se ajusta en Archivos → Cuotas y retención.
                </span>
              </div>
            </div>
            <p className="assistant-admin-muted">
              Las grabaciones van directo de LiveKit Egress al bucket privado{' '}
              <code>recordings</code> de R2 y se reproducen solo por streaming autenticado. El job
              diario <code>voice.retention</code> elimina lo vencido.
            </p>
            <button
              type="button"
              className="assistant-admin-save-btn"
              onClick={save}
              disabled={saving}
            >
              <Save size={16} /> {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

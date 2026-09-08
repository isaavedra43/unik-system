'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Save, AlertCircle, CheckCircle2, Key, Cloud, Cpu, Check, X } from 'lucide-react';
import { updateAiConfigAction, toggleAiEnabledAction } from '@/app/app/admin/assistant/actions';

interface AiConfigData {
  id: string;
  key: string;
  isEnabled: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ProviderConfigEntry {
  apiKey: string;
  endpoint: string;
  enabled: boolean;
}

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI (ChatGPT API)', hint: 'GPT-4o, GPT-4o-mini, o1, etc.', implemented: true },
  { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'Claude Sonnet, Haiku, Opus (futuro)', implemented: false },
  { value: 'gemini', label: 'Google (Gemini)', hint: 'Gemini 2.0 Flash, etc. (futuro)', implemented: false },
  { value: 'local', label: 'Local (Ollama / LM Studio)', hint: 'Modelos locales en tu máquina (futuro)', implemented: false },
];

const SETTING_FIELDS: Array<{ key: string; label: string; type: 'number' | 'string' | 'boolean' | 'list' | 'textarea' | 'password'; hint?: string }> = [
  { key: 'deployment', label: 'Modelo principal (default)', type: 'string', hint: 'Ej: gpt-4o, gpt-4o-mini, gpt-4.1' },
  { key: 'fallbackDeployment', label: 'Modelo fallback', type: 'string', hint: 'Ej: gpt-4o-mini' },
  { key: 'temperature', label: 'Temperature', type: 'number', hint: '0.0 - 2.0' },
  { key: 'maxTokens', label: 'Max tokens por respuesta', type: 'number' },
  { key: 'maxMessagesPerMinute', label: 'Mensajes por minuto', type: 'number' },
  { key: 'maxTokensPerDay', label: 'Tokens por día', type: 'number' },
  { key: 'maxConversationMessages', label: 'Mensajes en contexto', type: 'number' },
  { key: 'maxToolIterations', label: 'Iteraciones de tools', type: 'number' },
  { key: 'systemPromptOverride', label: 'System prompt override', type: 'textarea', hint: 'Vacío = usar prompt default' },
  { key: 'enabledTools', label: 'Tools habilitados (uno por línea)', type: 'list' },
  { key: 'maxAttachmentSizeMb', label: 'Tamaño máx adjunto (MB)', type: 'number' },
  { key: 'allowedMimeTypes', label: 'MIME types permitidos (uno por línea)', type: 'list' },
  { key: 'artifactTtlHours', label: 'TTL artefactos (horas)', type: 'number' },
  { key: 'voiceEnabled', label: 'Voz habilitada', type: 'boolean' },
  { key: 'sttModel', label: 'Modelo STT', type: 'string' },
  { key: 'ttsVoice', label: 'Voz TTS', type: 'string' },
  { key: 'inputMaxLength', label: 'Longitud máx input', type: 'number' },
  { key: 'promptInjectionDetection', label: 'Detección prompt injection', type: 'boolean' },
  { key: 'autonomousModeEnabled', label: 'Modo autónomo', type: 'boolean' },
  { key: 'dailyReportHour', label: 'Hora reporte diario (0-23)', type: 'number' },
  { key: 'anomalyThreshold', label: 'Umbral anomalía', type: 'number' },
];

export function AssistantAdminConfig({ canManage }: { canManage: boolean }) {
  const [config, setConfig] = useState<AiConfigData | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/admin/assistant/api/config');
      if (res.ok) {
        const json = await res.json();
        setConfig(json);
        setSettings(json.settings ?? {});
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await updateAiConfigAction({ settings });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleEnabled() {
    setSaving(true);
    try {
      await toggleAiEnabledAction();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setSaving(false);
    }
  }

  function updateSetting(key: string, value: unknown) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  function updateProviderConfig(provider: string, field: keyof ProviderConfigEntry, value: unknown) {
    const current = (settings.providerConfigs as Record<string, ProviderConfigEntry>) ?? {};
    const entry = current[provider] ?? { apiKey: '', endpoint: '', enabled: false };
    const updated = {
      ...current,
      [provider]: { ...entry, [field]: value },
    };
    updateSetting('providerConfigs', updated);
  }

  if (loading) return <div className="assistant-admin-loading">Cargando…</div>;
  if (!config) return <div className="assistant-admin-error">No se pudo cargar la configuración</div>;

  const currentProvider = (settings.provider as string) || 'openai';
  const providerConfigs = (settings.providerConfigs as Record<string, ProviderConfigEntry>) ?? {};

  return (
    <div className="assistant-admin-tab">
      <div className="assistant-admin-config-status">
        <div className="assistant-admin-config-status-info">
          <span className={`assistant-admin-badge ${config.isEnabled ? 'assistant-admin-badge-success' : 'assistant-admin-badge-error'}`}>
            {config.isEnabled ? 'Activo' : 'Desactivado'}
          </span>
          <span className="assistant-admin-muted">
            Última actualización: {new Date(config.updatedAt).toLocaleString('es-MX')}
          </span>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={handleToggleEnabled}
            disabled={saving}
            className="assistant-admin-config-toggle"
          >
            {config.isEnabled ? 'Desactivar' : 'Activar'}
          </button>
        )}
      </div>

      {/* ===== Sección: Multi-provider ===== */}
      <div className="assistant-admin-config-section">
        <h3 className="assistant-admin-section-title">
          <Cloud size={18} /> Proveedores de IA
        </h3>
        <p className="assistant-admin-config-hint" style={{ marginBottom: 16 }}>
          Configura múltiples proveedores a la vez. Los usuarios podrán seleccionar el modelo en cada conversación.
          Solo los proveedores con API key configurada aparecerán en el selector del chat.
        </p>

        {/* Default provider selector */}
        <div className="assistant-admin-config-grid" style={{ marginBottom: 16 }}>
          <div className="assistant-admin-config-field">
            <label htmlFor="cfg-provider">Proveedor default</label>
            <select
              id="cfg-provider"
              value={currentProvider}
              onChange={(e) => updateSetting('provider', e.target.value)}
              disabled={!canManage}
              className="assistant-admin-select"
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="assistant-admin-config-hint">
              Se usa cuando el usuario no selecciona un modelo específico
            </span>
          </div>
        </div>

        {/* Multi-provider cards */}
        <div className="provider-cards-grid">
          {PROVIDER_OPTIONS.map((opt) => {
            const entry = providerConfigs[opt.value] ?? { apiKey: '', endpoint: '', enabled: false };
            const isConfigured = Boolean(entry.apiKey) || (opt.value === 'local' && Boolean(entry.endpoint));
            return (
              <div key={opt.value} className={`provider-card ${entry.enabled ? 'provider-card-enabled' : ''}`}>
                <div className="provider-card-header">
                  <div className="provider-card-title">
                    <span className="provider-card-name">{opt.label}</span>
                    {!opt.implemented && (
                      <span className="provider-card-badge provider-card-badge-future">Futuro</span>
                    )}
                    {isConfigured && (
                      <span className="provider-card-badge provider-card-badge-ok">
                        <Check size={12} /> Configurado
                      </span>
                    )}
                  </div>
                  <label className="provider-card-toggle">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onChange={(e) => updateProviderConfig(opt.value, 'enabled', e.target.checked)}
                      disabled={!canManage}
                    />
                    <span>Habilitar</span>
                  </label>
                </div>
                <p className="provider-card-hint">{opt.hint}</p>
                <div className="provider-card-fields">
                  <div className="provider-card-field">
                    <label htmlFor={`cfg-${opt.value}-apiKey`}>
                      <Key size={12} style={{ display: 'inline', marginRight: 4 }} />
                      API Key
                    </label>
                    <input
                      id={`cfg-${opt.value}-apiKey`}
                      type="password"
                      value={entry.apiKey ?? ''}
                      onChange={(e) => updateProviderConfig(opt.value, 'apiKey', e.target.value)}
                      disabled={!canManage}
                      placeholder={isConfigured ? '•••••••••••••••• (configurada)' : `Pega tu API key de ${opt.label}`}
                    />
                    <span className="assistant-admin-config-hint">
                      {isConfigured
                        ? '✓ Configurada. Deja vacío para mantener.'
                        : 'Pega tu API key aquí'}
                    </span>
                  </div>
                  <div className="provider-card-field">
                    <label htmlFor={`cfg-${opt.value}-endpoint`}>Endpoint (opcional)</label>
                    <input
                      id={`cfg-${opt.value}-endpoint`}
                      type="text"
                      value={entry.endpoint ?? ''}
                      onChange={(e) => updateProviderConfig(opt.value, 'endpoint', e.target.value)}
                      disabled={!canManage}
                      placeholder="Vacío = endpoint default"
                    />
                  </div>
                </div>
                {!opt.implemented && (
                  <p className="provider-card-warning">
                    <AlertCircle size={12} /> Este proveedor aún no está implementado. La arquitectura está lista.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ===== Sección: Modelo y comportamiento ===== */}
      <div className="assistant-admin-config-section">
        <h3 className="assistant-admin-section-title">
          <Cpu size={18} /> Modelo y comportamiento
        </h3>
        <div className="assistant-admin-config-grid">
          {SETTING_FIELDS.map((field) => (
            <div key={field.key} className="assistant-admin-config-field">
              <label htmlFor={`cfg-${field.key}`}>{field.label}</label>
              {field.type === 'boolean' ? (
                <input
                  id={`cfg-${field.key}`}
                  type="checkbox"
                  checked={Boolean(settings[field.key])}
                  onChange={(e) => updateSetting(field.key, e.target.checked)}
                  disabled={!canManage}
                />
              ) : field.type === 'textarea' ? (
                <textarea
                  id={`cfg-${field.key}`}
                  value={String(settings[field.key] ?? '')}
                  onChange={(e) => updateSetting(field.key, e.target.value)}
                  disabled={!canManage}
                  rows={4}
                />
              ) : field.type === 'list' ? (
                <textarea
                  id={`cfg-${field.key}`}
                  value={Array.isArray(settings[field.key]) ? (settings[field.key] as string[]).join('\n') : String(settings[field.key] ?? '')}
                  onChange={(e) => updateSetting(field.key, e.target.value.split('\n').filter(Boolean))}
                  disabled={!canManage}
                  rows={4}
                />
              ) : (
                <input
                  id={`cfg-${field.key}`}
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={String(settings[field.key] ?? '')}
                  onChange={(e) => updateSetting(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                  disabled={!canManage}
                />
              )}
              {field.hint && <span className="assistant-admin-config-hint">{field.hint}</span>}
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="assistant-admin-error">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {success && (
        <div className="assistant-admin-success">
          <CheckCircle2 size={16} /> Configuración guardada
        </div>
      )}

      {canManage && (
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="assistant-admin-save-btn"
        >
          {saving ? <span className="spinner" /> : <Save size={16} />}
          Guardar configuración
        </button>
      )}
    </div>
  );
}

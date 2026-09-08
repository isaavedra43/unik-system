'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Save, AlertCircle, CheckCircle2 } from 'lucide-react';
import { updateAiConfigAction, toggleAiEnabledAction } from '@/app/app/admin/assistant/actions';

interface AiConfigData {
  id: string;
  key: string;
  isEnabled: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const SETTING_FIELDS: Array<{ key: string; label: string; type: 'number' | 'string' | 'boolean' | 'list' | 'textarea'; hint?: string }> = [
  { key: 'deployment', label: 'Deployment principal', type: 'string' },
  { key: 'fallbackDeployment', label: 'Deployment fallback', type: 'string' },
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

  if (loading) return <div className="assistant-admin-loading">Cargando…</div>;
  if (!config) return <div className="assistant-admin-error">No se pudo cargar la configuración</div>;

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

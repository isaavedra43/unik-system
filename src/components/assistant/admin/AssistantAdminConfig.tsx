'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Save, AlertCircle, CheckCircle2, Key, Cloud, Cpu, Check, Globe } from 'lucide-react';
import { updateAiConfigAction, toggleAiEnabledAction } from '@/app/app/admin/assistant/actions';
import { CANOPY_PLAN_MODELS, CanopyWaveSetup } from './CanopyWaveSetup';
import { ModelPolicyConfig } from './ModelPolicyConfig';

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
  /** Read-only, from the API: a key is stored (the key itself is never sent back). */
  hasApiKey?: boolean;
  /** Model ids the key reported (written by "Probar y detectar modelos"). */
  models?: string[];
}

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI (ChatGPT API)', hint: 'GPT-4o, GPT-4o-mini, o1, etc.', implemented: true },
  {
    value: 'canopywave',
    label: 'Canopy Wave',
    hint: 'Kimi K2.6 y MiniMax M3 de tu plan Unlimited, y cualquier otro modelo de tu cuenta. API compatible con OpenAI.',
    implemented: true,
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    hint: 'Acceso a cientos de modelos (Claude, Gemini, DeepSeek, Jev…) con una sola API key. Necesario para las decisiones Jev.',
    implemented: true,
  },
  { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'Claude Sonnet, Haiku, Opus (futuro)', implemented: false },
  { value: 'gemini', label: 'Google (Gemini)', hint: 'Gemini 2.0 Flash, etc. (futuro)', implemented: false },
  { value: 'local', label: 'Local (Ollama / LM Studio)', hint: 'Modelos locales en tu máquina (futuro)', implemented: false },
];

const SETTING_FIELDS: Array<{ key: string; label: string; type: 'number' | 'string' | 'boolean' | 'list' | 'textarea' | 'password'; hint?: string }> = [
  { key: 'temperature', label: 'Temperature', type: 'number', hint: '0.0 - 2.0' },
  { key: 'maxTokens', label: 'Max tokens por respuesta', type: 'number' },
  { key: 'maxMessagesPerMinute', label: 'Mensajes por minuto', type: 'number' },
  { key: 'maxTokensPerDay', label: 'Tokens por día', type: 'number' },
  { key: 'maxConversationMessages', label: 'Mensajes en contexto', type: 'number' },
  { key: 'maxToolIterations', label: 'Iteraciones de tools', type: 'number' },
  { key: 'systemPromptOverride', label: 'System prompt override', type: 'textarea', hint: 'Vacío = usar prompt default' },
  { key: 'enabledTools', label: 'Tools habilitados (uno por línea)', type: 'list', hint: 'Para internet/venue agrega: web_search, fetch_url, web_crawl, browser, browserProfile, venueExec, venueReadFile, venueListFiles, venueWriteFile, venueScreenshot' },
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
  // Perfil de la empresa (lo usa la IA para ubicación de recogida, firmas y mensajes)
  { key: 'companyName', label: 'Nombre de la empresa', type: 'string', hint: 'Cómo se presenta la IA ante clientes' },
  { key: 'companyPhone', label: 'Teléfono de la empresa', type: 'string' },
  { key: 'warehouseAddress', label: 'Dirección de bodega / recogida', type: 'textarea', hint: 'Calle, número, colonia, ciudad, CP' },
  { key: 'warehouseMapsUrl', label: 'Enlace de Google Maps de la bodega', type: 'string', hint: 'Vacío = se genera desde la dirección' },
  { key: 'warehouseHours', label: 'Horario de recogida', type: 'string', hint: 'Ej. Lun-Vie 9:00-18:00, Sáb 9:00-14:00' },
  { key: 'pickupInstructions', label: 'Instrucciones para recoger', type: 'textarea', hint: 'Ej. Presentar folio y nombre; entrada por la puerta 2' },
  // Inteligencia: routing, herramientas por turno, caché, RAG, OCR y calidad
  { key: 'maxToolsPerTurn', label: 'Tools ofrecidas por turno', type: 'number', hint: 'Máximo 128 (límite de OpenAI). Las demás se cargan bajo demanda con loadMoreTools' },
  { key: 'toolCacheEnabled', label: 'Caché de consultas de lectura', type: 'boolean', hint: 'Dos usuarios que preguntan lo mismo en segundos comparten el resultado' },
  { key: 'toolCacheTtlLiveSeconds', label: 'Caché datos vivos (segundos)', type: 'number', hint: 'Hoy, esta semana, sin periodo' },
  { key: 'toolCacheTtlHistoricalSeconds', label: 'Caché datos históricos (segundos)', type: 'number', hint: 'Meses y años cerrados' },
  { key: 'ragSemanticEnabled', label: 'Búsqueda semántica en biblioteca', type: 'boolean', hint: 'Embeddings de OpenAI + búsqueda híbrida (palabras + significado)' },
  { key: 'embeddingModel', label: 'Modelo de embeddings', type: 'string', hint: 'text-embedding-3-small' },
  { key: 'ragRerankEnabled', label: 'Re-ranking con modelo', type: 'boolean', hint: 'Más preciso; una llamada extra por búsqueda' },
  { key: 'ocrFallbackEnabled', label: 'OCR de PDF escaneados (visión)', type: 'boolean', hint: 'Si el PDF no tiene texto, el modelo lo lee como imagen' },
  { key: 'qualityJudgeEnabled', label: 'Juez de calidad automático', type: 'boolean', hint: 'Califica cada respuesta (1-5) con un modelo barato después de entregarla' },
  { key: 'reasoningEffort', label: 'Razonamiento en tareas complejas', type: 'string', hint: 'low | medium | high — solo aplica a modelos que piensan (GPT-5, o-series)' },
  { key: 'answerReviewEnabled', label: 'Revisión interna de respuestas complejas', type: 'boolean', hint: 'Solo con modelos que no razonan (GPT-4o, Kimi): un revisor detecta faltantes o cifras que no cuadran y el modelo corrige una vez. GPT-5 ya revisa mientras piensa' },
  { key: 'learningCaptureEnabled', label: 'Aprender de correcciones', type: 'boolean', hint: 'Cuando el usuario corrige a la IA o define un término ("Recolección significa…"), se propone como recuerdo pendiente que él confirma en Preferencias y memoria' },
];

/** Sección "Internet y Agentes": Jev, web tools y computadora virtual. */
const AGENT_SETTING_FIELDS: Array<{ key: string; label: string; type: 'number' | 'string' | 'boolean' | 'list' | 'textarea' | 'password'; hint?: string }> = [
  { key: 'jevEnabled', label: 'Decisiones Jev (OpenRouter)', type: 'boolean', hint: 'Micro-decisiones baratas y tipadas (typesafe/jev-1.13): routing, revisión, juez, filtros de inyección. Requiere API key de OpenRouter. Si falla, el sistema usa el comportamiento actual.' },
  { key: 'jevModel', label: 'Modelo Jev', type: 'string', hint: 'typesafe/jev-1.13' },
  { key: 'jevMinConfidence', label: 'Confianza mínima Jev', type: 'number', hint: '0.0 - 1.0 (default 0.7). Debajo se usa el fallback normal.' },
  { key: 'webSearchEnabled', label: 'Búsqueda web (web_search)', type: 'boolean', hint: 'Permite al asistente buscar en internet con citas. Requiere API key del proveedor.' },
  { key: 'webSearchProvider', label: 'Proveedor de búsqueda', type: 'string', hint: 'tavily' },
  { key: 'webSearchApiKey', label: 'API key de búsqueda', type: 'password', hint: 'Tavily (o TAVILY_API_KEY en env). Nunca sale del servidor.' },
  { key: 'webFetchEnabled', label: 'Lectura de páginas (fetch_url / web_crawl)', type: 'boolean', hint: 'Abre URLs públicas https con protección anti-SSRF, redirects revalidados y extracción a texto legible.' },
  { key: 'webDomainAllowlist', label: 'Allowlist de dominios (uno por línea)', type: 'list', hint: 'Vacía = toda la web pública. Con entradas, SOLO esos dominios se pueden abrir — también limita la red del sandbox.' },
  { key: 'webDomainDenylist', label: 'Denylist de dominios (uno por línea)', type: 'list', hint: 'Siempre bloqueados, aunque la allowlist esté vacía.' },
  { key: 'webFetchMaxBytes', label: 'Bytes máx por página', type: 'number', hint: 'Default 2,000,000' },
  { key: 'browserEnabled', label: 'Navegador del agente', type: 'boolean', hint: 'Tool browser dentro del venue: navegar, click, escribir, extraer, screenshot. Acciones externas (enviar/comprar/publicar) siempre piden aprobación.' },
  { key: 'venueEnabled', label: 'Computadora virtual (Daytona)', type: 'boolean', hint: 'Sandbox desechable para browser + exec. Requiere DAYTONA_API_KEY y snapshot con chromium (venueImage).' },
  { key: 'venueProvider', label: 'Proveedor de venue', type: 'string', hint: 'daytona' },
  { key: 'venueImage', label: 'Snapshot/imagen del venue', type: 'string', hint: 'Snapshot Daytona con node + playwright-core + chromium (p. ej. unik-browser-1)' },
  { key: 'venueMaxConcurrent', label: 'Venues simultáneos máx', type: 'number' },
  { key: 'venueMaxMinutesPerDay', label: 'Minutos de venue por día', type: 'number', hint: 'Presupuesto diario compartido — se agota y las tools devuelven aviso.' },
  { key: 'venueIdleTimeoutMinutes', label: 'Auto-apagado por inactividad (min)', type: 'number', hint: 'El reaper apaga venues sin uso cada 5 min.' },
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

  /** Kimi K2.6 as main model, MiniMax M3 for fallback/simple tasks/judge (all in the flat plan). */
  function useCanopyWaveAsDefault() {
    const [main, secondary] = CANOPY_PLAN_MODELS;
    setSettings((prev) => {
      const configs = (prev.providerConfigs as Record<string, ProviderConfigEntry>) ?? {};
      const entry = configs.canopywave ?? { apiKey: '', endpoint: '', enabled: false };
      return {
        ...prev,
        provider: 'canopywave',
        deployment: main.id,
        fallbackDeployment: secondary.id,
        routingSimpleModel: secondary.id,
        routingStandardModel: main.id,
        routingComplexModel: main.id,
        utilityModel: secondary.id,
        qualityJudgeModel: secondary.id,
        providerConfigs: { ...configs, canopywave: { ...entry, enabled: true } },
      };
    });
  }

  function renderSettingField(field: { key: string; label: string; type: string; hint?: string }) {
    return (
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
            type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'}
            value={String(settings[field.key] ?? '')}
            onChange={(e) => updateSetting(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
            disabled={!canManage}
            placeholder={
              field.type === 'password' && (settings[field.key] || settings[`has${field.key[0].toUpperCase()}${field.key.slice(1)}`])
                ? '•••••••••••••••• (configurada)'
                : undefined
            }
          />
        )}
        {field.hint && <span className="assistant-admin-config-hint">{field.hint}</span>}
      </div>
    );
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
            const isConfigured =
              Boolean(entry.apiKey) || Boolean(entry.hasApiKey) || (opt.value === 'local' && Boolean(entry.endpoint));
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
                        ? '✓ Configurada. Deja vacío para mantener la actual.'
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
                      placeholder={opt.value === 'canopywave' ? 'Vacío = https://inference.canopywave.io/v1' : 'Vacío = endpoint default'}
                    />
                  </div>
                </div>
                {opt.value === 'canopywave' && (
                  <CanopyWaveSetup
                    canManage={canManage}
                    hasSavedKey={Boolean(entry.hasApiKey)}
                    hasUnsavedKey={Boolean(entry.apiKey)}
                    discoveredModels={entry.models ?? []}
                    isDefault={currentProvider === 'canopywave'}
                    onSave={handleSave}
                    onReload={load}
                    onUseAsDefault={useCanopyWaveAsDefault}
                  />
                )}
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

      {/* ===== Sección: Reparto de modelos ===== */}
      <ModelPolicyConfig
        settings={settings}
        canManage={canManage}
        canopyConfigured={Boolean(providerConfigs.canopywave?.hasApiKey || providerConfigs.canopywave?.apiKey)}
        openaiConfigured={Boolean(providerConfigs.openai?.hasApiKey || providerConfigs.openai?.apiKey || settings.hasApiKey)}
        onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
      />

      {/* ===== Sección: Modelo y comportamiento ===== */}
      <div className="assistant-admin-config-section">
        <h3 className="assistant-admin-section-title">
          <Cpu size={18} /> Modelo y comportamiento
        </h3>
        <div className="assistant-admin-config-grid">
          {SETTING_FIELDS.map(renderSettingField)}
        </div>
      </div>

      {/* ===== Sección: Internet y Agentes ===== */}
      <div className="assistant-admin-config-section">
        <h3 className="assistant-admin-section-title">
          <Globe size={18} /> Internet y Agentes
        </h3>
        <p className="assistant-admin-config-hint" style={{ marginBottom: 16 }}>
          Capa de agentes: decisiones Jev (OpenRouter), acceso a internet solo-lectura y la
          computadora virtual Daytona donde el navegador y los comandos corren aislados.
          Todo nace desactivado; las acciones externas siempre pasan por aprobación.
        </p>
        <div className="assistant-admin-config-grid">
          {AGENT_SETTING_FIELDS.map(renderSettingField)}
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

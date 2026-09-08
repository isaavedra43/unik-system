'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AlertCircle, CheckCircle2, RefreshCw, Zap } from 'lucide-react';
import { testAiConnectionAction } from '@/app/app/admin/assistant/actions';

interface HealthData {
  provider: string;
  providerLabel: string;
  isConfigured: boolean;
  hasApiKey: boolean;
  hasEndpoint: boolean;
  hasModel: boolean;
  model: string;
  fallbackModel: string;
  endpoint: string;
  isEnabled: boolean;
  missingVars: string[];
  recentErrors: Array<{ id: string; errorCode: string | null; deployment: string; createdAt: string }>;
}

interface TestResult {
  success: boolean;
  deployment?: string;
  latencyMs?: number;
  tokensUsed?: number;
  error?: string;
  errorCode?: string;
}

export function AssistantAdminHealth({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/admin/assistant/api/health');
      if (res.ok) {
        setData(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAiConnectionAction();
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : 'Error' });
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <div className="assistant-admin-loading">Cargando…</div>;
  if (!data) return <div className="assistant-admin-error">No se pudo cargar el estado</div>;

  return (
    <div className="assistant-admin-tab">
      <div className="assistant-admin-health-grid">
        <div className={`assistant-admin-health-card ${data.isEnabled ? 'ok' : 'warn'}`}>
          <div className="assistant-admin-health-card-icon">
            {data.isEnabled ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
          </div>
          <div>
            <div className="assistant-admin-health-card-label">Estado del asistente</div>
            <div className="assistant-admin-health-card-value">
              {data.isEnabled ? 'Activo' : 'Desactivado'}
            </div>
          </div>
        </div>

        <div className={`assistant-admin-health-card ${data.isConfigured ? 'ok' : 'error'}`}>
          <div className="assistant-admin-health-card-icon">
            {data.isConfigured ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
          </div>
          <div>
            <div className="assistant-admin-health-card-label">Configuración IA</div>
            <div className="assistant-admin-health-card-value">
              {data.isConfigured ? 'Completa' : 'Incompleta'}
            </div>
          </div>
        </div>

        <div className="assistant-admin-health-card">
          <div className="assistant-admin-health-card-icon"><Zap size={20} /></div>
          <div>
            <div className="assistant-admin-health-card-label">Proveedor</div>
            <div className="assistant-admin-health-card-value">{data.providerLabel}</div>
          </div>
        </div>

        <div className="assistant-admin-health-card">
          <div className="assistant-admin-health-card-icon"><Zap size={20} /></div>
          <div>
            <div className="assistant-admin-health-card-label">Modelo</div>
            <div className="assistant-admin-health-card-value">{data.model}</div>
          </div>
        </div>
      </div>

      {data.missingVars.length > 0 && (
        <div className="assistant-admin-health-missing">
          <AlertCircle size={16} />
          <div>
            <strong>Variables de entorno faltantes:</strong>
            <ul>
              {data.missingVars.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="assistant-admin-health-section">
        <h3 className="assistant-admin-section-title">Test de conexión</h3>
        {canManage && (
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="assistant-admin-test-btn"
          >
            {testing ? <span className="spinner" /> : <RefreshCw size={16} />}
            Probar conexión
          </button>
        )}
        {testResult && (
          <div className={`assistant-admin-test-result ${testResult.success ? 'ok' : 'error'}`}>
            {testResult.success ? (
              <>
                <CheckCircle2 size={16} />
                <span>Conexión exitosa · {testResult.latencyMs}ms · {testResult.tokensUsed} tokens</span>
              </>
            ) : (
              <>
                <AlertCircle size={16} />
                <span>Error: {testResult.error} ({testResult.errorCode})</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="assistant-admin-health-section">
        <h3 className="assistant-admin-section-title">Errores recientes</h3>
        <div className="assistant-admin-list">
          {data.recentErrors.length === 0 && <div className="assistant-admin-empty">Sin errores recientes</div>}
          {data.recentErrors.map((e) => (
            <div key={e.id} className="assistant-admin-list-item">
              <span className="assistant-admin-list-name">{e.errorCode ?? 'unknown'}</span>
              <span className="assistant-admin-list-meta">{e.deployment}</span>
              <span className="assistant-admin-list-count">{new Date(e.createdAt).toLocaleString('es-MX')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

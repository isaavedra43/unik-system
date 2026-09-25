'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Plug, Unlink } from 'lucide-react';

interface Toolkit {
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  isNoAuth: boolean;
  connectedAccountId: string | null;
}

/**
 * "Mis apps": the external apps (Composio) an administrator enabled for the
 * user's role. Each person connects their OWN account; the assistant then acts
 * with it. Tokens stay in Composio.
 */
export function ComposioUserSection({ canConnect }: { canConnect: boolean }) {
  const [toolkits, setToolkits] = useState<Toolkit[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/assistant/api/composio/toolkits');
      const data = (await res.json()) as {
        configured?: boolean;
        toolkits?: Toolkit[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? 'No se pudieron cargar tus apps');
      setConfigured(data.configured !== false);
      setToolkits(data.toolkits ?? []);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudieron cargar tus apps');
      setToolkits([]);
    }
  }, []);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const outcome = p.get('composio');
    if (outcome === 'done')
      setMessage('Revisamos tu conexión: si autorizaste el acceso verás la app como conectada.');
    if (outcome === 'failed')
      setMessage('La autorización no se completó. Puedes intentarlo de nuevo.');
    void load();
  }, [load]);

  async function connect(slug: string) {
    setBusy(slug);
    setMessage(null);
    try {
      const res = await fetch('/app/assistant/api/composio/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit: slug }),
      });
      const data = (await res.json()) as { redirectUrl?: string; error?: string };
      if (!res.ok || !data.redirectUrl)
        throw new Error(data.error ?? 'No se pudo iniciar la conexión');
      window.location.href = data.redirectUrl;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo iniciar la conexión');
      setBusy(null);
    }
  }

  async function disconnect(t: Toolkit) {
    if (
      !t.connectedAccountId ||
      !window.confirm(`¿Desconectar tu cuenta de ${t.name}? El asistente dejará de poder usarla.`)
    )
      return;
    setBusy(t.slug);
    try {
      const res = await fetch(
        `/app/assistant/api/composio/connections/${encodeURIComponent(t.connectedAccountId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok)
        throw new Error(
          ((await res.json().catch(() => ({}))) as { error?: string }).error ??
            'No se pudo desconectar'
        );
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No se pudo desconectar');
    } finally {
      setBusy(null);
    }
  }

  if (!configured || toolkits === null || (toolkits.length === 0 && !message)) return null;

  return (
    <div className="assistant-admin-section">
      <h3 className="assistant-admin-section-title">Mis apps</h3>
      <p className="assistant-admin-muted">
        Conecta tu propia cuenta y el asistente podrá leer y actuar en tu nombre. Enviar, crear o
        borrar siempre te pide aprobación.
      </p>
      {message && (
        <div className="assistant-admin-success" role="status">
          {message}
        </div>
      )}
      <ul className="gui-records">
        {toolkits.map((t) => (
          <li key={t.slug} className="gui-record">
            <div className="gui-record-top">
              <span className="gui-record-title">{t.name}</span>
              {t.connected ? (
                <span className="gui-badge is-success">
                  <CheckCircle2 size={11} /> Conectada
                </span>
              ) : (
                <span className="gui-badge">Sin conectar</span>
              )}
            </div>
            <div className="gui-pending-actions">
              {!t.connected && (
                <button
                  type="button"
                  className="gui-btn gui-btn-primary"
                  disabled={!canConnect || busy === t.slug}
                  onClick={() => void connect(t.slug)}
                >
                  {busy === t.slug ? (
                    <Loader2 size={12} className="copilot-spin" />
                  ) : (
                    <Plug size={12} />
                  )}{' '}
                  Conectar
                </button>
              )}
              {t.connected && t.connectedAccountId && !t.isNoAuth && (
                <button
                  type="button"
                  className="gui-btn"
                  disabled={!canConnect || busy === t.slug}
                  onClick={() => void disconnect(t)}
                >
                  <Unlink size={12} /> Desconectar
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!canConnect && (
        <p className="assistant-admin-muted">
          Tu rol no incluye el permiso para conectar cuentas propias.
        </p>
      )}
    </div>
  );
}

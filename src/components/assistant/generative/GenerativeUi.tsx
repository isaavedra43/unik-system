'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  Plug,
  XCircle,
} from 'lucide-react';
import type { UiComponent, UiRecord, UiTone } from '@/modules/ai/generative-ui/types';

// The MCP-UI renderer is only loaded when a server actually sends a component.
const McpUiFrame = dynamic(() => import('./McpUiFrame'), {
  ssr: false,
  loading: () => <div className="gui-card gui-skeleton" aria-busy="true" />,
});

// Recharts is heavy — the chart view loads only when a renderView spec emits one.
const ViewChart = dynamic(() => import('./ViewChart'), {
  ssr: false,
  loading: () => <div className="gui-card gui-skeleton" aria-busy="true" />,
});

// Sandbox bridge (postMessage + confirm bar) — only mounts when the agent draws one.
const InteractiveUiFrame = dynamic(
  () => import('./InteractiveUiFrame').then((m) => m.InteractiveUiFrame),
  { ssr: false, loading: () => <div className="gui-card gui-skeleton" aria-busy="true" /> }
);

const dateFmt = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' });

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayFmt.format(d) : dateFmt.format(d);
}

const TONE_ICON: Record<UiTone, React.ReactNode> = {
  neutral: <Info size={14} />,
  info: <Info size={14} />,
  success: <CheckCircle2 size={14} />,
  warning: <AlertTriangle size={14} />,
  danger: <XCircle size={14} />,
};

function Source({ source }: { source?: string }) {
  return source ? <span className="gui-source">{source}</span> : null;
}

function RecordRow({ record }: { record: UiRecord }) {
  const heading = record.url ? (
    <a
      href={record.url}
      target="_blank"
      rel="noopener noreferrer"
      className="gui-record-title gui-link"
    >
      {record.title} <ExternalLink size={11} aria-hidden="true" />
    </a>
  ) : (
    <span className="gui-record-title">{record.title}</span>
  );
  return (
    <li className="gui-record">
      <div className="gui-record-top">
        {heading}
        {record.badge && (
          <span className={`gui-badge is-${record.badge.tone}`}>{record.badge.label}</span>
        )}
      </div>
      {(record.subtitle || record.date) && (
        <div className="gui-record-meta">
          {record.subtitle && <span>{record.subtitle}</span>}
          {record.date && <time dateTime={record.date}>{formatDate(record.date)}</time>}
        </div>
      )}
      {record.body && <p className="gui-record-body">{record.body}</p>}
      {record.fields && record.fields.length > 0 && (
        <dl className="gui-fields">
          {record.fields.map((f) => (
            <div key={f.label} className="gui-field">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function ConnectCard({
  toolkit,
  name,
  connected,
  onSendText,
  interactive,
}: {
  toolkit: string;
  name: string;
  connected: boolean;
  onSendText?: (t: string) => void;
  interactive: boolean;
}) {
  const [state, setState] = useState<'idle' | 'opening' | 'waiting' | 'connected' | 'error'>(
    connected ? 'connected' : 'idle'
  );
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const announced = useRef(false);

  const check = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(
        `/app/assistant/api/composio/toolkits?search=${encodeURIComponent(toolkit)}`
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { toolkits?: Array<{ slug: string; connected: boolean }> };
      return Boolean(data.toolkits?.some((t) => t.slug === toolkit && t.connected));
    } catch {
      return false;
    }
  }, [toolkit]);

  useEffect(() => {
    let alive = true;
    if (state === 'idle') {
      void check().then((ok) => {
        if (alive && ok) setState('connected');
      });
    }
    return () => {
      alive = false;
    };
    // Only on mount: a card loaded from history reflects the real state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    []
  );

  useEffect(() => {
    if (state !== 'waiting') return;
    const started = Date.now();
    timer.current = setInterval(async () => {
      if (Date.now() - started > 3 * 60_000) {
        if (timer.current) clearInterval(timer.current);
        setState('idle');
        setMessage('No detectamos la conexión. Puedes intentarlo de nuevo.');
        return;
      }
      if (await check()) {
        if (timer.current) clearInterval(timer.current);
        setState('connected');
        if (interactive && !announced.current) {
          announced.current = true;
          onSendText?.(`Ya conecté ${name}, continúa con lo que te pedí.`);
        }
      }
    }, 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [state, check, interactive, name, onSendText]);

  async function start() {
    setState('opening');
    setMessage(null);
    try {
      const res = await fetch('/app/assistant/api/composio/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit }),
      });
      const data = (await res.json()) as { redirectUrl?: string; error?: string };
      if (!res.ok || !data.redirectUrl) {
        setState('error');
        setMessage(data.error ?? 'No se pudo iniciar la conexión');
        return;
      }
      window.open(data.redirectUrl, '_blank', 'noopener,noreferrer');
      setState('waiting');
    } catch {
      setState('error');
      setMessage('No se pudo iniciar la conexión');
    }
  }

  return (
    <div
      className={`gui-card gui-connect is-${state}`}
      role="group"
      aria-label={`Conectar ${name}`}
    >
      <span className="gui-connect-icon">
        {state === 'connected' ? <CheckCircle2 size={18} /> : <Plug size={18} />}
      </span>
      <div className="gui-connect-text">
        <div className="gui-title">
          {state === 'connected' ? `${name} conectado` : `Conecta tu cuenta de ${name}`}
        </div>
        <div className="gui-muted">
          {state === 'connected' && 'Listo: el asistente ya puede usarla en tu nombre.'}
          {state === 'waiting' &&
            'Completa el acceso en la pestaña que se abrió; aquí se actualizará solo.'}
          {(state === 'idle' || state === 'opening') &&
            'Autorizas con tu propia cuenta; UNIK no guarda tu contraseña ni tus tokens.'}
          {state === 'error' && (message ?? 'Ocurrió un error')}
          {state === 'idle' && message}
        </div>
      </div>
      {state !== 'connected' && (
        <button
          type="button"
          className="gui-btn gui-btn-primary"
          onClick={() => void start()}
          disabled={state === 'opening' || state === 'waiting'}
        >
          {state === 'opening' || state === 'waiting' ? (
            <Loader2 size={13} className="copilot-spin" />
          ) : (
            <Plug size={13} />
          )}
          {state === 'waiting' ? 'Esperando…' : `Conectar ${name}`}
        </button>
      )}
    </div>
  );
}

export function GenerativeUi({
  components,
  onSendText,
  interactive = false,
}: {
  components: UiComponent[];
  onSendText?: (text: string) => void;
  interactive?: boolean;
}) {
  if (components.length === 0) return null;
  return (
    <div className="gui-stack">
      {components.map((c, i) => {
        switch (c.type) {
          case 'connect':
            return (
              <ConnectCard
                key={i}
                toolkit={c.toolkit}
                name={c.name}
                connected={c.connected}
                onSendText={onSendText}
                interactive={interactive}
              />
            );
          case 'records':
            return (
              <section key={i} className="gui-card" aria-label={c.heading ?? 'Resultados'}>
                <div className="gui-head">
                  <span className="gui-title">{c.heading ?? 'Resultados'}</span>
                  <Source source={c.source} />
                </div>
                <ul className="gui-records">
                  {c.items.map((r, j) => (
                    <RecordRow key={j} record={r} />
                  ))}
                </ul>
                {c.total > c.items.length && (
                  <div className="gui-foot">
                    Mostrando {c.items.length} de {c.total}
                  </div>
                )}
              </section>
            );
          case 'record':
            return (
              <section key={i} className="gui-card">
                <div className="gui-head">
                  <span className="gui-title">Detalle</span>
                  <Source source={c.source} />
                </div>
                <ul className="gui-records">
                  <RecordRow record={c.record} />
                </ul>
              </section>
            );
          case 'table':
            return (
              <section key={i} className="gui-card" aria-label={c.heading ?? 'Tabla'}>
                <div className="gui-head">
                  <span className="gui-title">{c.heading ?? 'Tabla'}</span>
                  <Source source={c.source} />
                </div>
                <div className="gui-table-wrap">
                  <table className="gui-table">
                    <thead>
                      <tr>
                        {c.columns.map((col, j) => (
                          <th key={j} scope="col">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {c.rows.map((row, j) => (
                        <tr key={j}>
                          {row.map((cell, k) => (
                            <td key={k}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {c.total > c.rows.length && (
                  <div className="gui-foot">
                    Mostrando {c.rows.length} de {c.total} filas
                  </div>
                )}
              </section>
            );
          case 'notice':
            return (
              <div
                key={i}
                className={`gui-card gui-notice is-${c.tone}`}
                role={c.tone === 'danger' ? 'alert' : 'status'}
              >
                <span className="gui-notice-icon">{TONE_ICON[c.tone]}</span>
                <div>
                  <div className="gui-title">{c.title}</div>
                  {c.detail && <div className="gui-muted">{c.detail}</div>}
                </div>
              </div>
            );
          case 'chart':
            return (
              <section key={i} className="gui-card" aria-label={c.title ?? 'Gráfica'}>
                {c.title && (
                  <div className="gui-head">
                    <span className="gui-title">{c.title}</span>
                  </div>
                )}
                <ViewChart chart={c.chart} labels={c.labels} series={c.series} unit={c.unit} />
              </section>
            );
          case 'kpi':
            return (
              <section key={i} className="gui-card" aria-label={c.title ?? 'Métricas'}>
                {c.title && (
                  <div className="gui-head">
                    <span className="gui-title">{c.title}</span>
                  </div>
                )}
                <div className="gui-kpis">
                  {c.items.map((item, j) => (
                    <div key={j} className={`gui-kpi is-${item.tone ?? 'neutral'}`}>
                      <span className="gui-kpi-value">{item.value}</span>
                      <span className="gui-kpi-label">{item.label}</span>
                      {item.delta && <span className="gui-kpi-delta">{item.delta}</span>}
                    </div>
                  ))}
                </div>
              </section>
            );
          case 'progress': {
            const done = c.steps.filter((s) => s.status === 'done').length;
            return (
              <section key={i} className="gui-card" aria-label={c.title}>
                <div className="gui-head">
                  <span className="gui-title">{c.title}</span>
                  <span className="gui-muted">
                    {done}/{c.steps.length}
                  </span>
                </div>
                <div className="gui-progress-bar" aria-hidden="true">
                  <div
                    className="gui-progress-fill"
                    style={{ width: `${Math.round((done / Math.max(1, c.steps.length)) * 100)}%` }}
                  />
                </div>
                <ul className="gui-progress-steps">
                  {c.steps.map((s, j) => (
                    <li key={j} className={`gui-progress-step is-${s.status}`}>
                      <span className="gui-progress-dot" aria-hidden="true" />
                      <span className="gui-progress-title">{s.title}</span>
                      {s.detail && <span className="gui-muted"> {s.detail}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            );
          }
          case 'timeline':
            return (
              <section key={i} className="gui-card" aria-label={c.title ?? 'Actividad'}>
                {c.title && (
                  <div className="gui-head">
                    <span className="gui-title">{c.title}</span>
                  </div>
                )}
                <ul className="gui-timeline">
                  {c.events.map((e, j) => (
                    <li key={j} className={`gui-timeline-event is-${e.tone ?? 'neutral'}`}>
                      <span className="gui-timeline-dot" aria-hidden="true" />
                      <div className="gui-timeline-body">
                        <span className="gui-timeline-label">{e.label}</span>
                        {e.at && <time className="gui-muted">{e.at}</time>}
                        {e.detail && <div className="gui-muted">{e.detail}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          case 'mcp_ui':
            return (
              <McpUiFrame key={i} resource={c.resource} title={c.title} onSendText={onSendText} />
            );
          case 'interactive':
            return (
              <InteractiveUiFrame
                key={i}
                title={c.title}
                html={c.html}
                css={c.css}
                js={c.js}
                height={c.height}
                onSendText={onSendText}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

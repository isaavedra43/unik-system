'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  Info,
  ListChecks,
  Loader2,
  Plug,
  Sparkles,
  Table2,
  TriangleAlert,
  ChartColumn,
  Clock,
  Check,
} from 'lucide-react';
import type {
  UiComponent,
  UiMediaItem,
  UiRecord,
  UiTone,
  UiCardAction,
} from '@/modules/ai/generative-ui/types';
import { cn } from '@/lib/utils';
import { hostOf } from '../lib/format';

/**
 * Generative cards — the answers' visual layer (data the tools returned,
 * drawn with a closed vocabulary; the model never ships markup here except
 * through the sandboxed interactive/MCP frames).
 */

const ChartView = dynamic(() => import('./ChartView'), {
  ssr: false,
  loading: () => <div className="uv-chart uv-skel" />,
});
const McpUiFrame = dynamic(() => import('./McpUiFrame'), {
  ssr: false,
  loading: () => <div className="uv-skel" style={{ height: 160 }} />,
});
const InteractiveUiFrame = dynamic(() => import('./InteractiveUiFrame'), {
  ssr: false,
  loading: () => <div className="uv-skel" style={{ height: 200 }} />,
});

const TONE_PILL: Record<UiTone, string> = {
  neutral: '',
  success: 'is-live',
  warning: 'is-warn',
  danger: 'is-danger',
  info: 'is-info',
};

function Tone({ tone, label }: { tone: UiTone; label: string }) {
  return <span className={cn('uv-pill', TONE_PILL[tone])}>{label}</span>;
}

function formatDate(value?: string): string {
  if (!value) return '';
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function CardHead({
  icon,
  title,
  sub,
  tone,
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
  children?: React.ReactNode;
}) {
  return (
    <div className="uv-card-head">
      <span className={cn('uv-card-icon', tone && `is-${tone}`)}>{icon}</span>
      <span className="uv-card-title">
        <strong>{title}</strong>
        {sub ? <span>{sub}</span> : null}
      </span>
      {children}
    </div>
  );
}

/* ---------------- KPI ---------------- */
function KpiCard({
  title,
  items,
}: {
  title?: string;
  items: Array<{ label: string; value: string; delta?: string; tone?: UiTone }>;
}) {
  return (
    <section className="uv-card" aria-label={title ?? 'Indicadores'}>
      {title && <CardHead icon={<ChartColumn size={16} />} title={title} />}
      <div
        className="uv-kpis"
        data-count={Math.min(items.length, 4)}
        style={title ? { borderTop: '1px solid var(--uv-line)' } : undefined}
      >
        {items.map((k, i) => {
          const up = k.delta ? /^\+|↑|sube|arriba/i.test(k.delta) : false;
          const down = k.delta ? /^-|−|↓|baja|abajo/i.test(k.delta) : false;
          const good = k.tone === 'success' || (k.tone === undefined && up);
          const bad = k.tone === 'danger' || (k.tone === undefined && down);
          return (
            <div key={`${k.label}-${i}`} className="uv-kpi">
              <span className="uv-kpi-label">{k.label}</span>
              <span className="uv-kpi-value">{k.value}</span>
              {k.delta && (
                <span className={cn('uv-kpi-delta', good && 'is-up', bad && 'is-down')}>
                  {up ? <ArrowUp size={12} /> : down ? <ArrowDown size={12} /> : null}
                  {k.delta}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------- Table ---------------- */
const NUM_RE = /^[-+]?[$€]?\s?[-+]?\d[\d,.\s]*%?$/;
const toNumber = (v: string) => Number(v.replace(/[$€,%\s]/g, ''));

function TableCard({
  heading,
  source,
  columns,
  rows,
  total,
}: {
  heading?: string;
  source?: string;
  columns: string[];
  rows: string[][];
  total: number;
}) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const numeric = useMemo(
    () =>
      columns.map((_, c) => {
        const vals = rows.map((r) => (r[c] ?? '').trim()).filter(Boolean);
        return vals.length > 0 && vals.every((v) => NUM_RE.test(v));
      }),
    [columns, rows]
  );
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const x = a[col] ?? '';
      const y = b[col] ?? '';
      if (numeric[col]) return (toNumber(x) - toNumber(y)) * dir;
      return x.localeCompare(y, 'es') * dir;
    });
  }, [rows, sort, numeric]);
  const visible = expanded ? sorted : sorted.slice(0, 8);
  const copyCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [columns, ...rows].map((r) => r.map((c) => esc(c ?? '')).join(',')).join('\n');
    void navigator.clipboard?.writeText(csv).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <section className="uv-card" aria-label={heading ?? 'Tabla'}>
      <CardHead
        icon={<Table2 size={16} />}
        title={heading ?? 'Resultados'}
        sub={`${total.toLocaleString('es-MX')} ${total === 1 ? 'registro' : 'registros'}${source ? ` · ${source}` : ''}`}
      >
        <button
          type="button"
          className="uv-btn is-ghost is-sm"
          onClick={copyCsv}
          aria-label="Copiar como CSV"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copiado' : 'CSV'}
        </button>
      </CardHead>
      <div className="uv-dt-wrap">
        <table className="uv-dt">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={c + i}
                  className={numeric[i] ? 'is-num' : undefined}
                  aria-sort={
                    sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort((s) =>
                        s?.col === i
                          ? s.dir === 1
                            ? { col: i, dir: -1 }
                            : null
                          : { col: i, dir: 1 }
                      )
                    }
                  >
                    {c}
                    {sort?.col === i ? (
                      sort.dir === 1 ? (
                        <ArrowUp size={11} />
                      ) : (
                        <ArrowDown size={11} />
                      )
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, ri) => (
              <tr key={ri}>
                {columns.map((_, ci) => (
                  <td key={ci} className={numeric[ci] ? 'is-num' : undefined}>
                    {r[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(rows.length > 8 || total > rows.length) && (
        <div className="uv-card-foot">
          <span className="uv-grow uv-card-source">
            {total > rows.length
              ? `Mostrando ${rows.length} de ${total.toLocaleString('es-MX')} · pide un archivo para verlos todos`
              : `${rows.length} filas`}
          </span>
          {rows.length > 8 && (
            <button
              type="button"
              className="uv-btn is-secondary is-sm"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Ver menos' : `Ver las ${rows.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- Records / sources / entity ---------------- */
function Favicon({ url }: { url?: string }) {
  const host = hostOf(url);
  return <span className="uv-favicon">{host.replace(/^www\./, '').slice(0, 1) || '·'}</span>;
}

function SourcesCard({
  heading,
  items,
  source,
}: {
  heading?: string;
  items: UiRecord[];
  source?: string;
}) {
  return (
    <section className="uv-cards" aria-label={heading ?? 'Fuentes'}>
      <div className="uv-sources-head">
        <strong>{heading ?? 'Fuentes'}</strong>
        <span className="uv-card-source">
          {items.length} {items.length === 1 ? 'fuente' : 'fuentes'}
          {source && source !== 'Internet' ? ` · ${source}` : ''}
        </span>
      </div>
      <div className="uv-sources">
        {items.map((r, i) => (
          <a
            key={`${r.url}-${i}`}
            className="uv-source"
            href={r.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            <span className="uv-source-host">
              <Favicon url={r.url} />
              <span>{hostOf(r.url)}</span>
            </span>
            <span className="uv-source-title">{r.title}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function RecordRow({ r }: { r: UiRecord }) {
  const inner = (
    <>
      <div className="uv-record-main">
        <div className="uv-record-title">
          <span>{r.title}</span>
          {r.badge && <Tone tone={r.badge.tone} label={r.badge.label} />}
        </div>
        {r.subtitle && <div className="uv-record-sub">{r.subtitle}</div>}
        {r.body && <div className="uv-record-body">{r.body}</div>}
        {r.fields && r.fields.length > 0 && (
          <dl className="uv-fields">
            {r.fields.slice(0, 6).map((f) => (
              <div key={f.label} className="uv-field">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {(r.date || r.url) && (
        <span className="uv-record-date">
          {formatDate(r.date)}
          {r.url && <ArrowUpRight size={13} style={{ marginLeft: 4, verticalAlign: '-2px' }} />}
        </span>
      )}
    </>
  );
  return r.url ? (
    <a className="uv-record" href={r.url} target="_blank" rel="noopener noreferrer nofollow">
      {inner}
    </a>
  ) : (
    <div className="uv-record">{inner}</div>
  );
}

function RecordsCard({
  heading,
  source,
  items,
  total,
}: {
  heading?: string;
  source?: string;
  items: UiRecord[];
  total: number;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  return (
    <section className="uv-card" aria-label={heading ?? 'Resultados'}>
      <CardHead
        icon={<ListChecks size={16} />}
        title={heading ?? 'Resultados'}
        sub={`${total.toLocaleString('es-MX')} ${total === 1 ? 'resultado' : 'resultados'}${source ? ` · ${source}` : ''}`}
      />
      <div className="uv-records">
        {shown.map((r, i) => (
          <RecordRow key={`${r.title}-${i}`} r={r} />
        ))}
      </div>
      {items.length > 5 && (
        <div className="uv-card-foot">
          <span className="uv-grow" />
          <button
            type="button"
            className="uv-btn is-secondary is-sm"
            onClick={() => setAll((v) => !v)}
          >
            {all ? 'Ver menos' : `Ver ${items.length - 5} más`}
          </button>
        </div>
      )}
    </section>
  );
}

function EntityCard({ record, source }: { record: UiRecord; source?: string }) {
  return (
    <section className="uv-card" aria-label={record.title}>
      <CardHead
        icon={<Sparkles size={16} />}
        title={record.title}
        sub={[record.subtitle, source].filter(Boolean).join(' · ')}
      >
        {record.badge && <Tone tone={record.badge.tone} label={record.badge.label} />}
      </CardHead>
      {(record.fields?.length || record.body) && (
        <div className="uv-card-body">
          {record.body && (
            <p
              style={{
                margin: 0,
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--unik-text-secondary)',
              }}
            >
              {record.body}
            </p>
          )}
          {record.fields && record.fields.length > 0 && (
            <dl className="uv-fields">
              {record.fields.map((f) => (
                <div key={f.label} className="uv-field">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {(record.url || record.date) && (
        <div className="uv-card-foot">
          <span className="uv-grow uv-card-source">{formatDate(record.date)}</span>
          {record.url && (
            <a
              className="uv-btn is-secondary is-sm"
              href={record.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              Abrir <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- Notice / progress / timeline ---------------- */
function NoticeCard({
  tone,
  title,
  detail,
  url,
}: {
  tone: UiTone;
  title: string;
  detail?: string;
  url?: string;
}) {
  const Icon =
    tone === 'success'
      ? CircleCheck
      : tone === 'danger'
        ? CircleAlert
        : tone === 'warning'
          ? TriangleAlert
          : Info;
  const t =
    tone === 'success'
      ? 'ok'
      : tone === 'danger'
        ? 'danger'
        : tone === 'warning'
          ? 'warn'
          : undefined;
  return (
    <section className="uv-card" aria-label={title}>
      <CardHead icon={<Icon size={16} />} title={title} sub={detail} tone={t}>
        {url && (
          <a
            className="uv-btn is-secondary is-sm"
            href={url}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            Abrir <ExternalLink size={12} />
          </a>
        )}
      </CardHead>
    </section>
  );
}

function ProgressCard({
  title,
  steps,
}: {
  title: string;
  steps: Array<{ title: string; status: string; detail?: string }>;
}) {
  const done = steps.filter((s) => s.status === 'done').length;
  return (
    <section className="uv-card" aria-label={title}>
      <CardHead
        icon={<ListChecks size={16} />}
        title={title}
        sub={`${done} de ${steps.length} pasos`}
      >
        <span style={{ width: 90 }}>
          <span className="uv-progress" style={{ display: 'block' }}>
            <i style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
          </span>
        </span>
      </CardHead>
      <div className="uv-card-body">
        <ol className="uv-tl">
          {steps.map((s, i) => (
            <li
              key={`${s.title}-${i}`}
              className={
                s.status === 'done'
                  ? 'is-ok'
                  : s.status === 'running'
                    ? 'is-running'
                    : s.status === 'failed'
                      ? 'is-bad'
                      : undefined
              }
            >
              <div className="uv-tl-title">{s.title}</div>
              {s.detail && <div className="uv-tl-detail">{s.detail}</div>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function TimelineCard({
  title,
  events,
}: {
  title?: string;
  events: Array<{ label: string; at?: string; detail?: string; tone?: UiTone }>;
}) {
  return (
    <section className="uv-card" aria-label={title ?? 'Cronología'}>
      <CardHead
        icon={<Clock size={16} />}
        title={title ?? 'Cronología'}
        sub={`${events.length} eventos`}
      />
      <div className="uv-card-body">
        <ol className="uv-tl">
          {events.map((e, i) => (
            <li
              key={`${e.label}-${i}`}
              className={
                e.tone === 'success'
                  ? 'is-ok'
                  : e.tone === 'danger'
                    ? 'is-bad'
                    : e.tone === 'warning'
                      ? 'is-warn'
                      : undefined
              }
            >
              {e.at && <div className="uv-tl-meta">{formatDate(e.at)}</div>}
              <div className="uv-tl-title">{e.label}</div>
              {e.detail && <div className="uv-tl-detail">{e.detail}</div>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ---------------- Media ---------------- */
function MediaView({ item }: { item: UiMediaItem }) {
  if (item.kind === 'video')
    return <video src={item.url} controls playsInline preload="metadata" />;
  if (item.kind === 'audio') return <audio src={item.url} controls style={{ width: '100%' }} />;
  return (
    <a href={item.url} target="_blank" rel="noopener noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={item.url} alt={item.title ?? 'Imagen generada'} loading="lazy" />
    </a>
  );
}

function MediaCard({
  title,
  source,
  items,
  actions,
  onSendText,
  interactive,
}: {
  title?: string;
  source?: string;
  items: UiMediaItem[];
  actions?: UiCardAction[];
  onSendText?: (t: string) => void;
  interactive: boolean;
}) {
  return (
    <section className="uv-card" aria-label={title ?? 'Generado'}>
      <CardHead icon={<Sparkles size={16} />} title={title ?? 'Generado'} sub={source} />
      <div className="uv-card-body">
        <div className={cn('uv-media-grid', items.length === 1 && 'is-single')}>
          {items.map((it, i) => (
            <MediaView key={`${it.url}-${i}`} item={it} />
          ))}
        </div>
      </div>
      {interactive && onSendText && actions && actions.length > 0 && (
        <div className="uv-card-foot">
          <div className="uv-followups">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="uv-chip"
                onClick={() => onSendText(a.sendText)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------- Connect an external app (Composio) ---------------- */
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

  const announce = useCallback(() => {
    if (interactive && !announced.current) {
      announced.current = true;
      onSendText?.(`Ya conecté ${name}, continúa con lo que te pedí.`);
    }
  }, [interactive, name, onSendText]);

  useEffect(() => {
    let alive = true;
    if (!connected) {
      void check().then((ok) => {
        if (alive && ok) setState('connected');
      });
    }
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, [check, connected]);

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
        announce();
      }
    }, 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [state, check, announce]);

  async function start() {
    setState('opening');
    setMessage(null);
    try {
      const res = await fetch('/app/assistant/api/composio/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit }),
      });
      const data = (await res.json()) as {
        redirectUrl?: string | null;
        connected?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setState('error');
        setMessage(data.error ?? 'No se pudo iniciar la conexión');
        return;
      }
      if (!data.redirectUrl) {
        if (data.connected) {
          setState('connected');
          announce();
          return;
        }
        setState('error');
        setMessage('La app no devolvió un enlace de autorización');
        return;
      }
      window.open(data.redirectUrl, '_blank', 'noopener,noreferrer');
      setState('waiting');
    } catch {
      setState('error');
      setMessage('No se pudo iniciar la conexión');
    }
  }

  const ok = state === 'connected';
  return (
    <section className="uv-card" aria-label={`Conectar ${name}`}>
      <CardHead
        icon={ok ? <CircleCheck size={16} /> : <Plug size={16} />}
        tone={ok ? 'ok' : undefined}
        title={ok ? `${name} conectado` : `Conecta tu cuenta de ${name}`}
        sub={
          ok
            ? 'Listo: el agente ya puede usarla en tu nombre.'
            : state === 'waiting'
              ? 'Completa el acceso en la pestaña que se abrió; aquí se actualiza solo.'
              : (message ??
                'Autoriza el acceso una vez; después el agente la usa cuando haga falta.')
        }
      >
        {!ok && (
          <button
            type="button"
            className="uv-btn is-primary is-sm"
            onClick={start}
            disabled={state === 'opening' || state === 'waiting'}
          >
            {state === 'opening' || state === 'waiting' ? (
              <Loader2 size={13} className="uv-spin" />
            ) : (
              <Plug size={13} />
            )}
            {state === 'waiting' ? 'Esperando…' : state === 'error' ? 'Reintentar' : 'Conectar'}
          </button>
        )}
      </CardHead>
    </section>
  );
}

/* ---------------- Registry ---------------- */
export function Cards({
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
    <div className="uv-cards">
      {components.map((c, i) => {
        const key = `${c.type}-${i}`;
        switch (c.type) {
          case 'connect':
            return (
              <ConnectCard key={key} {...c} onSendText={onSendText} interactive={interactive} />
            );
          case 'media':
            return <MediaCard key={key} {...c} onSendText={onSendText} interactive={interactive} />;
          case 'records': {
            const webLike =
              c.items.length > 0 && c.items.every((r) => r.url && !r.fields?.length && !r.badge);
            return webLike ? (
              <SourcesCard key={key} heading={c.heading} source={c.source} items={c.items} />
            ) : (
              <RecordsCard
                key={key}
                heading={c.heading}
                source={c.source}
                items={c.items}
                total={c.total}
              />
            );
          }
          case 'record':
            return <EntityCard key={key} record={c.record} source={c.source} />;
          case 'table':
            return (
              <TableCard
                key={key}
                heading={c.heading}
                source={c.source}
                columns={c.columns}
                rows={c.rows}
                total={c.total}
              />
            );
          case 'notice':
            return (
              <NoticeCard key={key} tone={c.tone} title={c.title} detail={c.detail} url={c.url} />
            );
          case 'chart':
            return (
              <section key={key} className="uv-card" aria-label={c.title ?? 'Gráfica'}>
                <CardHead
                  icon={<ChartColumn size={16} />}
                  title={c.title ?? 'Gráfica'}
                  sub={c.unit ? `Unidad: ${c.unit}` : undefined}
                />
                <div className="uv-card-body">
                  <ChartView chart={c.chart} labels={c.labels} series={c.series} unit={c.unit} />
                </div>
              </section>
            );
          case 'kpi':
            return <KpiCard key={key} title={c.title} items={c.items} />;
          case 'progress':
            return <ProgressCard key={key} title={c.title} steps={c.steps} />;
          case 'timeline':
            return <TimelineCard key={key} title={c.title} events={c.events} />;
          case 'mcp_ui':
            return (
              <McpUiFrame key={key} resource={c.resource} title={c.title} onSendText={onSendText} />
            );
          case 'interactive':
            return (
              <InteractiveUiFrame
                key={key}
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

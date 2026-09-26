'use client';

import React, { Component, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'motion/react';
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { defineRegistry, JSONUIProvider, Renderer, useBoundProp } from '@json-render/react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownRight,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Box,
  Calendar,
  ChartColumn,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  Globe,
  Info,
  Link as LinkIcon,
  Loader2,
  Mail,
  MessageSquare,
  Monitor,
  Phone,
  Play,
  Power,
  Repeat,
  Search,
  Settings,
  Shield,
  ShoppingCart,
  Sparkles,
  Star,
  Table2,
  Target,
  Terminal,
  Truck,
  User,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  GENUI_ACTIONS,
  GENUI_COMPONENTS,
  type GenUiComponentDef,
  type GenUiSpec,
} from '@/modules/ai/genui/catalog';
import { isSafeHref, sanitizeGenUiSpec } from '@/modules/ai/genui/validate';
import { formatBytes, formatNumber } from '../lib/format';
import { useVenue } from '../workspace/useVenue';
import { Markdown } from '../chat/Markdown';

/**
 * Generative cards (json-render). The agent composes a spec from the UNIK
 * catalog; this file draws it with UNIK's own components and handles its
 * actions through existing endpoints. The spec is sanitized again here — the
 * renderer itself never validates props.
 */

const ChartView = dynamic(() => import('./ChartView'), {
  ssr: false,
  loading: () => <div className="uv-chart uv-skel" />,
});

const ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  chart: ChartColumn,
  table: Table2,
  users: Users,
  user: User,
  file: File,
  folder: Folder,
  calendar: Calendar,
  clock: Clock,
  check: Check,
  alert: AlertTriangle,
  info: Info,
  money: Wallet,
  cart: ShoppingCart,
  truck: Truck,
  box: Box,
  mail: Mail,
  message: MessageSquare,
  phone: Phone,
  globe: Globe,
  terminal: Terminal,
  monitor: Monitor,
  repeat: Repeat,
  bell: Bell,
  star: Star,
  target: Target,
  zap: Zap,
  shield: Shield,
  search: Search,
  link: LinkIcon,
  download: Download,
  play: Play,
  settings: Settings,
};

function Icon({ name, size = 16 }: { name?: string; size?: number }) {
  const I = (name && ICONS[name]) || null;
  return I ? <I size={size} /> : null;
}

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

function formatValue(value: unknown, format?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (format === 'money')
      return Math.abs(value) >= 1000
        ? `$${Math.round(value).toLocaleString('es-MX')}`
        : formatNumber(value, { money: true });
    if (format === 'percent') return `${(Math.abs(value) <= 1 ? value * 100 : value).toFixed(1)}%`;
    if (format === 'text') return String(value);
    return formatNumber(value);
  }
  if (format === 'date' && typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime()))
      return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return String(value);
}

/* ---------------------------------------------------------------- catalog */

const catalog = defineCatalog(schema, {
  components: Object.fromEntries(
    Object.entries(GENUI_COMPONENTS as Record<string, GenUiComponentDef>).map(([name, def]) => [
      name,
      { props: def.props, slots: def.slots, description: def.description },
    ])
  ),
  actions: Object.fromEntries(
    Object.entries(GENUI_ACTIONS).map(([name, def]) => [
      name,
      { params: def.params, description: def.description },
    ])
  ),
} as never);

type P<T> = {
  props: T;
  children?: React.ReactNode;
  emit: (e: string) => void;
  bindings?: Record<string, string>;
};
type Any = Record<string, unknown>;

/* ---------------------------------------------------------------- pieces */

function Stack({ props, children }: P<Any>) {
  return (
    <div
      className={cn(
        'uv-g-stack',
        props.direction === 'horizontal' && 'is-row',
        props.wrap === true && 'is-wrap'
      )}
      data-gap={(props.gap as string) ?? 'md'}
      data-align={(props.align as string) ?? undefined}
      data-justify={(props.justify as string) ?? undefined}
    >
      {children}
    </div>
  );
}

function Grid({ props, children }: P<Any>) {
  return (
    <div
      className="uv-g-grid"
      data-cols={Math.max(1, Math.min(4, Number(props.columns) || 2))}
      data-gap={(props.gap as string) ?? 'md'}
    >
      {children}
    </div>
  );
}

function Card({ props, children }: P<Any>) {
  const tone = (props.tone as Tone) ?? 'neutral';
  return (
    <section className={cn('uv-g-card', `is-${tone}`)}>
      {Boolean(props.title || props.subtitle) && (
        <header className="uv-g-card-head">
          {typeof props.icon === 'string' && (
            <span className="uv-g-card-icon">
              <Icon name={props.icon} />
            </span>
          )}
          <div>
            {typeof props.title === 'string' && <h4>{props.title}</h4>}
            {typeof props.subtitle === 'string' && <p>{props.subtitle}</p>}
          </div>
        </header>
      )}
      {children && <div className="uv-g-card-body">{children}</div>}
      {typeof props.footer === 'string' && (
        <footer className="uv-g-card-foot">{props.footer}</footer>
      )}
    </section>
  );
}

function Tabs({ props, children, bindings }: P<Any>) {
  const tabs = (Array.isArray(props.tabs) ? props.tabs : []) as Array<{
    id: string;
    label: string;
  }>;
  const [value, setValue] = useBoundProp<string>(
    (props.value as string | undefined) ?? tabs[0]?.id,
    bindings?.value
  );
  const current = value ?? tabs[0]?.id;
  return (
    <div className="uv-g-tabs">
      <div className="uv-g-tablist" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={current === t.id}
            className={cn(current === t.id && 'is-active')}
            onClick={() => setValue(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="uv-g-tabpanel" role="tabpanel">
        {children}
      </div>
    </div>
  );
}

function Heading({ props }: P<Any>) {
  const level = Math.max(1, Math.min(3, Number(props.level) || 2));
  const Tag = `h${level + 2}` as 'h3' | 'h4' | 'h5';
  return <Tag className={cn('uv-g-heading', `is-l${level}`)}>{String(props.text ?? '')}</Tag>;
}

function Text({ props }: P<Any>) {
  return (
    <p
      className="uv-g-text"
      data-tone={(props.tone as string) ?? 'default'}
      data-size={(props.size as string) ?? 'md'}
      data-weight={(props.weight as string) ?? 'normal'}
    >
      {String(props.text ?? '')}
    </p>
  );
}

function MarkdownBlock({ props }: P<Any>) {
  return (
    <div className="uv-g-markdown">
      <Markdown content={String(props.content ?? '')} />
    </div>
  );
}

function Badge({ props }: P<Any>) {
  return (
    <span className={cn('uv-g-badge', `is-${(props.tone as Tone) ?? 'neutral'}`)}>
      {String(props.label ?? '')}
    </span>
  );
}

function Metric({ props }: P<Any>) {
  const trend = props.trend as 'up' | 'down' | 'flat' | undefined;
  const TrendIcon = trend === 'up' ? ArrowUpRight : trend === 'down' ? ArrowDownRight : ArrowRight;
  return (
    <div className={cn('uv-g-metric', trend && `is-${trend}`)}>
      <span className="uv-g-metric-label">
        {typeof props.icon === 'string' && <Icon name={props.icon} size={14} />}
        {String(props.label ?? '')}
      </span>
      <strong className="uv-g-metric-value">
        {formatValue(props.value, (props.format as string) ?? undefined)}
      </strong>
      {Boolean(props.delta || trend) && (
        <span className="uv-g-metric-delta">
          {trend && <TrendIcon size={13} />}
          {typeof props.delta === 'string' ? props.delta : ''}
        </span>
      )}
      {typeof props.hint === 'string' && <span className="uv-g-metric-hint">{props.hint}</span>}
    </div>
  );
}

function Progress({ props }: P<Any>) {
  const max = Number(props.max) > 0 ? Number(props.max) : 100;
  const value = Math.max(0, Math.min(max, Number(props.value) || 0));
  const pct = Math.round((value / max) * 100);
  return (
    <div className={cn('uv-g-progress', `is-${(props.tone as Tone) ?? 'info'}`)}>
      <div className="uv-g-progress-head">
        <span>{typeof props.label === 'string' ? props.label : 'Avance'}</span>
        <span>{pct}%</span>
      </div>
      <div
        className="uv-g-progress-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Callout({ props }: P<Any>) {
  const tone = (props.tone as Tone) ?? 'info';
  const I =
    tone === 'danger' || tone === 'warning' ? AlertTriangle : tone === 'success' ? Check : Info;
  return (
    <div className={cn('uv-g-callout', `is-${tone}`)} role="note">
      <I size={16} />
      <div>
        <strong>{String(props.title ?? '')}</strong>
        {typeof props.body === 'string' && <p>{props.body}</p>}
      </div>
    </div>
  );
}

function KeyValue({ props }: P<Any>) {
  const items = (Array.isArray(props.items) ? props.items : []) as Array<{
    label: string;
    value: string;
  }>;
  return (
    <dl className="uv-g-kv">
      {items.map((it, i) => (
        <div key={i}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function List({ props }: P<Any>) {
  const items = (Array.isArray(props.items) ? props.items : []) as Array<{
    title: string;
    subtitle?: string;
    meta?: string;
    badge?: string;
    tone?: Tone;
  }>;
  if (items.length === 0)
    return (
      <p className="uv-g-empty">
        {typeof props.empty === 'string' ? props.empty : 'Sin elementos.'}
      </p>
    );
  return (
    <ul className="uv-g-list">
      {items.map((it, i) => (
        <li key={i}>
          <div>
            <span className="uv-g-list-title">{it.title}</span>
            {it.subtitle && <span className="uv-g-list-sub">{it.subtitle}</span>}
          </div>
          <div className="uv-g-list-end">
            {it.meta && <span className="uv-g-list-meta">{it.meta}</span>}
            {it.badge && (
              <span className={cn('uv-g-badge', `is-${it.tone ?? 'neutral'}`)}>{it.badge}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Timeline({ props }: P<Any>) {
  const items = (Array.isArray(props.items) ? props.items : []) as Array<{
    title: string;
    time?: string;
    body?: string;
    tone?: Tone;
  }>;
  return (
    <ol className="uv-g-timeline">
      {items.map((it, i) => (
        <li key={i} className={`is-${it.tone ?? 'neutral'}`}>
          <i aria-hidden="true" />
          <div>
            <div className="uv-g-timeline-head">
              <strong>{it.title}</strong>
              {it.time && <time>{it.time}</time>}
            </div>
            {it.body && <p>{it.body}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Table({ props }: P<Any>) {
  const columns = useMemo(
    () =>
      (Array.isArray(props.columns) ? props.columns : []) as Array<{
        key: string;
        label: string;
        align?: 'left' | 'right' | 'center';
        format?: string;
      }>,
    [props.columns]
  );
  const allRows = useMemo(
    () => (Array.isArray(props.rows) ? props.rows : []) as Array<Record<string, unknown>>,
    [props.rows]
  );
  const pageSize = Math.max(5, Math.min(100, Number(props.pageSize) || 10));
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);
  const filterKey = typeof props.filterKey === 'string' ? props.filterKey : null;
  const filterValue =
    props.filterValue === undefined || props.filterValue === null ? '' : String(props.filterValue);

  const rows = useMemo(() => {
    let list = allRows;
    if (filterKey && filterValue)
      list = list.filter((r) => String(r[filterKey] ?? '') === filterValue);
    const q = query.trim().toLowerCase();
    if (q)
      list = list.filter((r) =>
        columns.some((c) =>
          String(r[c.key] ?? '')
            .toLowerCase()
            .includes(q)
        )
      );
    if (sort) {
      list = [...list].sort((a, b) => {
        const x = a[sort.key];
        const y = b[sort.key];
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
        return String(x ?? '').localeCompare(String(y ?? ''), 'es') * sort.dir;
      });
    }
    return list;
  }, [allRows, filterKey, filterValue, query, sort, columns]);

  useEffect(() => setPage(0), [query, filterValue, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const visible = rows.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div className="uv-g-table">
      {props.searchable === true && (
        <label className="uv-g-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar en la tabla"
            aria-label="Buscar en la tabla"
          />
        </label>
      )}
      <div className="uv-g-table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    data-align={
                      c.align ??
                      (c.format && c.format !== 'text' && c.format !== 'date' ? 'right' : 'left')
                    }
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setSort((s) =>
                          s?.key === c.key
                            ? s.dir === 1
                              ? { key: c.key, dir: -1 }
                              : null
                            : { key: c.key, dir: 1 }
                        )
                      }
                      aria-label={`Ordenar por ${c.label}`}
                    >
                      {c.label}
                      {active &&
                        (sort?.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-align={
                      c.align ??
                      (c.format && c.format !== 'text' && c.format !== 'date' ? 'right' : 'left')
                    }
                  >
                    {formatValue(r[c.key], c.format)}
                  </td>
                ))}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="uv-g-empty">
                  {typeof props.empty === 'string' ? props.empty : 'Sin resultados.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > pageSize && (
        <div className="uv-g-pager">
          <span>
            {page * pageSize + 1}–{Math.min(rows.length, (page + 1) * pageSize)} de {rows.length}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="Página anterior"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            aria-label="Página siguiente"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function Chart({ props }: P<Any>) {
  const data = (Array.isArray(props.data) ? props.data : []) as Array<Record<string, unknown>>;
  const xKey = String(props.xKey ?? '');
  const series = (Array.isArray(props.series) ? props.series : []) as Array<{
    key: string;
    label?: string;
  }>;
  const kind = props.kind === 'pie' ? 'pie' : props.kind === 'bar' ? 'bar' : 'line';
  const labels = data.slice(0, 60).map((r) => String(r[xKey] ?? ''));
  const chartSeries = series.map((s) => ({
    name: s.label ?? s.key,
    data: data.slice(0, 60).map((r) => Number(r[s.key]) || 0),
  }));
  return (
    <figure
      className="uv-g-chart"
      style={{ ['--uv-chart-h' as string]: `${Number(props.height) || 240}px` }}
    >
      {typeof props.title === 'string' && <figcaption>{props.title}</figcaption>}
      <ChartView
        chart={kind}
        labels={labels}
        series={chartSeries}
        unit={props.unit as string | undefined}
      />
    </figure>
  );
}

function Kanban({ props }: P<Any>) {
  const columns = (Array.isArray(props.columns) ? props.columns : []) as Array<{
    id: string;
    title: string;
    tone?: Tone;
  }>;
  const items = (Array.isArray(props.items) ? props.items : []) as Array<{
    id: string;
    column: string;
    title: string;
    subtitle?: string;
    badge?: string;
    meta?: string;
  }>;
  return (
    <div className="uv-g-kanban">
      {columns.map((col) => {
        const list = items.filter((i) => i.column === col.id);
        return (
          <section
            key={col.id}
            className={cn('uv-g-kcol', `is-${col.tone ?? 'neutral'}`)}
            aria-label={col.title}
          >
            <header>
              <span>{col.title}</span>
              <em>{list.length}</em>
            </header>
            <div className="uv-g-kcol-body">
              {list.map((it) => (
                <article key={it.id} className="uv-g-kcard">
                  <strong>{it.title}</strong>
                  {it.subtitle && <span>{it.subtitle}</span>}
                  {(it.badge || it.meta) && (
                    <div>
                      {it.badge && <span className="uv-g-badge">{it.badge}</span>}
                      {it.meta && <em>{it.meta}</em>}
                    </div>
                  )}
                </article>
              ))}
              {list.length === 0 && <p className="uv-g-empty">Vacío</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** "PDF", "Excel", "Word"… instead of the raw MIME type. */
function fileKind(mime?: string): string | null {
  if (!mime) return null;
  if (mime === 'application/pdf') return 'PDF';
  if (/spreadsheet|excel/.test(mime)) return 'Excel';
  if (/wordprocessing|msword/.test(mime)) return 'Word';
  if (/presentation|powerpoint/.test(mime)) return 'PowerPoint';
  if (mime === 'text/csv') return 'CSV';
  if (mime.startsWith('image/')) return 'Imagen';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime.startsWith('text/')) return 'Texto';
  return (mime.split('/').pop() ?? '').slice(0, 12).toUpperCase() || null;
}

function fileIcon(mime?: string): LucideIcon {
  if (!mime) return File;
  if (mime.startsWith('image/')) return FileImage;
  if (/sheet|excel|csv/.test(mime)) return FileSpreadsheet;
  if (/pdf|word|text|document/.test(mime)) return FileText;
  return File;
}

function FilePreview({ props }: P<Any>) {
  const FIcon = fileIcon(props.mimeType as string | undefined);
  const artifactId = typeof props.artifactId === 'string' ? props.artifactId : null;
  const href = artifactId
    ? `/app/assistant/api/artifacts/${encodeURIComponent(artifactId)}/download`
    : typeof props.href === 'string' && isSafeHref(props.href)
      ? props.href
      : null;
  return (
    <div className="uv-g-file">
      <span className="uv-g-file-icon">
        <FIcon size={18} />
      </span>
      <div className="uv-g-file-text">
        <strong title={String(props.name ?? '')}>{String(props.name ?? 'Archivo')}</strong>
        <span>
          {[
            fileKind(props.mimeType as string | undefined),
            typeof props.sizeBytes === 'number' ? formatBytes(props.sizeBytes) : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'Archivo'}
        </span>
      </div>
      {href && (
        <a
          className="uv-btn is-secondary is-sm"
          href={href}
          target={artifactId ? undefined : '_blank'}
          rel="noopener noreferrer"
          download={artifactId ? '' : undefined}
        >
          {artifactId ? <Download size={13} /> : <ExternalLink size={13} />}
          {artifactId ? 'Descargar' : 'Abrir'}
        </a>
      )}
    </div>
  );
}

function ImageBlock({ props }: P<Any>) {
  if (typeof props.src !== 'string' || !isSafeHref(props.src)) return null;
  return (
    <figure className="uv-g-image">
      {/* eslint-disable-next-line @next/next/no-img-element -- remote https image chosen by the agent */}
      <img
        src={props.src}
        alt={String(props.alt ?? '')}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
      {typeof props.caption === 'string' && <figcaption>{props.caption}</figcaption>}
    </figure>
  );
}

function Divider() {
  return <hr className="uv-g-divider" />;
}

function Button({ props, emit }: P<Any>) {
  const variant = (props.variant as string) ?? 'secondary';
  return (
    <button
      type="button"
      className={cn(
        'uv-btn is-sm uv-g-button',
        `is-${variant === 'primary' ? 'primary' : variant === 'danger' ? 'danger' : variant === 'ghost' ? 'ghost' : 'secondary'}`
      )}
      disabled={props.disabled === true}
      onClick={() => emit('press')}
    >
      {typeof props.icon === 'string' && <Icon name={props.icon} size={14} />}
      {String(props.label ?? '')}
    </button>
  );
}

function Input({ props, bindings, emit }: P<Any>) {
  const [value, setValue] = useBoundProp<string | number>(
    props.value as string | number | undefined,
    bindings?.value
  );
  return (
    <label className="uv-g-field">
      <span>{String(props.label ?? '')}</span>
      <input
        type={(props.type as string) ?? 'text'}
        value={value ?? ''}
        placeholder={typeof props.placeholder === 'string' ? props.placeholder : undefined}
        onChange={(e) => {
          setValue(props.type === 'number' ? Number(e.target.value) : e.target.value);
          emit('change');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') emit('submit');
        }}
      />
    </label>
  );
}

function Select({ props, bindings, emit }: P<Any>) {
  const options = (Array.isArray(props.options) ? props.options : []) as Array<{
    value: string;
    label: string;
  }>;
  const [value, setValue] = useBoundProp<string>(
    props.value as string | undefined,
    bindings?.value
  );
  return (
    <label className="uv-g-field">
      <span>{String(props.label ?? '')}</span>
      <select
        value={value ?? ''}
        onChange={(e) => {
          setValue(e.target.value);
          emit('change');
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ props, bindings, emit }: P<Any>) {
  const [checked, setChecked] = useBoundProp<boolean>(
    props.checked as boolean | undefined,
    bindings?.checked
  );
  return (
    <label className="uv-g-toggle">
      <input
        type="checkbox"
        role="switch"
        checked={Boolean(checked)}
        onChange={(e) => {
          setChecked(e.target.checked);
          emit('change');
        }}
      />
      <i aria-hidden="true" />
      <span>{String(props.label ?? '')}</span>
    </label>
  );
}

function ComputerStatus({ props }: P<Any>) {
  const venue = useVenue({ surface: 'none', visible: true, hot: false });
  const s = venue.state;
  const on = Boolean(s?.active);
  const booting = venue.starting || venue.booting;
  const label = booting ? 'Encendiendo…' : on ? (s?.paused ? 'En pausa' : 'Encendida') : 'Apagada';
  return (
    <div className={cn('uv-g-computer', on && 'is-on', booting && 'is-booting')}>
      <span className="uv-g-computer-screen" aria-hidden="true">
        <Monitor size={20} />
        <i />
      </span>
      <div className="uv-g-computer-text">
        <strong>{typeof props.title === 'string' ? props.title : 'Computadora virtual'}</strong>
        <span>
          {label}
          {on && s?.startedAt
            ? ` · desde ${new Date(s.startedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`
            : ''}
        </span>
      </div>
      <div className="uv-g-computer-actions">
        {!on && !booting && (
          <button
            type="button"
            className="uv-btn is-secondary is-sm"
            onClick={() => void venue.start()}
          >
            <Power size={13} /> Encender
          </button>
        )}
        <button
          type="button"
          className="uv-btn is-primary is-sm"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('uv:workspace', { detail: { tab: 'computer' } }))
          }
        >
          {booting ? <Loader2 size={13} className="uv-spin" /> : <Monitor size={13} />} Ver
        </button>
      </div>
    </div>
  );
}

function RoutineBuilder({ props }: P<Any>) {
  const [goal, setGoal] = useState(String(props.goal ?? ''));
  const [schedule, setSchedule] = useState(String(props.schedule ?? ''));
  const [steps, setSteps] = useState<string[]>(
    Array.isArray(props.steps) ? (props.steps as string[]).slice(0, 12) : []
  );
  const [sent, setSent] = useState(false);
  const propose = () => {
    const text = [
      `Propón esta rutina para aprobación: ${goal.trim()}`,
      schedule.trim() ? `Horario: ${schedule.trim()}` : null,
      steps.filter((s) => s.trim()).length > 0
        ? `Pasos:\n${steps
            .filter((s) => s.trim())
            .map((s, i) => `${i + 1}. ${s.trim()}`)
            .join('\n')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');
    window.dispatchEvent(new CustomEvent('uv:send', { detail: { text } }));
    setSent(true);
  };
  return (
    <div className="uv-g-routine">
      <label className="uv-g-field">
        <span>Objetivo</span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} />
      </label>
      <label className="uv-g-field">
        <span>Cuándo</span>
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="Ej. diario a las 8:00"
        />
      </label>
      <div className="uv-g-routine-steps">
        <span>Pasos</span>
        {steps.map((s, i) => (
          <div key={i} className="uv-g-routine-step">
            <em>{i + 1}</em>
            <input
              value={s}
              onChange={(e) =>
                setSteps((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
              }
              aria-label={`Paso ${i + 1}`}
            />
            <button
              type="button"
              onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
              aria-label={`Quitar paso ${i + 1}`}
            >
              ×
            </button>
          </div>
        ))}
        {steps.length < 12 && (
          <button
            type="button"
            className="uv-link-btn"
            onClick={() => setSteps((prev) => [...prev, ''])}
          >
            + Agregar paso
          </button>
        )}
      </div>
      <button
        type="button"
        className="uv-btn is-primary is-sm"
        onClick={propose}
        disabled={!goal.trim() || sent}
      >
        {sent ? <Check size={13} /> : <Repeat size={13} />}
        {sent ? 'Enviado al agente' : 'Proponer rutina'}
      </button>
      <p className="uv-g-note">El agente la propone; corre solo cuando tú la apruebas.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- registry */

const { registry } = defineRegistry(
  catalog as never,
  {
    components: {
      Stack,
      Grid,
      Card,
      Tabs,
      Heading,
      Text,
      Markdown: MarkdownBlock,
      Badge,
      Metric,
      Progress,
      Callout,
      KeyValue,
      List,
      Timeline,
      Table,
      Chart,
      Kanban,
      FilePreview,
      Image: ImageBlock,
      Divider,
      Button,
      Input,
      Select,
      Toggle,
      ComputerStatus,
      RoutineBuilder,
    } as never,
  } as never
);

/* ---------------------------------------------------------------- actions */

export interface GenUiHandlers {
  onSendText?: (text: string) => void;
}

function useActionHandlers({ onSendText }: GenUiHandlers) {
  const [notice, setNotice] = useState<string | null>(null);
  const handlers = useMemo(() => {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      ask: async (p: Any) => {
        const text = str(p?.text).slice(0, 2000);
        if (!text) return;
        if (onSendText) onSendText(text);
        else window.dispatchEvent(new CustomEvent('uv:send', { detail: { text } }));
      },
      prefill: async (p: Any) => {
        const text = str(p?.text).slice(0, 2000);
        if (text) window.dispatchEvent(new CustomEvent('uv:prefill', { detail: { text } }));
      },
      openWorkspace: async (p: Any) => {
        const tab = str(p?.tab);
        if (['browser', 'computer', 'files', 'team'].includes(tab))
          window.dispatchEvent(new CustomEvent('uv:workspace', { detail: { tab } }));
      },
      openUrl: async (p: Any) => {
        const url = str(p?.url);
        if (isSafeHref(url)) window.open(url, '_blank', 'noopener,noreferrer');
      },
      openConversation: async (p: Any) => {
        const id = str(p?.conversationId);
        if (/^[A-Za-z0-9_-]{1,80}$/.test(id))
          window.dispatchEvent(
            new CustomEvent('uv:open-conversation', { detail: { conversationId: id } })
          );
      },
      download: async (p: Any) => {
        const id = str(p?.artifactId);
        if (/^[A-Za-z0-9_-]{1,80}$/.test(id))
          window.open(
            `/app/assistant/api/artifacts/${encodeURIComponent(id)}/download`,
            '_blank',
            'noopener'
          );
      },
      decideProposal: async (p: Any) => {
        const id = str(p?.proposalId);
        const decision = str(p?.decision);
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !['approve', 'reject'].includes(decision)) return;
        try {
          const res = await fetch(
            `/app/assistant/api/proposals/${encodeURIComponent(id)}/${decision}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: decision === 'reject' ? JSON.stringify({}) : undefined,
            }
          );
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setNotice(
            res.ok
              ? decision === 'approve'
                ? 'Aprobado.'
                : 'Rechazado.'
              : (d.error ?? 'No se pudo procesar.')
          );
          if (res.ok) window.dispatchEvent(new CustomEvent('uv:home-refresh'));
        } catch {
          setNotice('No se pudo procesar.');
        }
      },
      copy: async (p: Any) => {
        const text = str(p?.text);
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          setNotice('Copiado.');
        } catch {
          setNotice('No se pudo copiar.');
        }
      },
    };
  }, [onSendText]);
  return { handlers, notice, setNotice };
}

class GenUiBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="uv-g-callout is-warning" role="note">
          <AlertTriangle size={16} />
          <div>
            <strong>No se pudo mostrar esta tarjeta</strong>
            <p>Pídele al agente que la vuelva a generar.</p>
          </div>
        </div>
      );
    return this.props.children;
  }
}

/** Draws a (re-sanitized) json-render spec. */
export function GenUiView({
  spec,
  title,
  onSendText,
  bare = false,
}: {
  spec: GenUiSpec | unknown;
  title?: string;
  onSendText?: (text: string) => void;
  /** Without the card frame (home screen composes its own layout). */
  bare?: boolean;
}) {
  const safe = useMemo(() => sanitizeGenUiSpec(spec).spec, [spec]);
  const { handlers, notice, setNotice } = useActionHandlers({ onSendText });
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(t);
  }, [notice, setNotice]);
  if (!safe) return null;
  const body = (
    <GenUiBoundary>
      <JSONUIProvider
        registry={registry}
        initialState={safe.state ?? {}}
        handlers={handlers as never}
      >
        <Renderer spec={safe as never} registry={registry} />
      </JSONUIProvider>
      {notice && (
        <div className="uv-g-toast" role="status">
          {notice}
        </div>
      )}
    </GenUiBoundary>
  );
  if (bare) return body;
  return (
    <motion.section
      className="uv-card uv-genui"
      aria-label={title ?? 'Tarjeta generada'}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
    >
      {title && (
        <header className="uv-genui-head">
          <Sparkles size={14} />
          <span>{title}</span>
        </header>
      )}
      <div className="uv-genui-body">{body}</div>
    </motion.section>
  );
}

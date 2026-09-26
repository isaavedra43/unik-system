/** Formatting helpers for the UNIVERSO front (es-MX). Pure. */

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined | null): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/** "ahora" · "hace 12 min" · "hace 3 h" · "ayer" · "12 feb" */
export function timeAgo(iso: string | number | null | undefined): string {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMin = Math.round((Date.now() - t) / 60_000);
  if (diffMin < 1) return 'ahora';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `hace ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return 'ayer';
  if (diffD < 7) return `hace ${diffD} d`;
  return new Date(t).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Short money/number formatting for KPI-like values that arrive as numbers. */
export function formatNumber(value: number, opts: { money?: boolean } = {}): string {
  if (!Number.isFinite(value)) return String(value);
  return opts.money
    ? value.toLocaleString('es-MX', {
        style: 'currency',
        currency: 'MXN',
        maximumFractionDigits: 2,
      })
    : value.toLocaleString('es-MX', { maximumFractionDigits: 2 });
}

/** Conversation groups for the sidebar. */
export type ThreadGroup = 'starred' | 'today' | 'yesterday' | 'week' | 'month' | 'older';

export const THREAD_GROUP_LABEL: Record<ThreadGroup, string> = {
  starred: 'Favoritas',
  today: 'Hoy',
  yesterday: 'Ayer',
  week: 'Últimos 7 días',
  month: 'Últimos 30 días',
  older: 'Anteriores',
};

export function threadGroupOf(iso: string, starred: boolean, now = new Date()): ThreadGroup {
  if (starred) return 'starred';
  const t = new Date(iso);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ms = t.getTime();
  if (ms >= startToday) return 'today';
  if (ms >= startToday - 86_400_000) return 'yesterday';
  if (ms >= startToday - 7 * 86_400_000) return 'week';
  if (ms >= startToday - 30 * 86_400_000) return 'month';
  return 'older';
}

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowDown, ArrowUp, Bell, BellRing, ChevronLeft, ChevronRight, Download, RefreshCw, Search, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { CurrentUser } from '@/modules/auth/authorization';
import {
  PACKAGE_COLUMNS, PACKAGE_COLUMN_MAP, type PackageColumnDefinition,
} from '@/modules/packages/packages-columns';
import {
  type PackageQueryState, type TablePreferenceConfig,
} from '@/modules/packages/packages-filters';
import { type PackagesListResult, type PackageListRow } from '@/modules/packages/packages-service';
import {
  formatCurrency, formatDateOnly, getPackageStatusConfig,
} from '@/modules/packages/packages-helpers';
import { PackagePreviewDrawer } from './PackagePreviewDrawer';
import type { TableViewRow } from '@/modules/sales/table-views-service';

interface SyncRunInfo {
  run_id: string; mode: string; status: string; started_at: string; completed_at: string | null;
  pages_scanned?: number; records_seen?: number; records_pending?: number;
  details_fetched?: number; details_failed?: number; error_code?: string | null;
}
interface SyncStatus { active_run: SyncRunInfo | null; latest_run: SyncRunInfo | null; }

export interface PackagesWorkspaceProps {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: PackagesListResult;
  initialQuery: PackageQueryState;
  preference: TablePreferenceConfig;
  views: { privateViews: TableViewRow[]; sharedViews: TableViewRow[] };
  defaultViewId: string | null;
  watchedIds: Set<string>;
  unreadNotifications: number;
  canExport: boolean;
  canWatch: boolean;
  canShareViews: boolean;
  initialSyncStatus?: SyncStatus | null;
  savePreferenceAction: (config: TablePreferenceConfig) => Promise<{ error: string | null; success: boolean }>;
  resetPreferenceAction: () => Promise<{ error: string | null; success: boolean }>;
  createViewAction: (prevState: { error: string | null; success: boolean; viewId: string | null }, formData: FormData) => Promise<{ error: string | null; success: boolean; viewId: string | null }>;
  watchAction: (prevState: { error: string | null; success: boolean; isWatched: boolean }, formData: FormData) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  unwatchAction: (prevState: { error: string | null; success: boolean; isWatched: boolean }, formData: FormData) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  bulkWatchAction: (prevState: { error: string | null; success: boolean; isWatched: boolean }, formData: FormData) => Promise<{ error: string | null; success: boolean; isWatched: boolean }>;
  exportAction: (prevState: { error: string | null; success: boolean; content: string | null; filename: string | null; format: string | null }, formData: FormData) => Promise<{ error: string | null; success: boolean; content: string | null; filename: string | null; format: string | null }>;
}

const VISIBLE_COLUMNS = PACKAGE_COLUMNS.filter((c) => c.defaultVisible);

export function PackagesWorkspace({
  user: _user, tableKey: _tableKey, entityLabel, entityLabelPlural, basePath,
  permissionView: _permissionView, permissionExport: _permissionExport,
  permissionWatch: _permissionWatch, permissionShareViews: _permissionShareViews,
  initialData, initialQuery, preference: _preference, views: _views,
  defaultViewId: _defaultViewId, watchedIds, unreadNotifications: _unreadNotifications,
  canExport, canWatch, canShareViews: _canShareViews, initialSyncStatus,
  savePreferenceAction: _savePreferenceAction, resetPreferenceAction: _resetPreferenceAction,
  createViewAction: _createViewAction, watchAction, unwatchAction,
  bulkWatchAction: _bulkWatchAction, exportAction,
}: PackagesWorkspaceProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<PackagesListResult>(initialData);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState(initialQuery.search ?? '');
  const [sort, setSort] = useState(initialQuery.sort);
  const [page, setPage] = useState(initialQuery.page);
  const [pageSize] = useState(initialQuery.page_size);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(initialSyncStatus ?? null);
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [localWatched, setLocalWatched] = useState<Set<string>>(watchedIds);

  const updateUrl = useCallback((updates: { search?: string; page?: number; sort?: typeof sort }) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (updates.search !== undefined) { if (updates.search) params.set('search', updates.search); else params.delete('search'); }
    if (updates.page !== undefined) { if (updates.page > 1) params.set('page', String(updates.page)); else params.delete('page'); }
    if (updates.sort !== undefined) { if (updates.sort.length > 0) params.set('sort', JSON.stringify(updates.sort)); else params.delete('sort'); }
    router.push(`${basePath}?${params.toString()}`);
  }, [basePath, router, searchParams]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (page > 1) params.set('page', String(page));
      params.set('page_size', String(pageSize));
      if (sort.length > 0) params.set('sort', JSON.stringify(sort));
      const res = await fetch(`${basePath}/api?${params.toString()}`);
      if (!res.ok) throw new Error('Error al cargar datos');
      const json = await res.json();
      setData(json);
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Error'); }
    finally { setLoading(false); }
  }, [basePath, search, page, pageSize, sort]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (page !== 1 || search !== (initialQuery.search ?? '')) fetchData();
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => { fetchData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, sort]);

  const handleSort = (columnId: string) => {
    const column = PACKAGE_COLUMN_MAP[columnId];
    if (!column || !column.sortable) return;
    const existing = sort.find((s) => s.field === column.field);
    if (existing) {
      if (existing.direction === 'asc') {
        const newSort = sort.map((s) => s.field === column.field ? { ...s, direction: 'desc' as const } : s);
        setSort(newSort); updateUrl({ sort: newSort });
      } else {
        const newSort = sort.filter((s) => s.field !== column.field);
        setSort(newSort); updateUrl({ sort: newSort });
      }
    } else {
      const newSort = [...sort, { field: column.field, direction: 'asc' as const }];
      setSort(newSort); updateUrl({ sort: newSort });
    }
  };

  const handleSearch = (value: string) => { setSearch(value); setPage(1); updateUrl({ search: value, page: 1 }); };
  const handlePageChange = (newPage: number) => { setPage(newPage); updateUrl({ page: newPage }); };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`${basePath}/sync`, { method: 'POST' });
      if (res.status === 409) { toast.info('Ya hay una sincronización en progreso'); return; }
      if (!res.ok) throw new Error('Error al iniciar sincronización');
      toast.success('Sincronización iniciada');
      const poll = setInterval(async () => {
        const statusRes = await fetch(`${basePath}/sync/status`);
        if (statusRes.ok) {
          const status = await statusRes.json();
          setSyncStatus(status);
          if (!status.active_run) { clearInterval(poll); setSyncing(false); fetchData(); }
        }
      }, 3000);
      setTimeout(() => clearInterval(poll), 120_000);
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Error'); setSyncing(false); }
  };

  const handleExport = async (format: 'csv' | 'xlsx') => {
    if (!canExport) return;
    setExporting(true);
    try {
      const formData = new FormData();
      formData.set('format', format);
      formData.set('scope', 'filtered');
      formData.set('query', JSON.stringify({ ...initialQuery, search, page, sort }));
      const result = await exportAction({ error: null, success: false, content: null, filename: null, format: null }, formData);
      if (result.success && result.content && result.filename) {
        const link = document.createElement('a');
        link.href = `data:application/octet-stream;base64,${result.content}`;
        link.download = result.filename;
        link.click();
        toast.success(`Exportado como ${format.toUpperCase()}`);
      } else { toast.error(result.error ?? 'Error al exportar'); }
    } finally { setExporting(false); }
  };

  const handleRowClick = (id: string) => setPreviewId(id);
  const handleWatchToggle = (id: string, watched: boolean) => {
    setLocalWatched((prev) => { const next = new Set(prev); if (watched) next.add(id); else next.delete(id); return next; });
  };

  const sortDirection = (field: string): 'asc' | 'desc' | null => {
    const s = sort.find((s) => s.field === field);
    return s ? s.direction : null;
  };

  const { data: rows, pagination } = data;

  return (
    <div className="app-content">
      <div className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{entityLabelPlural}</h1>
            <p className="text-sm text-muted-foreground">{pagination.total} {entityLabelPlural.toLowerCase()}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleSync} disabled={syncing} className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50 transition-colors">
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Sincronizando…' : 'Actualizar'}
            </button>
            {canExport && (<>
              <button onClick={() => handleExport('csv')} disabled={exporting} className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50 transition-colors">
                <Download className="h-4 w-4" />CSV
              </button>
              <button onClick={() => handleExport('xlsx')} disabled={exporting} className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50 transition-colors">
                <Download className="h-4 w-4" />XLSX
              </button>
            </>)}
          </div>
        </div>

        {syncStatus?.active_run && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" />
              <span>Sincronización en progreso ({syncStatus.active_run.mode})…</span>
            </div>
          </div>
        )}
        {syncStatus?.latest_run && !syncStatus.active_run && (
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            Última sincronización: {syncStatus.latest_run.status}
            {syncStatus.latest_run.completed_at ? ` — ${new Date(syncStatus.latest_run.completed_at).toLocaleString('es-MX')}` : ''}
            {syncStatus.latest_run.records_seen !== undefined && ` — ${syncStatus.latest_run.records_seen} registros, ${syncStatus.latest_run.details_fetched ?? 0} detalles`}
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input type="text" value={search} onChange={(e) => handleSearch(e.target.value)} placeholder={`Buscar ${entityLabelPlural.toLowerCase()}…`}
              className="w-full rounded-md border border-input bg-background pl-9 pr-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
            {search && <button onClick={() => handleSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 hover:bg-accent"><X className="h-3.5 w-3.5" /></button>}
          </div>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  {VISIBLE_COLUMNS.map((col) => {
                    const dir = sortDirection(col.field);
                    return (
                      <th key={col.id} onClick={() => handleSort(col.id)}
                        className={`px-3 py-2.5 text-xs font-medium uppercase tracking-wide whitespace-nowrap ${col.sortable ? 'cursor-pointer hover:bg-muted' : ''} ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'}`}
                        style={{ width: col.defaultWidth }}>
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {col.sortable && dir === 'asc' && <ArrowUp className="h-3 w-3" />}
                          {col.sortable && dir === 'desc' && <ArrowDown className="h-3 w-3" />}
                        </span>
                      </th>
                    );
                  })}
                  {canWatch && <th className="w-10 px-2" />}
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr><td colSpan={VISIBLE_COLUMNS.length + 1} className="px-3 py-12 text-center text-muted-foreground">
                    <div className="inline-flex items-center gap-2"><div className="h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-primary" />Cargando…</div>
                  </td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={VISIBLE_COLUMNS.length + 1} className="px-3 py-12 text-center text-muted-foreground">
                    No hay {entityLabelPlural.toLowerCase()} para mostrar
                  </td></tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id} onClick={() => handleRowClick(row.id)} className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors">
                      {VISIBLE_COLUMNS.map((col) => (
                        <td key={col.id} className={`px-3 py-2.5 whitespace-nowrap ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'}`}>
                          {formatCell(row, col)}
                        </td>
                      ))}
                      {canWatch && (
                        <td className="px-2 text-center" onClick={(e) => e.stopPropagation()}>
                          <WatchToggle id={row.id} watched={localWatched.has(row.id)} canWatch={canWatch}
                            watchAction={watchAction} unwatchAction={unwatchAction}
                            onToggle={(watched) => handleWatchToggle(row.id, watched)} />
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {pagination.total_pages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Página {pagination.page} de {pagination.total_pages}</p>
            <div className="flex items-center gap-2">
              <button onClick={() => handlePageChange(page - 1)} disabled={page <= 1} className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50 transition-colors">
                <ChevronLeft className="h-4 w-4" />Anterior
              </button>
              <button onClick={() => handlePageChange(page + 1)} disabled={page >= pagination.total_pages} className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50 transition-colors">
                Siguiente<ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {previewId && (
        <PackagePreviewDrawer packageId={previewId} basePath={basePath} entityLabel={entityLabel}
          onClose={() => setPreviewId(null)} canWatch={canWatch} isWatched={localWatched.has(previewId)}
          onWatchChange={(watched) => handleWatchToggle(previewId, watched)}
          watchAction={watchAction} unwatchAction={unwatchAction} />
      )}
    </div>
  );
}

function formatCell(row: PackageListRow, col: PackageColumnDefinition): React.ReactNode {
  const value = (row as unknown as Record<string, unknown>)[col.id];
  if (value === null || value === undefined) return '—';
  if (col.formatter === 'date') return formatDateOnly(value as string | Date);
  if (col.formatter === 'statusDot') {
    const config = getPackageStatusConfig(value as string | null);
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${
          config.tone === 'success' ? 'bg-success'
          : config.tone === 'danger' ? 'bg-destructive'
          : config.tone === 'warning' ? 'bg-warning'
          : config.tone === 'info' ? 'bg-info'
          : 'bg-muted-foreground'
        }`} />
        {config.label}
      </span>
    );
  }
  return String(value);
}

function WatchToggle({ id, watched, canWatch, watchAction, unwatchAction, onToggle }: {
  id: string; watched: boolean; canWatch: boolean;
  watchAction: PackagesWorkspaceProps['watchAction'];
  unwatchAction: PackagesWorkspaceProps['unwatchAction'];
  onToggle: (watched: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canWatch || loading) return;
    setLoading(true);
    const formData = new FormData();
    formData.set('entityId', id);
    const result = watched
      ? await unwatchAction({ error: null, success: false, isWatched: true }, formData)
      : await watchAction({ error: null, success: false, isWatched: false }, formData);
    setLoading(false);
    if (result.success) onToggle(!watched);
    else toast.error(result.error ?? 'Error');
  };
  return (
    <button onClick={handleToggle} disabled={loading || !canWatch}
      className="inline-flex items-center justify-center rounded-md p-1 hover:bg-accent disabled:opacity-50 transition-colors"
      aria-label={watched ? 'Dejar de seguir' : 'Seguir'}>
      {loading ? <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      : watched ? <BellRing className="h-3.5 w-3.5 text-primary" />
      : <Bell className="h-3.5 w-3.5 text-muted-foreground" />}
    </button>
  );
}

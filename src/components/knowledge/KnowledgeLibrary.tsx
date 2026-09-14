'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui';
import { ATTENTION_STATUSES, api, displayStatus, errorMessage, isShareable, type SourceRow } from './knowledge-api';
import { LibraryTable } from './LibraryTable';
import { SourceDrawer } from './SourceDrawer';
import { UploadPanel } from './UploadPanel';
import { ConnectionsPanel } from './ConnectionsPanel';
import { SearchTester } from './SearchTester';

type TabId = 'all' | 'shareable' | 'upload' | 'connections' | 'test';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'all', label: 'Todo' },
  { id: 'shareable', label: 'Para compartir' },
  { id: 'upload', label: 'Subir' },
  { id: 'connections', label: 'Conexiones' },
  { id: 'test', label: 'Probar la IA' },
];

export function KnowledgeLibrary() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const load = useCallback(async () => {
    try {
      const data = await api<{ sources: SourceRow[] }>('/app/admin/knowledge/api/sources');
      setSources(data.sources);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while something is being processed.
  const processing = sources.some((s) => s.versions.some((v) => v.status === 'processing'));
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [processing, load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  const stats = useMemo(() => {
    const statuses = sources.map(displayStatus);
    return {
      total: sources.length,
      approved: statuses.filter((s) => s === 'approved' || s === 'update').length,
      shareable: sources.filter(isShareable).length,
      attention: statuses.filter((s) => ATTENTION_STATUSES.includes(s)).length,
      processing: statuses.filter((s) => s === 'processing').length,
    };
  }, [sources]);

  const openSource = sources.find((s) => s.id === openId) ?? null;

  function goTo(next: TabId, filter = '') {
    setTab(next);
    setStatusFilter(filter);
  }

  function onTabKey(event: React.KeyboardEvent, index: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  const statCards: Array<{ key: string; label: string; value: number; active: boolean; tone?: string; onClick: () => void }> = [
    { key: 'total', label: 'Fuentes', value: stats.total, active: tab === 'all' && !statusFilter, onClick: () => goTo('all') },
    { key: 'approved', label: 'Aprobadas — la IA las usa', value: stats.approved, active: tab === 'all' && statusFilter === 'approved', onClick: () => goTo('all', 'approved') },
    { key: 'shareable', label: 'Se pueden enviar a clientes', value: stats.shareable, active: tab === 'shareable', onClick: () => goTo('shareable') },
    { key: 'attention', label: stats.processing > 0 ? `Requieren atención · ${stats.processing} procesando` : 'Requieren atención', value: stats.attention, active: tab === 'all' && statusFilter === 'attention', tone: stats.attention > 0 ? 'warn' : undefined, onClick: () => goTo('all', 'attention') },
  ];

  return (
    <div className="klib">
      {error && (
        <div className="klib-note klib-note-danger" role="alert">
          <AlertCircle size={16} />
          <div className="klib-note-body">{error}</div>
          <Button size="sm" variant="secondary" type="button" onClick={() => void load()}>
            Reintentar
          </Button>
        </div>
      )}

      <div className="klib-stats">
        {statCards.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`klib-stat${c.tone === 'warn' ? ' klib-stat-warn' : ''}`}
            aria-pressed={c.active}
            onClick={c.onClick}
          >
            <span className="klib-stat-value">{loading ? '—' : c.value}</span>
            <span className="klib-stat-label">{c.label}</span>
          </button>
        ))}
      </div>

      <div className="klib-head">
        <div className="tabs" role="tablist" aria-label="Secciones de la biblioteca">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`klib-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`klib-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className="tab"
              onClick={() => goTo(t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t.label}
              {t.id === 'all' && !loading ? <span className="klib-tab-count">{stats.total}</span> : null}
              {t.id === 'shareable' && !loading ? <span className="klib-tab-count">{stats.shareable}</span> : null}
            </button>
          ))}
        </div>
        {tab !== 'upload' && (
          <div className="klib-head-actions">
            <Button type="button" size="sm" icon={<UploadCloud size={15} />} onClick={() => goTo('upload')}>
              Subir
            </Button>
          </div>
        )}
      </div>

      <div role="tabpanel" id={`klib-panel-${tab}`} aria-labelledby={`klib-tab-${tab}`}>
        {loading ? (
          <div className="klib-card" aria-busy="true" aria-label="Cargando biblioteca">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="klib-skel" />
            ))}
          </div>
        ) : tab === 'all' || tab === 'shareable' ? (
          <LibraryTable
            key={tab}
            sources={sources}
            mode={tab}
            statusFilter={tab === 'all' ? statusFilter : ''}
            onStatusFilter={setStatusFilter}
            onOpen={setOpenId}
            onUpload={() => goTo('upload')}
          />
        ) : tab === 'upload' ? (
          <UploadPanel onCreated={load} onOpen={setOpenId} />
        ) : tab === 'connections' ? (
          <ConnectionsPanel />
        ) : (
          <SearchTester onOpen={setOpenId} />
        )}
      </div>

      <SourceDrawer
        source={openSource}
        onClose={() => setOpenId(null)}
        onChanged={load}
        onNotice={setNotice}
      />

      {notice && (
        <div className="klib-toast" role="status">
          <CheckCircle2 size={16} /> {notice}
        </div>
      )}
    </div>
  );
}

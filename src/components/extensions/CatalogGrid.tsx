'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Brain,
  Calendar,
  CheckSquare,
  Clock,
  Cloud,
  Code2,
  CreditCard,
  Database,
  Download,
  FileText,
  GitBranch,
  HardDrive,
  Map as MapIcon,
  MessageSquare,
  Search,
  Send,
  Shield,
  ShoppingBag,
  Sparkles,
  Square,
  TrendingUp,
  Users,
  Video,
  X,
  Zap,
} from 'lucide-react';
import {
  CURATED_CATALOG,
  groupByCategory,
  type CatalogKind,
  type CuratedEntry,
} from '@/modules/extensions/curated-catalog';

// ---------------------------------------------------------------------------
// Icon lookup — maps catalog icon names to lucide components
// ---------------------------------------------------------------------------

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Github: GitBranch,
  Gitlab: GitBranch,
  Square,
  Slack: MessageSquare,
  MessageSquare,
  Send,
  FileText,
  Calendar,
  CheckSquare,
  CreditCard,
  Sparkles,
  Brain,
  Users,
  Cloud,
  ShoppingBag,
  Database,
  HardDrive,
  Search,
  Download,
  Clock,
  Activity,
  AlertTriangle,
  TrendingUp,
  Video,
  Shield,
  Zap,
  Map: MapIcon,
};

function CatalogIcon({ name, size = 24 }: { name: string; size?: number }) {
  const Cmp = ICONS[name] ?? Zap;
  return <Cmp size={size} />;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const AUTH_LABELS: Record<string, string> = {
  oauth: 'OAuth 2.0',
  api_key: 'API Key',
  bearer: 'Bearer Token',
  none: 'Sin credenciales',
};

const KIND_LABELS: Record<string, string> = {
  api: 'API',
  mcp: 'MCP Server',
  plugin: 'Plugin',
  skill: 'Skill',
};

const KIND_FILTERS: { value: CatalogKind | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'api', label: 'APIs' },
  { value: 'mcp', label: 'MCP Servers' },
  { value: 'plugin', label: 'Plugins' },
  { value: 'skill', label: 'Skills' },
];

const AUTH_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'Cualquier auth' },
  { value: 'oauth', label: 'OAuth 2.0' },
  { value: 'api_key', label: 'API Key' },
  { value: 'bearer', label: 'Bearer' },
  { value: 'none', label: 'Sin credenciales' },
];

// ---------------------------------------------------------------------------
// Precomputed search index for fast lookup
// ---------------------------------------------------------------------------

interface SearchableEntry {
  entry: CuratedEntry;
  haystack: string; // precomputed lowercase haystack
}

const SEARCH_INDEX: SearchableEntry[] = CURATED_CATALOG.map((entry) => ({
  entry,
  haystack: [
    entry.name,
    entry.description,
    entry.longDescription,
    entry.category,
    entry.kind,
    entry.authType,
    ...entry.capabilities,
  ]
    .join(' ')
    .toLowerCase(),
}));

// ---------------------------------------------------------------------------
// Highlight helper
// ---------------------------------------------------------------------------

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const q = query.trim().toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="catalog-highlight">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CatalogGridProps {
  /** Called when the user clicks "Conectar" on a catalog entry. */
  onConnect: (entry: CuratedEntry) => void;
  /** IDs of extensions already created (to show "Conectado" badge). */
  connectedNamespaces?: string[];
  /** Filter by kind. */
  kindFilter?: CatalogKind | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CatalogGrid({
  onConnect,
  connectedNamespaces = [],
  kindFilter = null,
}: CatalogGridProps) {
  const [selected, setSelected] = useState<CuratedEntry | null>(null);
  const [query, setQuery] = useState('');
  const [kindChip, setKindChip] = useState<CatalogKind | 'all'>('all');
  const [authChip, setAuthChip] = useState<string>('all');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: "/" to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape' && query) {
        setQuery('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [query]);

  // Sync external kindFilter prop with internal chip
  useEffect(() => {
    if (kindFilter) setKindChip(kindFilter);
  }, [kindFilter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: CuratedEntry[] = [];

    for (const item of SEARCH_INDEX) {
      // Kind filter (external prop takes precedence)
      const effectiveKind = kindFilter ?? kindChip;
      if (effectiveKind !== 'all' && item.entry.kind !== effectiveKind) continue;
      // Auth filter
      if (authChip !== 'all' && item.entry.authType !== authChip) continue;
      // Query filter
      if (q && !item.haystack.includes(q)) continue;
      list.push(item.entry);
    }

    return list;
  }, [kindFilter, kindChip, authChip, query]);

  const grouped = useMemo(() => groupByCategory(filtered), [filtered]);

  // Category index with counts (for sidebar)
  const categoryIndex = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of SEARCH_INDEX) {
      const effectiveKind = kindFilter ?? kindChip;
      if (effectiveKind !== 'all' && item.entry.kind !== effectiveKind) continue;
      if (authChip !== 'all' && item.entry.authType !== authChip) continue;
      const q = query.trim().toLowerCase();
      if (q && !item.haystack.includes(q)) continue;
      counts.set(item.entry.category, (counts.get(item.entry.category) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [kindFilter, kindChip, authChip, query]);

  const isConnected = (entry: CuratedEntry) =>
    connectedNamespaces.some((ns) => ns === entry.id || ns.includes(entry.id));

  const scrollToCategory = (category: string) => {
    setActiveCategory(category);
    const el = document.getElementById(`catalog-cat-${category.replace(/\s+/g, '-')}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="catalog-grid-container">
      {/* Search bar */}
      <div className="catalog-search-bar">
        <Search size={16} className="catalog-search-icon" />
        <input
          ref={searchInputRef}
          type="text"
          className="catalog-search-input"
          placeholder="Buscar por nombre, función o categoría…  ( / para enfocar)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar integración"
        />
        {query && (
          <button
            type="button"
            className="catalog-search-clear"
            onClick={() => setQuery('')}
            aria-label="Limpiar búsqueda"
          >
            <X size={14} />
          </button>
        )}
        <span className="catalog-search-count">{filtered.length} disponibles</span>
      </div>

      {/* Filter chips */}
      <div className="catalog-filters">
        <div className="catalog-filter-group">
          <span className="catalog-filter-label">Tipo:</span>
          {KIND_FILTERS.map((k) => {
            const effectiveKind = kindFilter ?? kindChip;
            const active = effectiveKind === k.value;
            return (
              <button
                key={k.value}
                type="button"
                className={`catalog-chip ${active ? 'catalog-chip-active' : ''}`}
                onClick={() => setKindChip(k.value)}
                disabled={!!kindFilter}
              >
                {k.label}
              </button>
            );
          })}
        </div>
        <div className="catalog-filter-group">
          <span className="catalog-filter-label">Auth:</span>
          {AUTH_FILTERS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={`catalog-chip ${authChip === a.value ? 'catalog-chip-active' : ''}`}
              onClick={() => setAuthChip(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="catalog-layout">
        {/* Category sidebar */}
        <aside className="catalog-sidebar">
          <div className="catalog-sidebar-title">Categorías</div>
          <button
            type="button"
            className={`catalog-sidebar-item ${activeCategory === null ? 'catalog-sidebar-item-active' : ''}`}
            onClick={() => setActiveCategory(null)}
          >
            <span>Todas</span>
            <span className="catalog-sidebar-count">{filtered.length}</span>
          </button>
          {categoryIndex.map(([category, count]) => (
            <button
              key={category}
              type="button"
              className={`catalog-sidebar-item ${activeCategory === category ? 'catalog-sidebar-item-active' : ''}`}
              onClick={() => scrollToCategory(category)}
            >
              <span>{category}</span>
              <span className="catalog-sidebar-count">{count}</span>
            </button>
          ))}
        </aside>

        {/* Category groups */}
        <div className="catalog-content">
          {Object.entries(grouped).map(([category, entries]) => (
            <div
              key={category}
              id={`catalog-cat-${category.replace(/\s+/g, '-')}`}
              className="catalog-category-group"
            >
              <h3 className="catalog-category-title">
                {category} <span className="catalog-category-count">({entries.length})</span>
              </h3>
              <div className="catalog-grid">
                {entries.map((entry) => {
                  const connected = isConnected(entry);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`catalog-card ${connected ? 'catalog-card-connected' : ''}`}
                      onClick={() => setSelected(entry)}
                      aria-label={`Ver detalles de ${entry.name}`}
                    >
                      <div className="catalog-card-header">
                        <div
                          className="catalog-card-icon"
                          style={{ backgroundColor: entry.color }}
                        >
                          <CatalogIcon name={entry.icon} size={22} />
                        </div>
                        {entry.verified && (
                          <span className="catalog-card-verified" title="Verificado por UNIK">
                            <Shield size={12} />
                          </span>
                        )}
                        {connected && (
                          <span className="catalog-card-connected-badge">Conectado</span>
                        )}
                      </div>
                      <div className="catalog-card-body">
                        <div className="catalog-card-name">
                          <Highlight text={entry.name} query={query} />
                        </div>
                        <div className="catalog-card-kind">{KIND_LABELS[entry.kind]}</div>
                        <div className="catalog-card-desc">
                          <Highlight text={entry.description} query={query} />
                        </div>
                        <div className="catalog-card-tags">
                          <span className="catalog-card-tag">{AUTH_LABELS[entry.authType]}</span>
                          <span className="catalog-card-tag">{entry.capabilities.length} funciones</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="catalog-empty">
              <Search size={32} />
              <p>No se encontraron integraciones para &ldquo;{query}&rdquo;</p>
              <button
                type="button"
                className="catalog-empty-reset"
                onClick={() => {
                  setQuery('');
                  setKindChip('all');
                  setAuthChip('all');
                }}
              >
                Limpiar filtros
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Detail modal */}
      {selected && (
        <CatalogDetailModal
          entry={selected}
          connected={isConnected(selected)}
          onClose={() => setSelected(null)}
          onConnect={() => {
            onConnect(selected);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

function CatalogDetailModal({
  entry,
  connected,
  onClose,
  onConnect,
}: {
  entry: CuratedEntry;
  connected: boolean;
  onClose: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="catalog-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="catalog-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="catalog-modal-close"
          onClick={onClose}
          aria-label="Cerrar"
        >
          <X size={20} />
        </button>

        {/* Header */}
        <div className="catalog-modal-header">
          <div
            className="catalog-modal-icon"
            style={{ backgroundColor: entry.color }}
          >
            <CatalogIcon name={entry.icon} size={32} />
          </div>
          <div className="catalog-modal-title-block">
            <div className="catalog-modal-name">
              {entry.name}
              {entry.verified && (
                <span className="catalog-modal-verified" title="Verificado por UNIK">
                  <Shield size={14} /> Verificado
                </span>
              )}
            </div>
            <div className="catalog-modal-meta">
              <span className="catalog-modal-kind">{KIND_LABELS[entry.kind]}</span>
              <span className="catalog-modal-cat">{entry.category}</span>
              <span className="catalog-modal-auth">{AUTH_LABELS[entry.authType]}</span>
            </div>
          </div>
        </div>

        {/* Description */}
        <p className="catalog-modal-desc">{entry.longDescription}</p>

        {/* Capabilities */}
        <div className="catalog-modal-section">
          <h4 className="catalog-modal-section-title">
            <Zap size={14} /> ¿Qué puede hacer?
          </h4>
          <ul className="catalog-modal-capabilities">
            {entry.capabilities.map((cap, i) => (
              <li key={i} className="catalog-modal-capability">
                <CheckSquare size={14} className="catalog-modal-check" />
                {cap}
              </li>
            ))}
          </ul>
        </div>

        {/* Connection steps */}
        <div className="catalog-modal-section">
          <h4 className="catalog-modal-section-title">
            <Code2 size={14} /> Cómo conectar rápido
          </h4>
          <ol className="catalog-modal-steps">
            {entry.connectionSteps.map((step, i) => (
              <li key={i} className="catalog-modal-step">
                <span className="catalog-modal-step-num">{i + 1}</span>
                <span className="catalog-modal-step-text">{step}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Security */}
        <div className="catalog-modal-section catalog-modal-security-section">
          <h4 className="catalog-modal-section-title">
            <Shield size={14} /> Seguridad y privacidad
          </h4>
          <p className="catalog-modal-security">{entry.securityInfo}</p>
          {entry.allowedHosts.length > 0 && (
            <div className="catalog-modal-hosts">
              <span className="catalog-modal-hosts-label">Dominios aprobados:</span>
              {entry.allowedHosts.map((h) => (
                <code key={h} className="catalog-modal-host">{h}</code>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="catalog-modal-actions">
          <a
            href={entry.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="catalog-modal-docs-btn"
          >
            Ver documentación
          </a>
          <button
            type="button"
            className="catalog-modal-connect-btn"
            onClick={onConnect}
            disabled={connected}
          >
            {connected ? 'Ya conectado' : 'Conectar ahora'}
          </button>
        </div>
      </div>
    </div>
  );
}

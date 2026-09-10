'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDown,
  ArrowUp,
  Bell,
  BellRing,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  EyeOff,
  Maximize2,
  Minimize2,
  Pin,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { CurrentUser } from '@/modules/auth/authorization';
import {
  type EntityColumnDefinition,
  type TablePreferenceConfig,
  type EntityQueryState,
  type EntityListResult,
  type SyncStatus,
  type StatusConfig,
  type StatusOption,
  type SavePreferenceAction,
  type ResetPreferenceAction,
  type CreateViewAction,
  type WatchAction,
  type BulkWatchAction,
  type ExportAction,
  type TableViewRow,
  FILTER_OPERATORS_BY_TYPE,
  FILTER_OPERATOR_LABELS,
  DATE_SHORTCUTS,
  DATE_SHORTCUT_LABELS,
} from '@/modules/shared/entity-workspace-types';

type Density = 'compact' | 'normal' | 'comfortable';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EntityWorkspaceProps<TRow extends { id: string }> {
  user: CurrentUser;
  tableKey: string;
  entityLabel: string;
  entityLabelPlural: string;
  basePath: string;
  permissionView: string;
  permissionExport: string;
  permissionWatch: string;
  permissionShareViews: string;
  initialData: EntityListResult<TRow>;
  initialQuery: EntityQueryState;
  preference: TablePreferenceConfig;
  views: { privateViews: TableViewRow[]; sharedViews: TableViewRow[] };
  defaultViewId: string | null;
  watchedIds: Set<string>;
  unreadNotifications: number;
  canExport: boolean;
  canWatch: boolean;
  canShareViews: boolean;
  initialSyncStatus?: SyncStatus | null;
  // Column registry
  columns: EntityColumnDefinition[];
  columnMap: Record<string, EntityColumnDefinition>;
  defaultColumnOrder: string[];
  // Callbacks
  renderCell: (row: TRow, column: EntityColumnDefinition) => React.ReactNode;
  getStatusConfig?: (value: string | null) => StatusConfig;
  getStatusLabel?: (value: string) => string;
  getStatusOptions?: () => StatusOption[];
  formatCurrency?: (value: string | null, currencyCode?: string | null) => string;
  formatDateOnly?: (value: string | null) => string;
  // Name field for copy/watch indicator/aria-label
  nameField: string;
  searchPlaceholder?: string;
  // Actions
  savePreferenceAction: SavePreferenceAction;
  resetPreferenceAction: ResetPreferenceAction;
  createViewAction: CreateViewAction;
  watchAction: WatchAction;
  unwatchAction: WatchAction;
  bulkWatchAction: BulkWatchAction;
  exportAction: ExportAction;
  // Preview drawer renderer
  renderPreviewDrawer?: (props: {
    entityId: string;
    basePath: string;
    entityLabel: string;
    onClose: () => void;
    canWatch: boolean;
    isWatched: boolean;
    onWatchChange: (watched: boolean) => void;
    watchAction: WatchAction;
    unwatchAction: WatchAction;
  }) => React.ReactNode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeTablePreference(
  p: TablePreferenceConfig,
  columns: EntityColumnDefinition[],
  defaultColumnOrder: string[]
): TablePreferenceConfig {
  const defaultVisibility = Object.fromEntries(
    columns.map((c) => [c.id, c.defaultVisible])
  );
  const defaultWidths = Object.fromEntries(
    columns.map((c) => [c.id, c.defaultWidth])
  );
  const savedOrder = p.columnOrder.length > 0 ? p.columnOrder : defaultColumnOrder;
  const missing = defaultColumnOrder.filter((id) => !savedOrder.includes(id));
  return {
    ...p,
    columnOrder: [...savedOrder, ...missing],
    columnVisibility: { ...defaultVisibility, ...p.columnVisibility },
    columnWidths: { ...defaultWidths, ...p.columnWidths },
  };
}

// ---------------------------------------------------------------------------
// SortableHeader
// ---------------------------------------------------------------------------

interface SortableHeaderProps {
  columnId: string;
  column: EntityColumnDefinition;
  width: number;
  isPinnedLeft: boolean;
  isPinnedRight: boolean;
  leftOffset?: number;
  rightOffset?: number;
  sortDirection: 'asc' | 'desc' | null;
  onSort: (columnId: string, shiftKey: boolean) => void;
  onResize: (columnId: string, width: number) => void;
  onTogglePin: (columnId: string, side: 'left' | 'right') => void;
  onHide: (columnId: string) => void;
  onMoveLeft: (columnId: string) => void;
  onMoveRight: (columnId: string) => void;
  onAddFilter: (columnId: string) => void;
}

function SortableHeader({
  columnId,
  column,
  width,
  isPinnedLeft,
  isPinnedRight,
  leftOffset,
  rightOffset,
  sortDirection,
  onSort,
  onResize,
  onTogglePin,
  onHide,
  onMoveLeft,
  onMoveRight,
  onAddFilter,
}: SortableHeaderProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: columnId,
    disabled: isPinnedLeft || isPinnedRight,
  });

  const [resizing, setResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    width,
    minWidth: column.minWidth,
    maxWidth: column.maxWidth,
    opacity: isDragging ? 0.5 : 1,
    ...(isPinnedLeft ? { left: leftOffset } : {}),
    ...(isPinnedRight ? { right: rightOffset } : {}),
  };

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;
  };

  useEffect(() => {
    if (!resizing) return;
    function onMouseMove(e: MouseEvent) {
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.max(
        column.minWidth,
        Math.min(column.maxWidth, startWidthRef.current + delta)
      );
      onResize(columnId, newWidth);
    }
    function onMouseUp() {
      setResizing(false);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [resizing, columnId, column.minWidth, column.maxWidth, onResize]);

  const alignClass =
    column.align === 'right' ? 'justify-end' : column.align === 'center' ? 'justify-center' : '';

  return (
    <th
      ref={setNodeRef}
      style={style}
      className={`so-th ${isPinnedLeft ? 'so-th-pinned-left' : ''} ${isPinnedRight ? 'so-th-pinned-right' : ''} ${column.sortable ? 'so-th-sortable' : ''}`}
      {...attributes}
      {...listeners}
    >
      <div className={`so-th-content ${alignClass}`}>
        <span
          onClick={(e) => {
            if (column.sortable) onSort(columnId, e.shiftKey);
          }}
        >
          {column.label}
        </span>
        {sortDirection === 'asc' ? (
          <ArrowUp size={12} className="text-muted-foreground" />
        ) : sortDirection === 'desc' ? (
          <ArrowDown size={12} className="text-muted-foreground" />
        ) : null}
        <button
          type="button"
          className="so-filter-remove"
          style={{ width: 20, height: 20 }}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
          aria-label={`Menú de columna ${column.label}`}
        >
          <ChevronDown size={14} />
        </button>
        {menuOpen ? (
          <div
            ref={menuRef}
            className="so-view-dropdown"
            style={{ top: '100%', right: 0, left: 'auto', minWidth: 200 }}
          >
            {column.sortable ? (
              <>
                <button
                  className="so-view-dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSort(columnId, false);
                    setMenuOpen(false);
                  }}
                >
                  <ArrowUp size={14} /> Ordenar ascendente
                </button>
                <button
                  className="so-view-dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSort(columnId, true);
                    setMenuOpen(false);
                  }}
                >
                  <ArrowDown size={14} /> Ordenar descendente
                </button>
                <div style={{ borderTop: '1px solid var(--unik-border)', margin: '4px 0' }} />
              </>
            ) : null}
            <button
              className="so-view-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(columnId, isPinnedLeft ? 'left' : isPinnedRight ? 'right' : 'left');
                setMenuOpen(false);
              }}
            >
              <Pin size={14} /> {isPinnedLeft ? 'Desfijar' : 'Fijar a la izquierda'}
            </button>
            {!isPinnedRight ? (
              <button
                className="so-view-dropdown-item"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(columnId, 'right');
                  setMenuOpen(false);
                }}
              >
                <Pin size={14} /> Fijar a la derecha
              </button>
            ) : null}
            <div style={{ borderTop: '1px solid var(--unik-border)', margin: '4px 0' }} />
            <button
              className="so-view-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                onMoveLeft(columnId);
                setMenuOpen(false);
              }}
            >
              <ChevronLeft size={14} /> Mover izquierda
            </button>
            <button
              className="so-view-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                onMoveRight(columnId);
                setMenuOpen(false);
              }}
            >
              <ChevronRight size={14} /> Mover derecha
            </button>
            {column.filterable ? (
              <>
                <div style={{ borderTop: '1px solid var(--unik-border)', margin: '4px 0' }} />
                <button
                  className="so-view-dropdown-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddFilter(columnId);
                    setMenuOpen(false);
                  }}
                >
                  <SlidersHorizontal size={14} /> Filtrar por esta columna
                </button>
              </>
            ) : null}
            <div style={{ borderTop: '1px solid var(--unik-border)', margin: '4px 0' }} />
            <button
              className="so-view-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                onHide(columnId);
                setMenuOpen(false);
              }}
            >
              <EyeOff size={14} /> Ocultar columna
            </button>
          </div>
        ) : null}
      </div>
      <div
        className={`so-resize-handle ${resizing ? 'active' : ''}`}
        onMouseDown={handleMouseDown}
        aria-hidden="true"
      />
    </th>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function EntityWorkspace<TRow extends { id: string }>({
  entityLabel,
  entityLabelPlural,
  basePath,
  initialData,
  initialQuery,
  preference,
  views,
  watchedIds: initialWatchedIds,
  unreadNotifications,
  canExport,
  canWatch,
  canShareViews,
  initialSyncStatus,
  columns,
  columnMap,
  defaultColumnOrder,
  renderCell,
  getStatusLabel,
  getStatusOptions,
  nameField,
  searchPlaceholder,
  savePreferenceAction,
  resetPreferenceAction,
  createViewAction,
  watchAction,
  unwatchAction,
  bulkWatchAction,
  exportAction,
  renderPreviewDrawer,
}: EntityWorkspaceProps<TRow>) {
  const router = useRouter();

  const [query, setQuery] = useState<EntityQueryState>(initialQuery);
  const [data, setData] = useState<EntityListResult<TRow>>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pref, setPref] = useState<TablePreferenceConfig>(() =>
    normalizeTablePreference(preference, columns, defaultColumnOrder)
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [watchedIds, setWatchedIds] = useState<Set<string>>(initialWatchedIds);
  const [, setUnreadCount] = useState(unreadNotifications);

  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(initialSyncStatus ?? null);
  const [syncTriggering, setSyncTriggering] = useState(false);
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [columnManagerOpen, setColumnManagerOpen] = useState(false);
  const [viewSelectorOpen, setViewSelectorOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [saveViewModalOpen, setSaveViewModalOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [viewVisibility, setViewVisibility] = useState<'private' | 'shared'>('private');

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const updateUrl = useCallback(
    (newQuery: EntityQueryState) => {
      const params = new URLSearchParams();
      if (newQuery.search) params.set('search', newQuery.search);
      if (newQuery.page > 1) params.set('page', String(newQuery.page));
      if (newQuery.page_size !== 50) params.set('page_size', String(newQuery.page_size));
      if (newQuery.sort.length > 0) params.set('sort', JSON.stringify(newQuery.sort));
      if (newQuery.filters.rules.length > 0)
        params.set('filters', JSON.stringify(newQuery.filters));
      router.replace(`${basePath}?${params.toString()}`, { scroll: false });
    },
    [router, basePath]
  );

  const fetchData = useCallback(async (q: EntityQueryState) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${basePath}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(q),
      });
      if (!res.ok) throw new Error(`No pudimos cargar los ${entityLabelPlural.toLowerCase()}.`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : `No pudimos cargar los ${entityLabelPlural.toLowerCase()}.`);
    } finally {
      setLoading(false);
    }
  }, [basePath, entityLabelPlural]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setQuery((prev) => {
        const next = { ...prev, search: value, page: 1 };
        updateUrl(next);
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => fetchData(next), 350);
        return next;
      });
    },
    [fetchData, updateUrl]
  );

  const savePreference = useCallback((newPref: TablePreferenceConfig) => {
    setPref(newPref);
    if (prefTimerRef.current) clearTimeout(prefTimerRef.current);
    prefTimerRef.current = setTimeout(() => {
      savePreferenceAction(newPref).catch(() => {
        toast.error('No se pudo guardar la preferencia');
      });
    }, 800);
  }, [savePreferenceAction]);

  const handleSort = useCallback(
    (columnId: string, shiftKey: boolean) => {
      const column = columnMap[columnId];
      if (!column || !column.sortable) return;
      setQuery((prev) => {
        const existing = prev.sort.find((s) => s.field === column.field);
        let newSort;
        if (!existing) {
          newSort = shiftKey
            ? [...prev.sort, { field: column.field, direction: 'desc' as const }]
            : [{ field: column.field, direction: 'desc' as const }];
        } else if (existing.direction === 'desc') {
          newSort = shiftKey
            ? prev.sort.map((s) =>
                s.field === column.field ? { ...s, direction: 'asc' as const } : s
              )
            : [{ field: column.field, direction: 'asc' as const }];
        } else {
          newSort = shiftKey ? prev.sort.filter((s) => s.field !== column.field) : [];
        }
        const next = { ...prev, sort: newSort, page: 1 };
        updateUrl(next);
        fetchData(next);
        return next;
      });
    },
    [columnMap, fetchData, updateUrl]
  );

  const visibleColumns = useMemo(() => {
    const order =
      pref.columnOrder.length > 0 ? pref.columnOrder : columns.map((c) => c.id);
    return order
      .filter((id) => pref.columnVisibility[id] !== false && columnMap[id])
      .map((id) => columnMap[id])
      .filter(Boolean);
  }, [pref.columnOrder, pref.columnVisibility, columns, columnMap]);

  const columnOffsets = useMemo(() => {
    const { left: pinnedLeft, right: pinnedRight } = pref.columnPinning;
    const offsets: Record<string, { left?: number; right?: number }> = {};
    let left = 40;
    for (const col of visibleColumns) {
      const width = pref.columnWidths[col.id] ?? col.defaultWidth;
      if (pinnedLeft.includes(col.id)) {
        offsets[col.id] = { ...offsets[col.id], left };
      }
      left += width;
    }
    let right = 50;
    for (let i = visibleColumns.length - 1; i >= 0; i--) {
      const col = visibleColumns[i];
      const width = pref.columnWidths[col.id] ?? col.defaultWidth;
      if (pinnedRight.includes(col.id)) {
        offsets[col.id] = { ...offsets[col.id], right };
      }
      right += width;
    }
    return offsets;
  }, [visibleColumns, pref.columnWidths, pref.columnPinning]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setPref((prev) => {
        const order =
          prev.columnOrder.length > 0 ? prev.columnOrder : columns.map((c) => c.id);
        const oldIndex = order.indexOf(active.id as string);
        const newIndex = order.indexOf(over.id as string);
        if (oldIndex === -1 || newIndex === -1) return prev;
        const newOrder = [...order];
        [newOrder[oldIndex], newOrder[newIndex]] = [newOrder[newIndex], newOrder[oldIndex]];
        const newPref = { ...prev, columnOrder: newOrder };
        savePreference(newPref);
        return newPref;
      });
    },
    [columns, savePreference]
  );

  const handleResize = useCallback((columnId: string, width: number) => {
    setPref((prev) => ({
      ...prev,
      columnWidths: { ...prev.columnWidths, [columnId]: width },
    }));
  }, []);

  const handleToggleColumn = useCallback(
    (columnId: string) => {
      setPref((prev) => {
        const newVis = {
          ...prev.columnVisibility,
          [columnId]: !(prev.columnVisibility[columnId] !== false),
        };
        const newPref = { ...prev, columnVisibility: newVis };
        savePreference(newPref);
        return newPref;
      });
    },
    [savePreference]
  );

  const handleHideColumn = useCallback(
    (columnId: string) => {
      setPref((prev) => {
        const newPref = {
          ...prev,
          columnVisibility: { ...prev.columnVisibility, [columnId]: false },
        };
        savePreference(newPref);
        return newPref;
      });
    },
    [savePreference]
  );

  const handleTogglePin = useCallback(
    (columnId: string, side: 'left' | 'right') => {
      setPref((prev) => {
        const left = prev.columnPinning.left.filter((id) => id !== columnId);
        const right = prev.columnPinning.right.filter((id) => id !== columnId);
        if (side === 'left' && !left.includes(columnId)) left.push(columnId);
        if (side === 'right' && !right.includes(columnId)) right.push(columnId);
        const newPref = { ...prev, columnPinning: { left, right } };
        savePreference(newPref);
        return newPref;
      });
    },
    [savePreference]
  );

  const handleMoveColumn = useCallback(
    (columnId: string, direction: 'left' | 'right') => {
      setPref((prev) => {
        const order =
          prev.columnOrder.length > 0 ? prev.columnOrder : columns.map((c) => c.id);
        const idx = order.indexOf(columnId);
        if (idx === -1) return prev;
        const newIdx = direction === 'left' ? idx - 1 : idx + 1;
        if (newIdx < 0 || newIdx >= order.length) return prev;
        const newOrder = [...order];
        [newOrder[idx], newOrder[newIdx]] = [newOrder[newIdx], newOrder[idx]];
        const newPref = { ...prev, columnOrder: newOrder };
        savePreference(newPref);
        return newPref;
      });
    },
    [columns, savePreference]
  );

  const handleDensityChange = useCallback(
    (density: Density) => {
      setPref((prev) => {
        const newPref = { ...prev, density };
        savePreference(newPref);
        return newPref;
      });
    },
    [savePreference]
  );

  const handlePageSizeChange = useCallback(
    (pageSize: number) => {
      setPref((prev) => {
        const newPref = { ...prev, pageSize };
        savePreference(newPref);
        return newPref;
      });
      setQuery((prev) => {
        const next = { ...prev, page_size: pageSize, page: 1 };
        updateUrl(next);
        fetchData(next);
        return next;
      });
    },
    [fetchData, updateUrl, savePreference]
  );

  const handleResetColumns = useCallback(async () => {
    await resetPreferenceAction();
    const defaultPref: TablePreferenceConfig = {
      version: 1,
      columnOrder: columns.sort((a, b) => a.priority - b.priority).map((c) => c.id),
      columnVisibility: Object.fromEntries(columns.map((c) => [c.id, c.defaultVisible])),
      columnWidths: Object.fromEntries(columns.map((c) => [c.id, c.defaultWidth])),
      columnPinning: { left: [], right: [] },
      density: 'normal',
      pageSize: 50,
    };
    setPref(defaultPref);
    toast.success('Preferencias restablecidas');
  }, [resetPreferenceAction, columns]);

  const toggleRowSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePageSelection = useCallback(() => {
    setSelectedIds((prev) => {
      const allSelected = data.data.every((o) => prev.has(o.id));
      if (allSelected) {
        const next = new Set(prev);
        data.data.forEach((o) => next.delete(o.id));
        return next;
      }
      const next = new Set(prev);
      data.data.forEach((o) => next.add(o.id));
      return next;
    });
  }, [data.data]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const addFilter = useCallback((columnId?: string) => {
    setFilterPanelOpen(true);
    const column = columnId
      ? columnMap[columnId]
      : columns.find((c) => c.filterable && c.type === 'text');
    if (!column || !column.filterable) return;
    const operators = FILTER_OPERATORS_BY_TYPE[column.type] ?? ['contains'];
    const operator = operators[0] as string;
    setQuery((prev) => {
      const newRules = [
        ...prev.filters.rules,
        { field: column.field, operator, value: '' },
      ];
      const next = { ...prev, filters: { ...prev.filters, rules: newRules }, page: 1 };
      return next;
    });
  }, [columnMap, columns]);

  const removeFilter = useCallback(
    (index: number) => {
      setQuery((prev) => {
        const newRules = prev.filters.rules.filter((_, i) => i !== index);
        const next = { ...prev, filters: { ...prev.filters, rules: newRules }, page: 1 };
        updateUrl(next);
        fetchData(next);
        return next;
      });
    },
    [fetchData, updateUrl]
  );

  const updateFilter = useCallback((index: number, patch: Record<string, unknown>) => {
    setQuery((prev) => {
      const newRules = prev.filters.rules.map((r, i) => (i === index ? { ...r, ...patch } : r));
      return { ...prev, filters: { ...prev.filters, rules: newRules }, page: 1 };
    });
  }, []);

  const applyFilters = useCallback(() => {
    setQuery((prev) => {
      const next = { ...prev, page: 1 };
      updateUrl(next);
      fetchData(next);
      return next;
    });
  }, [fetchData, updateUrl]);

  const clearFilters = useCallback(() => {
    setQuery((prev) => {
      const next: EntityQueryState = {
        ...prev,
        filters: { logic: 'AND' as const, rules: [] },
        page: 1,
      };
      updateUrl(next);
      fetchData(next);
      return next;
    });
  }, [fetchData, updateUrl]);

  const goToPage = useCallback(
    (page: number) => {
      setQuery((prev) => {
        const next = { ...prev, page };
        updateUrl(next);
        fetchData(next);
        return next;
      });
    },
    [fetchData, updateUrl]
  );

  const handleWatch = useCallback(
    async (entityId: string) => {
      if (!canWatch) return;
      const formData = new FormData();
      formData.set('entityId', entityId);
      const result = await watchAction(
        { error: null, success: false, isWatched: false },
        formData
      );
      if (result.success) {
        setWatchedIds((prev) => new Set(prev).add(entityId));
        toast.success(`${entityLabel} seguido`);
      } else {
        toast.error(result.error ?? 'Error');
      }
    },
    [canWatch, watchAction, entityLabel]
  );

  const handleUnwatch = useCallback(
    async (entityId: string) => {
      if (!canWatch) return;
      const formData = new FormData();
      formData.set('entityId', entityId);
      const result = await unwatchAction(
        { error: null, success: false, isWatched: true },
        formData
      );
      if (result.success) {
        setWatchedIds((prev) => {
          const next = new Set(prev);
          next.delete(entityId);
          return next;
        });
        toast.success(`Dejaste de seguir el ${entityLabel.toLowerCase()}`);
      } else {
        toast.error(result.error ?? 'Error');
      }
    },
    [canWatch, unwatchAction, entityLabel]
  );

  const handleBulkWatch = useCallback(
    async (action: 'watch' | 'unwatch') => {
      if (!canWatch || selectedIds.size === 0) return;
      const formData = new FormData();
      formData.set('action', action);
      selectedIds.forEach((id) => formData.append('entityIds', id));
      const result = await bulkWatchAction(
        { error: null, success: false, isWatched: false },
        formData
      );
      if (result.success) {
        setWatchedIds((prev) => {
          const next = new Set(prev);
          if (action === 'watch') selectedIds.forEach((id) => next.add(id));
          else selectedIds.forEach((id) => next.delete(id));
          return next;
        });
        toast.success(
          action === 'watch'
            ? `${selectedIds.size} ${entityLabelPlural.toLowerCase()} seguidos`
            : `${selectedIds.size} ${entityLabelPlural.toLowerCase()} dejados de seguir`
        );
      } else {
        toast.error(result.error ?? 'Error');
      }
    },
    [canWatch, selectedIds, bulkWatchAction, entityLabelPlural]
  );

  const handleCopyNames = useCallback(() => {
    const names = data.data
      .filter((o) => selectedIds.has(o.id))
      .map((o) => (o as unknown as Record<string, unknown>)[nameField])
      .filter(Boolean) as string[];
    if (names.length === 0) return;
    navigator.clipboard.writeText(names.join('\n'));
    toast.success(`${names.length} nombres copiados`);
  }, [data.data, selectedIds, nameField]);

  const handleExport = useCallback(
    async (format: 'csv' | 'xlsx', scope: 'current_page' | 'selected' | 'filtered') => {
      if (!canExport) return;
      setExportMenuOpen(false);
      const formData = new FormData();
      formData.set('format', format);
      formData.set('scope', scope);
      formData.set('query', JSON.stringify(query));
      if (scope === 'selected') {
        selectedIds.forEach((id) => formData.append('selectedIds', id));
      }
      toast.loading('Generando exportación...', { id: 'export' });
      const result = await exportAction(
        { error: null, success: false, content: null, filename: null, format: null },
        formData
      );
      if (result.success && result.content && result.filename) {
        toast.success(`Exportación lista: ${result.filename}`, { id: 'export' });
        const link = document.createElement('a');
        link.href = `data:application/${format === 'csv' ? 'csv' : 'vnd.openxmlformats-officedocument.spreadsheetml.sheet'};base64,${result.content}`;
        link.download = result.filename;
        link.click();
      } else {
        toast.error(result.error ?? 'Error al exportar', { id: 'export' });
      }
    },
    [canExport, query, selectedIds, exportAction]
  );

  const handleSaveView = useCallback(async () => {
    if (!viewName.trim()) return;
    const config = {
      version: 1 as const,
      query: {
        search: query.search,
        filters: query.filters,
        sort: query.sort,
        page_size: query.page_size,
      },
      presentation: pref,
    };
    const formData = new FormData();
    formData.set('name', viewName.trim());
    formData.set('visibility', viewVisibility);
    formData.set('config', JSON.stringify(config));
    formData.set('isDefault', 'false');
    const result = await createViewAction({ error: null, success: false, viewId: null }, formData);
    if (result.success) {
      toast.success('Vista guardada');
      setSaveViewModalOpen(false);
      setViewName('');
      router.refresh();
    } else {
      toast.error(result.error ?? 'Error');
    }
  }, [viewName, viewVisibility, query, pref, router, createViewAction]);

  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFullscreen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/app/notifications/api/unread-count');
        if (res.ok) {
          const json = await res.json();
          setUnreadCount(json.count);
        }
      } catch {
        // silent
      }
    }, 90_000);
    return () => clearInterval(interval);
  }, []);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch(`${basePath}/sync/status`);
      if (res.ok) {
        const json = await res.json();
        setSyncStatus(json);
        return json as SyncStatus;
      }
    } catch {
      // silent
    }
    return null;
  }, [basePath]);

  useEffect(() => {
    const isActive = syncStatus?.active_run != null;
    if (!isActive) {
      if (syncPollRef.current) {
        clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }
      return;
    }

    if (!syncPollRef.current) {
      syncPollRef.current = setInterval(async () => {
        const status = await fetchSyncStatus();
        if (status && !status.active_run) {
          if (syncPollRef.current) {
            clearInterval(syncPollRef.current);
            syncPollRef.current = null;
          }
          const latest = status.latest_run;
          if (latest?.status === 'FAILED') {
            toast.error('La sincronización falló. Intenta de nuevo más tarde.');
          } else if (latest?.status === 'COMPLETED') {
            toast.success(
              `Sincronización completada: ${latest.details_fetched ?? 0} ${entityLabelPlural.toLowerCase()} actualizados`
            );
          }
          fetchData(query);
          router.refresh();
        }
      }, 5000);
    }

    return () => {
      if (syncPollRef.current) {
        clearInterval(syncPollRef.current);
        syncPollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStatus?.active_run]);

  const handleSyncNow = useCallback(async () => {
    if (syncTriggering) return;
    setSyncTriggering(true);
    try {
      const res = await fetch(`${basePath}/sync`, { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        if (json?.already_running) {
          toast.info('Ya hay una sincronización en curso');
        } else if (json?.result) {
          toast.success(
            `Sincronización completada: ${json.result.details_fetched ?? 0} ${entityLabelPlural.toLowerCase()} actualizados`
          );
          fetchData(query);
          router.refresh();
        } else {
          toast.success('Sincronización iniciada');
        }
      } else if (res.status === 202) {
        toast.info('La sincronización está en curso...');
      } else if (res.status === 409) {
        toast.info('Ya hay una sincronización en curso');
      } else {
        toast.error('No pudimos iniciar la sincronización');
      }
      await fetchSyncStatus();
    } catch {
      toast.error('No pudimos iniciar la sincronización');
    } finally {
      setSyncTriggering(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTriggering, fetchSyncStatus, fetchData, query, router, basePath, entityLabelPlural]);

  const lastSyncLabel = useMemo(() => {
    const latest = syncStatus?.latest_run;
    if (!latest || !latest.completed_at) return null;
    const date = new Date(latest.completed_at);
    if (latest.status === 'FAILED') return null;
    return date.toLocaleString('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [syncStatus?.latest_run]);

  const isSyncing = syncStatus?.active_run != null || syncTriggering;

  const densityClass = `so-density-${pref.density}`;
  const pinnedLeft = pref.columnPinning.left;
  const pinnedRight = pref.columnPinning.right;
  const allSelected = data.data.length > 0 && data.data.every((o) => selectedIds.has(o.id));
  const hasFilters = query.filters.rules.length > 0;
  const activeFilterCount = query.filters.rules.length;

  const defaultSearchPlaceholder = searchPlaceholder ?? `Buscar ${entityLabelPlural.toLowerCase()}...`;

  return (
    <div className={`so-workspace ${fullscreen ? 'so-workspace-fullscreen' : ''} ${densityClass}`}>
      {/* Toolbar */}
      <div className="so-toolbar">
        <div className="so-toolbar-top">
          {/* View selector */}
          <div className="so-view-selector" style={{ position: 'relative' }}>
            <button
              className="so-view-selector-trigger"
              onClick={() => setViewSelectorOpen(!viewSelectorOpen)}
              aria-haspopup="true"
              aria-expanded={viewSelectorOpen}
            >
              <span>Todos los {entityLabelPlural.toLowerCase()}</span>
              <ChevronDown size={16} />
            </button>
            {viewSelectorOpen ? (
              <div className="so-view-dropdown">
                <div className="so-view-dropdown-section">Sistema</div>
                <div
                  className="so-view-dropdown-item active"
                  onClick={() => setViewSelectorOpen(false)}
                >
                  Todos los {entityLabelPlural.toLowerCase()}
                </div>
                {views.privateViews.length > 0 ? (
                  <>
                    <div className="so-view-dropdown-section">Mis vistas</div>
                    {views.privateViews.map((v) => (
                      <div
                        key={v.id}
                        className="so-view-dropdown-item"
                        onClick={() => {
                          router.push(`${basePath}?view=${v.id}`);
                          setViewSelectorOpen(false);
                        }}
                      >
                        {v.name}
                        {v.isDefault ? <Check size={14} /> : null}
                      </div>
                    ))}
                  </>
                ) : null}
                {views.sharedViews.length > 0 ? (
                  <>
                    <div className="so-view-dropdown-section">Compartidas</div>
                    {views.sharedViews.map((v) => (
                      <div
                        key={v.id}
                        className="so-view-dropdown-item"
                        onClick={() => {
                          router.push(`${basePath}?view=${v.id}`);
                          setViewSelectorOpen(false);
                        }}
                      >
                        {v.name}
                      </div>
                    ))}
                  </>
                ) : null}
                <div style={{ borderTop: '1px solid var(--unik-border)', margin: '4px 0' }} />
                <div
                  className="so-view-dropdown-item"
                  onClick={() => {
                    setSaveViewModalOpen(true);
                    setViewSelectorOpen(false);
                  }}
                >
                  <Plus size={14} /> Guardar vista actual
                </div>
              </div>
            ) : null}
          </div>

          {/* Search */}
          <div className="so-toolbar-search">
            <div className="input-with-icon">
              <span className="input-icon">
                <Search size={16} />
              </span>
              <input
                className="input"
                type="search"
                placeholder={defaultSearchPlaceholder}
                value={query.search ?? ''}
                onChange={(e) => handleSearchChange(e.target.value)}
                aria-label={`Buscar ${entityLabelPlural.toLowerCase()}`}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="so-toolbar-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setFilterPanelOpen(!filterPanelOpen)}
              aria-pressed={filterPanelOpen}
            >
              <SlidersHorizontal size={14} />
              Filtros{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </button>
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setColumnManagerOpen(!columnManagerOpen)}
                aria-pressed={columnManagerOpen}
              >
                <Columns3 size={14} />
                Columnas
              </button>
              {columnManagerOpen ? (
                <div className="so-view-dropdown" style={{ right: 0, left: 'auto', minWidth: 260 }}>
                  <div className="so-column-manager">
                    {columns.sort((a, b) => a.priority - b.priority).map((col) => (
                      <label key={col.id} className="so-column-manager-item">
                        <input
                          type="checkbox"
                          checked={pref.columnVisibility[col.id] !== false}
                          onChange={() => handleToggleColumn(col.id)}
                        />
                        <span>{col.label}</span>
                      </label>
                    ))}
                  </div>
                  <div style={{ borderTop: '1px solid var(--unik-border)', margin: '4px 0' }} />
                  <button className="so-view-dropdown-item" onClick={handleResetColumns}>
                    <Trash2 size={14} /> Restablecer columnas
                  </button>
                </div>
              ) : null}
            </div>
            <select
              className="so-page-size-select"
              value={pref.density}
              onChange={(e) => handleDensityChange(e.target.value as Density)}
              aria-label="Densidad"
              style={{ width: 'auto' }}
            >
              <option value="compact">Compacta</option>
              <option value="normal">Normal</option>
              <option value="comfortable">Cómoda</option>
            </select>
            {canExport ? (
              <div style={{ position: 'relative' }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setExportMenuOpen(!exportMenuOpen)}
                >
                  <Download size={14} />
                  Exportar
                </button>
                {exportMenuOpen ? (
                  <div
                    className="so-view-dropdown"
                    style={{ right: 0, left: 'auto', minWidth: 220 }}
                  >
                    <div className="so-view-dropdown-section">CSV</div>
                    <button
                      className="so-view-dropdown-item"
                      onClick={() => handleExport('csv', 'current_page')}
                    >
                      Página actual
                    </button>
                    {selectedIds.size > 0 ? (
                      <button
                        className="so-view-dropdown-item"
                        onClick={() => handleExport('csv', 'selected')}
                      >
                        Filas seleccionadas ({selectedIds.size})
                      </button>
                    ) : null}
                    <button
                      className="so-view-dropdown-item"
                      onClick={() => handleExport('csv', 'filtered')}
                    >
                      Todos los resultados filtrados
                    </button>
                    <div className="so-view-dropdown-section">Excel</div>
                    <button
                      className="so-view-dropdown-item"
                      onClick={() => handleExport('xlsx', 'current_page')}
                    >
                      Página actual
                    </button>
                    {selectedIds.size > 0 ? (
                      <button
                        className="so-view-dropdown-item"
                        onClick={() => handleExport('xlsx', 'selected')}
                      >
                        Filas seleccionadas ({selectedIds.size})
                      </button>
                    ) : null}
                    <button
                      className="so-view-dropdown-item"
                      onClick={() => handleExport('xlsx', 'filtered')}
                    >
                      Todos los resultados filtrados
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleSyncNow}
              disabled={isSyncing || syncTriggering}
              aria-label={isSyncing ? 'Sincronizando...' : 'Actualizar ahora'}
              title={lastSyncLabel ? `Última sync: ${lastSyncLabel}` : 'Actualizar ahora'}
            >
              <RefreshCw size={14} className={isSyncing ? 'spin' : ''} />
              {isSyncing ? 'Actualizando...' : 'Actualizar'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setFullscreen(!fullscreen)}
              aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>

        {/* Filter chips */}
        {hasFilters ? (
          <div className="so-filter-chips">
            {query.filters.rules.map((rule, i) => {
              const col = columns.find((c) => c.field === rule.field);
              if (!col) return null;
              const displayValue = (() => {
                if (!('value' in rule) || rule.value === undefined || rule.value === null) return '';
                if (col.type === 'boolean') return rule.value === true ? 'Sí' : 'No';
                if (col.type === 'status' && getStatusLabel) {
                  return getStatusLabel(String(rule.value));
                }
                return String(rule.value);
              })();
              const valTo = 'valueTo' in rule ? String(rule.valueTo ?? '') : '';
              const fullValue =
                rule.operator === 'between' && valTo ? `${displayValue} y ${valTo}` : displayValue;
              const operatorLabel = FILTER_OPERATOR_LABELS[rule.operator] ?? rule.operator;
              return (
                <span key={i} className="so-filter-chip">
                  <strong>{col.label}:</strong> {operatorLabel} {fullValue}
                  <button onClick={() => removeFilter(i)} aria-label="Quitar filtro">
                    <X size={12} />
                  </button>
                </span>
              );
            })}
            <button className="btn btn-ghost btn-sm" onClick={clearFilters}>
              Limpiar todo
            </button>
          </div>
        ) : null}

        {/* Filter builder panel */}
        {filterPanelOpen ? (
          <div className="so-filter-builder">
            {query.filters.rules.map((rule, i) => {
              const col = columns.find((c) => c.field === rule.field);
              const operators = col ? (FILTER_OPERATORS_BY_TYPE[col.type] ?? []) : [];
              return (
                <div key={i} className="so-filter-row">
                  <select
                    value={rule.field}
                    onChange={(e) => {
                      const newCol = columns.find((c) => c.field === e.target.value);
                      updateFilter(i, {
                        field: e.target.value,
                        operator: newCol
                          ? (FILTER_OPERATORS_BY_TYPE[newCol.type]?.[0] ?? 'contains')
                          : 'contains',
                        value: '',
                      });
                    }}
                  >
                    {columns.filter((c) => c.filterable).map((c) => (
                      <option key={c.id} value={c.field}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={rule.operator}
                    onChange={(e) => updateFilter(i, { operator: e.target.value })}
                  >
                    {operators.map((op) => (
                      <option key={op} value={op}>
                        {FILTER_OPERATOR_LABELS[op] ?? op.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                  {rule.operator !== 'is_empty' && rule.operator !== 'is_not_empty' ? (
                    <div className="so-filter-values" style={{ display: 'flex', gap: '0.5rem' }}>
                      {col?.type === 'status' && getStatusOptions ? (
                        <select
                          value={String(rule.value ?? '')}
                          onChange={(e) => updateFilter(i, { value: e.target.value })}
                        >
                          <option value="">Seleccionar...</option>
                          {getStatusOptions().map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : col?.type === 'boolean' ? (
                        <select
                          value={
                            rule.value === true ? 'true' : rule.value === false ? 'false' : ''
                          }
                          onChange={(e) => {
                            const boolValue =
                              e.target.value === 'true'
                                ? true
                                : e.target.value === 'false'
                                  ? false
                                  : undefined;
                            updateFilter(i, { value: boolValue });
                          }}
                        >
                          <option value="">Seleccionar...</option>
                          <option value="true">Sí</option>
                          <option value="false">No</option>
                        </select>
                      ) : (
                        <input
                          type={
                            col?.type === 'number' || col?.type === 'currency'
                              ? 'number'
                              : col?.type === 'date'
                                ? 'date'
                                : 'text'
                          }
                          value={'value' in rule ? String(rule.value ?? '') : ''}
                          onChange={(e) => updateFilter(i, { value: e.target.value })}
                          placeholder={rule.operator === 'between' ? 'Desde...' : 'Valor...'}
                        />
                      )}
                      {rule.operator === 'between' &&
                      (col?.type === 'number' || col?.type === 'currency' || col?.type === 'date') ? (
                        <input
                          type={
                            col?.type === 'number' || col?.type === 'currency'
                              ? 'number'
                              : 'date'
                          }
                          value={'valueTo' in rule ? String(rule.valueTo ?? '') : ''}
                          onChange={(e) => updateFilter(i, { valueTo: e.target.value })}
                          placeholder="Hasta..."
                        />
                      ) : null}
                    </div>
                  ) : null}
                  {col?.type === 'date' && 'shortcut' in rule ? (
                    <select
                      value={rule.shortcut ?? ''}
                      onChange={(e) => updateFilter(i, { shortcut: e.target.value || undefined })}
                    >
                      <option value="">Sin atajo</option>
                      {DATE_SHORTCUTS.map((s) => (
                        <option key={s} value={s}>
                          {DATE_SHORTCUT_LABELS[s] ?? s.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button
                    className="so-filter-remove"
                    onClick={() => removeFilter(i)}
                    aria-label="Quitar filtro"
                  >
                    <X size={16} />
                  </button>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => addFilter()}>
                <Plus size={14} /> Agregar filtro
              </button>
              <button className="btn btn-primary btn-sm" onClick={applyFilters}>
                <Check size={14} /> Aplicar
              </button>
            </div>
          </div>
        ) : null}

        {/* Summary */}
        <div className="so-toolbar-bottom">
          <div className="so-summary">
            <div className="so-summary-item">
              <span className="so-summary-value">
                {data.pagination.total.toLocaleString('es-MX')}
              </span>
              <span>{entityLabelPlural.toLowerCase()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Selection bar */}
      {selectedIds.size > 0 ? (
        <div className="so-selection-bar">
          <span className="so-selection-count">{selectedIds.size} seleccionados</span>
          <div className="so-selection-actions">
            {canWatch ? (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleBulkWatch('watch')}
                >
                  <Bell size={14} /> Seguir
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleBulkWatch('unwatch')}
                >
                  <BellRing size={14} /> Dejar de seguir
                </button>
              </>
            ) : null}
            <button className="btn btn-secondary btn-sm" onClick={handleCopyNames}>
              <Copy size={14} /> Copiar nombres
            </button>
            <button className="btn btn-ghost btn-sm" onClick={clearSelection}>
              Limpiar selección
            </button>
          </div>
        </div>
      ) : null}

      {/* Table */}
      <div className="so-table-container">
        {error ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <p className="text-muted" style={{ marginBottom: '1rem' }}>
              {error}
            </p>
            <button className="btn btn-secondary btn-sm" onClick={() => fetchData(query)}>
              Reintentar
            </button>
          </div>
        ) : data.data.length === 0 && !loading ? (
          <div style={{ padding: '3rem', textAlign: 'center' }}>
            <p className="text-muted" style={{ marginBottom: '1rem' }}>
              {hasFilters
                ? `No encontramos ${entityLabelPlural.toLowerCase()} con estos filtros.`
                : `No hay ${entityLabelPlural.toLowerCase()}.`}
            </p>
            {hasFilters ? (
              <button className="btn btn-secondary btn-sm" onClick={clearFilters}>
                Limpiar filtros
              </button>
            ) : null}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <table className="so-table">
              <thead>
                <tr>
                  <th
                    style={{ width: 40, position: 'sticky', left: 0, zIndex: 12 }}
                    className="so-th-pinned-left"
                  >
                    <div className="so-th-content">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={togglePageSelection}
                        aria-label="Seleccionar página"
                        style={{ width: '1rem', height: '1rem', accentColor: 'var(--unik-brand)' }}
                      />
                    </div>
                  </th>
                  <SortableContext
                    items={visibleColumns.map((c) => c.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    {visibleColumns.map((col) => {
                      const isPinnedLeft = pinnedLeft.includes(col.id);
                      const isPinnedRight = pinnedRight.includes(col.id);
                      const sortDir =
                        query.sort.find((s) => s.field === col.field)?.direction ?? null;
                      const offset = columnOffsets[col.id];
                      return (
                        <SortableHeader
                          key={col.id}
                          columnId={col.id}
                          column={col}
                          width={pref.columnWidths[col.id] ?? col.defaultWidth}
                          isPinnedLeft={isPinnedLeft}
                          isPinnedRight={isPinnedRight}
                          leftOffset={offset?.left}
                          rightOffset={offset?.right}
                          sortDirection={sortDir}
                          onSort={handleSort}
                          onResize={handleResize}
                          onTogglePin={handleTogglePin}
                          onHide={handleHideColumn}
                          onMoveLeft={(id) => handleMoveColumn(id, 'left')}
                          onMoveRight={(id) => handleMoveColumn(id, 'right')}
                          onAddFilter={addFilter}
                        />
                      );
                    })}
                  </SortableContext>
                  <th
                    style={{ width: 50, position: 'sticky', right: 0, zIndex: 12 }}
                    className="so-th-pinned-right"
                  >
                    <div className="so-th-content" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td
                      colSpan={visibleColumns.length + 2}
                      style={{ padding: '2rem', textAlign: 'center' }}
                    >
                      <span className="spinner" /> Cargando...
                    </td>
                  </tr>
                ) : (
                  data.data.map((item) => {
                    const isSelected = selectedIds.has(item.id);
                    const isWatched = watchedIds.has(item.id);
                    const itemLabel = String(
                      (item as unknown as Record<string, unknown>)[nameField] ?? item.id
                    );
                    return (
                      <tr
                        key={item.id}
                        className={isSelected ? 'so-row-selected' : ''}
                        onClick={() => setPreviewId(item.id)}
                      >
                        <td
                          className="so-td-pinned-left"
                          style={{ width: 40 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRowSelection(item.id)}
                            aria-label={`Seleccionar ${itemLabel}`}
                            style={{
                              width: '1rem',
                              height: '1rem',
                              accentColor: 'var(--unik-brand)',
                            }}
                          />
                        </td>
                        {visibleColumns.map((col) => {
                          const isPinnedLeft = pinnedLeft.includes(col.id);
                          const isPinnedRight = pinnedRight.includes(col.id);
                          const offset = columnOffsets[col.id];
                          return (
                            <td
                              key={col.id}
                              className={`${isPinnedLeft ? 'so-td-pinned-left' : ''} ${isPinnedRight ? 'so-td-pinned-right' : ''}`}
                              style={{
                                width: pref.columnWidths[col.id] ?? col.defaultWidth,
                                textAlign: col.align,
                                ...(offset?.left !== undefined ? { left: offset.left } : {}),
                                ...(offset?.right !== undefined ? { right: offset.right } : {}),
                              }}
                            >
                              {col.id === nameField && isWatched ? (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                  }}
                                >
                                  <BellRing size={12} className="so-watch-indicator" />
                                  {renderCell(item, col)}
                                </span>
                              ) : (
                                renderCell(item, col)
                              )}
                            </td>
                          );
                        })}
                        <td
                          className="so-td-pinned-right"
                          style={{ width: 50 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {canWatch ? (
                            <button
                              className="so-filter-remove"
                              style={{ width: 28, height: 28 }}
                              onClick={() =>
                                isWatched ? handleUnwatch(item.id) : handleWatch(item.id)
                              }
                              aria-label={isWatched ? 'Dejar de seguir' : `Seguir ${entityLabel.toLowerCase()}`}
                            >
                              {isWatched ? (
                                <BellRing size={14} className="so-watch-indicator" />
                              ) : (
                                <Bell size={14} />
                              )}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </DndContext>
        )}
      </div>

      {/* Pagination */}
      <div className="so-pagination">
        <div className="so-pagination-info">
          {data.data.length > 0
            ? `${(data.pagination.page - 1) * data.pagination.page_size + 1}–${Math.min(data.pagination.page * data.pagination.page_size, data.pagination.total)} de ${data.pagination.total.toLocaleString('es-MX')}`
            : 'Sin resultados'}
        </div>
        <div className="so-pagination-controls">
          <select
            className="so-page-size-select"
            value={pref.pageSize}
            onChange={(e) => handlePageSizeChange(Number(e.target.value))}
            aria-label="Tamaño de página"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => goToPage(data.pagination.page - 1)}
            disabled={data.pagination.page <= 1}
            aria-label="Página anterior"
          >
            <ChevronLeft size={14} />
          </button>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {data.pagination.page} / {data.pagination.total_pages || 1}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => goToPage(data.pagination.page + 1)}
            disabled={data.pagination.page >= data.pagination.total_pages}
            aria-label="Página siguiente"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Preview drawer */}
      {previewId && renderPreviewDrawer ? (
        <>
          {renderPreviewDrawer({
            entityId: previewId,
            basePath,
            entityLabel,
            onClose: () => setPreviewId(null),
            canWatch,
            isWatched: watchedIds.has(previewId),
            onWatchChange: (watched) => {
              setWatchedIds((prev) => {
                const next = new Set(prev);
                if (watched) next.add(previewId);
                else next.delete(previewId);
                return next;
              });
            },
            watchAction,
            unwatchAction,
          })}
        </>
      ) : null}

      {/* Save view modal */}
      {saveViewModalOpen ? (
        <>
          <div className="overlay" onClick={() => setSaveViewModalOpen(false)} aria-hidden="true" />
          <div
            className="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-view-title"
          >
            <div className="modal-header">
              <h3 id="save-view-title" className="modal-title">
                Guardar vista
              </h3>
              <button
                className="icon-btn"
                onClick={() => setSaveViewModalOpen(false)}
                aria-label="Cerrar"
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label htmlFor="view-name" className="form-label">
                  Nombre
                </label>
                <input
                  id="view-name"
                  className="input"
                  type="text"
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  placeholder="Ej: Mis registros activos"
                  maxLength={100}
                />
              </div>
              {canShareViews ? (
                <div className="form-field">
                  <label htmlFor="view-visibility" className="form-label">
                    Visibilidad
                  </label>
                  <select
                    id="view-visibility"
                    className="input"
                    value={viewVisibility}
                    onChange={(e) => setViewVisibility(e.target.value as 'private' | 'shared')}
                  >
                    <option value="private">Privada</option>
                    <option value="shared">Compartida</option>
                  </select>
                </div>
              ) : null}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setSaveViewModalOpen(false)}
              >
                Cancelar
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSaveView}
                disabled={!viewName.trim()}
              >
                Guardar
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

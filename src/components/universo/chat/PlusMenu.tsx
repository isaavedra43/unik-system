'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  GraduationCap,
  Paperclip,
  Plug,
  Plus,
  Search,
  Wrench,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/shadcn/tooltip';
import { cn } from '@/lib/utils';
import { AppsList } from '../shell/AppsList';
import { CapabilityMenu, type PickedCapability } from './CapabilityMenu';

/**
 * The composer's "+" — attach files and pick WHAT the agent should use for
 * the next message: internet, browser, computer, documents, team, routines,
 * MCP servers, APIs, plugins, skills and connected apps (with their real
 * state). Also: teach a task once, connect apps and browse every tool.
 */

interface ToolInfo {
  name: string;
  description: string;
}
interface ToolCategory {
  id: string;
  label: string;
  tools: ToolInfo[];
}

function ToolsCatalog({ onPick }: { onPick: (text: string) => void }) {
  const [cats, setCats] = useState<ToolCategory[] | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/app/assistant/api/tools')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { categories?: ToolCategory[] } | null) => alive && setCats(d?.categories ?? []))
      .catch(() => alive && setCats([]));
    return () => {
      alive = false;
    };
  }, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!cats) return [];
    return cats
      .map((c) => ({
        ...c,
        tools: c.tools.filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q)),
      }))
      .filter((c) => c.tools.length > 0);
  }, [cats, query]);
  const total = cats?.reduce((n, c) => n + c.tools.length, 0) ?? 0;
  return (
    <>
      <label className="uv-pop-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Buscar entre ${total || ''} herramientas`}
          aria-label="Buscar herramienta"
          autoFocus
        />
      </label>
      <div className="uv-pop-list">
        {cats === null && <div className="uv-skel" style={{ height: 40, margin: 6 }} />}
        {cats !== null && filtered.length === 0 && (
          <div className="uv-empty" style={{ padding: 16 }}>
            Sin herramientas que coincidan.
          </div>
        )}
        {filtered.map((c) => (
          <div key={c.id}>
            <div className="uv-pop-title">{c.label}</div>
            {c.tools.map((t) => (
              <button
                key={t.name}
                type="button"
                className="uv-pop-item"
                onClick={() => onPick(`Usa la herramienta ${t.name} para `)}
                title={t.description}
              >
                <span className="uv-pop-item-text">
                  <span className="uv-pop-item-name">{t.name}</span>
                  <span className="uv-pop-item-sub">
                    {t.description.split('. ')[0].slice(0, 140)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

export function PlusMenu({
  canUpload,
  disabled,
  onAttach,
  onPrefill,
  onTeach,
  picked,
  onToggleCapability,
}: {
  canUpload: boolean;
  disabled?: boolean;
  onAttach: () => void;
  onPrefill: (text: string) => void;
  onTeach?: () => void;
  picked: PickedCapability[];
  onToggleCapability: (item: PickedCapability) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'apps' | 'tools'>('main');

  useEffect(() => {
    if (!open) setView('main');
  }, [open]);

  const pick = (text: string) => {
    onPrefill(text);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn('uv-icon-btn uv-plus', picked.length > 0 && 'has-picks')}
              disabled={disabled}
              aria-label="Adjuntar y elegir capacidades"
            >
              <Plus size={18} />
              {picked.length > 0 && <span className="uv-plus-count">{picked.length}</span>}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Adjuntar y elegir qué usa el agente</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="uv-pop uv-scope uv-plus-pop"
        style={{ width: 360 }}
      >
        {view === 'main' && (
          <>
            {canUpload && (
              <button
                type="button"
                className="uv-pop-item"
                onClick={() => {
                  setOpen(false);
                  onAttach();
                }}
              >
                <span className="uv-pop-item-icon">
                  <Paperclip size={15} />
                </span>
                <span className="uv-pop-item-text">
                  <span className="uv-pop-item-name">Adjuntar archivos</span>
                  <span className="uv-pop-item-sub">Imagen, PDF, Excel, Word, audio o video</span>
                </span>
              </button>
            )}
            <div className="uv-pop-title uv-capmenu-head">
              <span>Usar en este mensaje</span>
              {picked.length > 0 && (
                <button type="button" className="uv-link-btn" onClick={() => setOpen(false)}>
                  Listo ({picked.length})
                </button>
              )}
            </div>
            <CapabilityMenu
              picked={picked}
              onToggle={onToggleCapability}
              onConnectApp={() => setView('apps')}
            />
            <div className="uv-pop-sep" />
            {onTeach && (
              <button
                type="button"
                className="uv-pop-item"
                onClick={() => {
                  setOpen(false);
                  onTeach();
                }}
              >
                <span className="uv-pop-item-icon">
                  <GraduationCap size={15} />
                </span>
                <span className="uv-pop-item-text">
                  <span className="uv-pop-item-name">Enséñale una tarea</span>
                  <span className="uv-pop-item-sub">
                    Hazla una vez en el navegador y la repite sola
                  </span>
                </span>
              </button>
            )}
            <button type="button" className="uv-pop-item" onClick={() => setView('apps')}>
              <span className="uv-pop-item-icon">
                <Plug size={15} />
              </span>
              <span className="uv-pop-item-text">
                <span className="uv-pop-item-name">Conectar apps</span>
                <span className="uv-pop-item-sub">Gmail, Calendar, Drive, Slack, CRM…</span>
              </span>
              <ChevronRight size={14} style={{ alignSelf: 'center' }} />
            </button>
            <button type="button" className="uv-pop-item" onClick={() => setView('tools')}>
              <span className="uv-pop-item-icon">
                <Wrench size={15} />
              </span>
              <span className="uv-pop-item-text">
                <span className="uv-pop-item-name">Todas las herramientas</span>
                <span className="uv-pop-item-sub">
                  Cada acción individual que el agente puede hacer
                </span>
              </span>
              <ChevronRight size={14} style={{ alignSelf: 'center' }} />
            </button>
          </>
        )}
        {view !== 'main' && (
          <>
            <button type="button" className="uv-pop-back" onClick={() => setView('main')}>
              <ArrowLeft size={14} /> {view === 'apps' ? 'Apps conectadas' : 'Herramientas'}
            </button>
            {view === 'apps' ? (
              <div className="uv-pop-list">
                <AppsList compact onConnected={(t) => pick(`Ya conecté ${t.name}. Úsala para `)} />
              </div>
            ) : (
              <ToolsCatalog onPick={pick} />
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Globe,
  GraduationCap,
  Image as ImageIcon,
  MousePointer2,
  Paperclip,
  Plug,
  Plus,
  Rocket,
  Search,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/shadcn/tooltip';
import { AppsList } from '../shell/AppsList';

/**
 * The composer's "+" — attach files, tell the agent HOW to work (research,
 * browser, computer/code, image, website, team), teach it a task once,
 * connect apps and browse every tool it has.
 */

export interface Capability {
  id: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  prefix: string;
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'research',
    icon: <Globe size={15} />,
    title: 'Investigar a fondo',
    sub: 'Busca, lee y cruza varias fuentes con citas',
    prefix: 'Investiga a fondo en internet, cruza varias fuentes y cítalas: ',
  },
  {
    id: 'browser',
    icon: <MousePointer2 size={15} />,
    title: 'Usar el navegador',
    sub: 'Entra a sitios, llena formularios, prueba en producción',
    prefix: 'Abre el navegador y ',
  },
  {
    id: 'computer',
    icon: <Terminal size={15} />,
    title: 'Programar en la computadora',
    sub: 'Escribe, corre y prueba código en su propia máquina',
    prefix: 'En la computadora virtual, ',
  },
  {
    id: 'image',
    icon: <ImageIcon size={15} />,
    title: 'Crear una imagen',
    sub: 'Imágenes para marketing, productos o redes',
    prefix: 'Genera una imagen de ',
  },
  {
    id: 'site',
    icon: <Rocket size={15} />,
    title: 'Crear y publicar un sitio web',
    sub: 'Lo construye, lo revisa y te da el enlace público',
    prefix: 'Crea y publica un sitio web para ',
  },
  {
    id: 'team',
    icon: <Users size={15} />,
    title: 'Trabajo en equipo',
    sub: 'Reparte entre especialistas, revisa y consolida',
    prefix:
      'Reparte esto entre mi equipo en paralelo, revisa cada entrega y consolida el resultado: ',
  },
];

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
}: {
  canUpload: boolean;
  disabled?: boolean;
  onAttach: () => void;
  onPrefill: (text: string) => void;
  onTeach?: () => void;
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
              className="uv-icon-btn uv-plus"
              disabled={disabled}
              aria-label="Adjuntar y herramientas"
            >
              <Plus size={18} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Adjuntar, capacidades y apps</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="uv-pop uv-scope"
        style={{ width: 330 }}
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
            <div className="uv-pop-title">Pídele que…</div>
            {CAPABILITIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className="uv-pop-item"
                onClick={() => pick(c.prefix)}
              >
                <span className="uv-pop-item-icon">{c.icon}</span>
                <span className="uv-pop-item-text">
                  <span className="uv-pop-item-name">{c.title}</span>
                  <span className="uv-pop-item-sub">{c.sub}</span>
                </span>
              </button>
            ))}
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
            <div className="uv-pop-sep" />
            <button type="button" className="uv-pop-item" onClick={() => setView('apps')}>
              <span className="uv-pop-item-icon">
                <Plug size={15} />
              </span>
              <span className="uv-pop-item-text">
                <span className="uv-pop-item-name">Apps conectadas</span>
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
                <span className="uv-pop-item-sub">Lo que el agente puede consultar y hacer</span>
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

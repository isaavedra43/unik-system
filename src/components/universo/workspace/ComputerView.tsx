'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppWindow,
  ChevronRight,
  Download,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  Globe,
  Hand,
  HardDrive,
  Loader2,
  Monitor,
  Power,
  RefreshCw,
  SquareTerminal,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatBytes, timeAgo } from '../lib/format';
import { IconButton } from '../ui';
import { LiveScreen } from './LiveScreen';
import type { VenueApi } from './useVenue';

/**
 * The virtual computer itself (different from the agent's browser): a Linux
 * desktop you can watch and drive, a terminal on the same machine the agents
 * code in, and its files — download what they produced, upload what they need.
 */

export interface ExecEntry {
  id: string;
  command: string;
  output?: string;
  exitCode?: number | null;
  by: 'agent' | 'user';
  ts: number;
  running?: boolean;
}

export interface PreviewEntry {
  url: string;
  port?: number | null;
  label?: string | null;
  ts: number;
}

type Sub = 'desktop' | 'terminal' | 'files';

const HOME = '/home/daytona';

/** DOM key → xdotool key name (desktop). */
const XDO_KEYS: Record<string, string> = {
  Enter: 'Return',
  Backspace: 'BackSpace',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next',
};

async function post<T>(url: string, body: unknown): Promise<{ ok: boolean; data: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as T };
}

function DesktopPane({ venue, sub }: { venue: VenueApi; sub: Sub }) {
  const { state, starting } = venue;
  const d = state?.desktop;
  const [control, setControl] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ready = Boolean(state?.active && !state.paused);

  const act = async (body: Record<string, unknown>) => {
    const r = await post<{
      ok?: boolean;
      error?: string | null;
      frame?: string | null;
      width?: number | null;
      height?: number | null;
      running?: boolean;
      reason?: string | null;
    }>('/app/assistant/api/venue/desktop', body);
    if (!r.ok || r.data.ok === false) {
      venue.setError(r.data.error ?? r.data.reason ?? 'El escritorio no respondió');
      return r.data;
    }
    venue.setError(null);
    if (r.data.frame)
      venue.applyDesktop({
        frame: r.data.frame,
        width: r.data.width ?? d?.width,
        height: r.data.height ?? d?.height,
        running: true,
      });
    return r.data;
  };

  const powerOn = async () => {
    setBusy('start');
    try {
      if (!state?.active) await venue.start('desktop');
      const res = await act({ action: 'start' });
      if (res?.running) {
        toast.success('Escritorio encendido');
        await venue.refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const openViewer = async () => {
    setBusy('viewer');
    const win = window.open('about:blank', '_blank');
    try {
      const res = await fetch('/app/assistant/api/venue/viewer');
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? 'No se pudo abrir el escritorio');
      if (win) {
        // The remote desktop must not be able to reach back into this tab.
        win.opener = null;
        win.location.href = data.url;
      } else window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      win?.close();
      toast.error(err instanceof Error ? err.message : 'No se pudo abrir el escritorio');
    } finally {
      setBusy(null);
    }
  };

  if (sub !== 'desktop') return null;

  let overlay: React.ReactNode = null;
  if (!state) {
    overlay = (
      <div className="uv-screen-state">
        <Loader2 size={22} className="uv-spin" />
      </div>
    );
  } else if (!state.active || !d?.running) {
    overlay = (
      <div className="uv-screen-state">
        <Monitor size={28} />
        <strong>
          {state.active ? 'El escritorio está apagado' : 'La computadora virtual está apagada'}
        </strong>
        <p>
          {state.paused
            ? 'Está en pausa por inactividad. Al encender el escritorio se reanuda.'
            : 'Es una computadora Linux completa: los agentes programan, prueban y usan apps aquí. Enciende el escritorio para verla y manejarla tú.'}
        </p>
        {d?.reason && state.active && <p>{d.reason}</p>}
        <button
          type="button"
          className="uv-btn is-primary"
          onClick={() => void powerOn()}
          disabled={busy !== null || starting}
        >
          {busy === 'start' || starting ? (
            <Loader2 size={14} className="uv-spin" />
          ) : (
            <Power size={14} />
          )}{' '}
          Encender el escritorio
        </button>
      </div>
    );
  } else if (!d.frame) {
    overlay = (
      <div className="uv-screen-state">
        <Loader2 size={22} className="uv-spin" />
        <p>Cargando la pantalla…</p>
      </div>
    );
  }

  return (
    <div className="uv-browser">
      <div className="uv-browser-bar">
        <span className="uv-bar-title">
          <Monitor size={14} /> Escritorio
        </span>
        <span className="uv-grow" />
        {ready && d?.running && (
          <>
            {(
              [
                ['terminal', 'Terminal', <SquareTerminal key="t" size={15} />],
                ['files', 'Archivos', <FolderOpen key="f" size={15} />],
                ['browser', 'Navegador', <Globe key="b" size={15} />],
                ['editor', 'Editor', <AppWindow key="e" size={15} />],
              ] as const
            ).map(([app, label, icon]) => (
              <IconButton
                key={app}
                label={`Abrir ${label.toLowerCase()} en el escritorio`}
                size="sm"
                onClick={() => void act({ action: 'openApp', app })}
              >
                {icon}
              </IconButton>
            ))}
            <IconButton
              label="Pantalla completa (tiempo real)"
              size="sm"
              onClick={() => void openViewer()}
              disabled={busy === 'viewer'}
            >
              {busy === 'viewer' ? (
                <Loader2 size={15} className="uv-spin" />
              ) : (
                <ExternalLink size={15} />
              )}
            </IconButton>
          </>
        )}
      </div>
      <LiveScreen
        frame={ready && d?.running ? d.frame : null}
        alt="Escritorio de la computadora virtual"
        width={d?.width}
        height={d?.height}
        desktop
        control={control && Boolean(d?.running)}
        input={{
          onClick: (x, y, o) =>
            act({
              action:
                o.button === 'right' ? 'rightClick' : o.clickCount > 1 ? 'doubleClick' : 'click',
              x,
              y,
            }),
          onType: (text) => act({ action: 'type', text }),
          onKey: (key) => act({ action: 'key', key: XDO_KEYS[key] ?? key }),
          onWheel: (_dx, dy) =>
            act({
              action: 'scroll',
              direction: dy > 0 ? 'down' : 'up',
              amount: Math.min(10, Math.max(1, Math.round(Math.abs(dy) / 80))),
            }),
        }}
        top={
          ready && d?.running ? (
            <span className="uv-screen-badge">
              <span className={cn('uv-live-dot', control && 'is-warn')} />
              {control ? 'Tú tienes el control' : 'En vivo'}
            </span>
          ) : undefined
        }
      >
        {overlay}
      </LiveScreen>
      <div className="uv-browser-foot">
        <span>
          {ready && d?.running ? 'Linux · lo que ves es lo que ven los agentes' : 'Apagado'}
        </span>
        <button
          type="button"
          className={cn('uv-btn is-sm', control ? 'is-primary' : 'is-secondary')}
          disabled={!d?.running}
          onClick={() => setControl((v) => !v)}
          aria-pressed={control}
        >
          <Hand size={13} /> {control ? 'Devolver el control' : 'Tomar el control'}
        </button>
      </div>
    </div>
  );
}

function TerminalPane({
  entries,
  onRun,
  active,
}: {
  entries: ExecEntry[];
  onRun: (cmd: string) => Promise<void>;
  active: boolean;
}) {
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const logRef = useRef<HTMLDivElement>(null);
  const running = entries.some((e) => e.running);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <div className="uv-term" aria-label="Terminal de la computadora virtual">
      <div className="uv-term-log" ref={logRef} role="log">
        {entries.length === 0 && (
          <div className="uv-term-meta" style={{ marginLeft: 0 }}>
            {active
              ? 'Aquí verás los comandos que ejecutan los agentes y los tuyos. Escribe uno abajo.'
              : 'Enciende la computadora virtual para usar la terminal.'}
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id}>
            <div className="uv-term-cmd">
              <b>{e.by === 'agent' ? 'agente $' : '$'}</b>
              <span>{e.command}</span>
            </div>
            {e.running ? (
              <div className="uv-term-meta">
                <Loader2 size={11} className="uv-spin" style={{ verticalAlign: '-2px' }} />{' '}
                ejecutando…
              </div>
            ) : (
              <>
                {e.output && (
                  <pre
                    className={cn('uv-term-out', e.exitCode && e.exitCode !== 0 ? 'is-error' : '')}
                  >
                    {e.output}
                  </pre>
                )}
                <div className="uv-term-meta">
                  {typeof e.exitCode === 'number' && e.exitCode !== 0
                    ? `código ${e.exitCode} · `
                    : ''}
                  {timeAgo(e.ts)}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <form
        className="uv-term-input"
        onSubmit={(ev) => {
          ev.preventDefault();
          const c = cmd.trim();
          if (!c || running || !active) return;
          setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
          setHIdx(-1);
          setCmd('');
          void onRun(c);
        }}
      >
        <b>$</b>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = Math.min(hIdx + 1, history.length - 1);
              setHIdx(i);
              setCmd(history[i]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const i = hIdx - 1;
              setHIdx(i);
              setCmd(i >= 0 ? history[i] : '');
            }
          }}
          placeholder={active ? 'ls, git status, npm test…' : 'Computadora apagada'}
          aria-label="Comando"
          disabled={!active}
          spellCheck={false}
          autoComplete="off"
        />
        {running && <Loader2 size={13} className="uv-spin" />}
      </form>
    </div>
  );
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number | null;
  modifiedAt?: string | null;
}

function FilesPane({ active, refreshKey }: { active: boolean; refreshKey: number }) {
  const [path, setPath] = useState(HOME);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (p: string) => {
    setFiles(null);
    setError(null);
    try {
      const res = await fetch(`/app/assistant/api/venue/files?path=${encodeURIComponent(p)}`);
      const d = (await res.json().catch(() => ({}))) as { files?: FileEntry[]; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'No se pudo listar');
      setFiles(d.files ?? []);
    } catch (err) {
      setFiles([]);
      setError(err instanceof Error ? err.message : 'No se pudo listar');
    }
  }, []);

  useEffect(() => {
    if (active) void load(path);
  }, [active, path, refreshKey, load]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) {
        const form = new FormData();
        form.append('file', f);
        form.append('dir', path);
        const res = await fetch('/app/assistant/api/venue/file', { method: 'POST', body: form });
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(d.error ?? `No se pudo subir ${f.name}`);
      }
      toast.success('Archivo(s) en la computadora virtual');
      await load(path);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir');
    } finally {
      setUploading(false);
    }
  };

  if (!active) {
    return (
      <div className="uv-empty">
        <HardDrive size={22} />
        <span className="uv-empty-title">La computadora virtual está apagada</span>
        <span>Enciéndela para ver los archivos que crean los agentes.</span>
      </div>
    );
  }
  const crumbs = path.split('/').filter(Boolean);
  return (
    <div className="uv-fb">
      <div className="uv-fb-bar">
        <nav className="uv-fb-path" aria-label="Ruta">
          <button type="button" onClick={() => setPath('/')}>
            /
          </button>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <ChevronRight size={12} />
              <button type="button" onClick={() => setPath(`/${crumbs.slice(0, i + 1).join('/')}`)}>
                {c}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <IconButton label="Actualizar" size="sm" onClick={() => void load(path)}>
          <RefreshCw size={14} />
        </IconButton>
        <IconButton
          label="Subir archivo aquí"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? <Loader2 size={14} className="uv-spin" /> : <Upload size={14} />}
        </IconButton>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          onChange={(e) => void upload(e.target.files)}
        />
      </div>
      <div className="uv-fb-list">
        {files === null && <div className="uv-skel" style={{ height: 120, margin: 10 }} />}
        {error && (
          <p className="uv-section-note" style={{ padding: 12 }}>
            {error}
          </p>
        )}
        {files && files.length === 0 && !error && (
          <p className="uv-section-note" style={{ padding: 12 }}>
            Carpeta vacía.
          </p>
        )}
        {path !== '/' && files && (
          <button
            type="button"
            className="uv-fb-row"
            onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '/')}
          >
            <Folder size={15} className="is-dir" />
            <span>..</span>
          </button>
        )}
        {files?.map((f) =>
          f.isDir ? (
            <button
              key={f.path}
              type="button"
              className="uv-fb-row"
              onClick={() => setPath(f.path)}
            >
              <Folder size={15} className="is-dir" />
              <span>{f.name}</span>
              <small>{f.modifiedAt ? timeAgo(f.modifiedAt) : ''}</small>
            </button>
          ) : (
            <a
              key={f.path}
              className="uv-fb-row"
              href={`/app/assistant/api/venue/file?path=${encodeURIComponent(f.path)}`}
              download={f.name}
              title="Descargar"
            >
              <FileIcon size={15} />
              <span>{f.name}</span>
              <small>{formatBytes(f.size ?? undefined)}</small>
              <Download size={13} />
            </a>
          )
        )}
      </div>
    </div>
  );
}

export function ComputerView({
  venue,
  execs,
  onUserExec,
  previews,
  sub,
  onSubChange,
}: {
  venue: VenueApi;
  execs: ExecEntry[];
  onUserExec: (entry: ExecEntry) => void;
  previews: PreviewEntry[];
  sub: Sub;
  onSubChange: (sub: Sub) => void;
}) {
  const active = Boolean(venue.state?.active && !venue.state.paused);
  const [filesKey, setFilesKey] = useState(0);

  const run = async (command: string) => {
    const id = `u-${Date.now()}`;
    onUserExec({ id, command, by: 'user', ts: Date.now(), running: true });
    const r = await post<{ output?: string; exitCode?: number; error?: string }>(
      '/app/assistant/api/venue/exec',
      { command }
    );
    onUserExec({
      id,
      command,
      by: 'user',
      ts: Date.now(),
      running: false,
      output: r.ok ? r.data.output : (r.data.error ?? 'No se pudo ejecutar'),
      exitCode: r.ok ? (r.data.exitCode ?? 0) : 1,
    });
    setFilesKey((k) => k + 1);
  };

  return (
    <div className="uv-ws-scroll">
      <div className="uv-toolbar">
        <div className="uv-subtabs" role="tablist" aria-label="Computadora virtual">
          <button
            type="button"
            role="tab"
            aria-selected={sub === 'desktop'}
            className={cn(sub === 'desktop' && 'is-active')}
            onClick={() => onSubChange('desktop')}
          >
            <Monitor size={13} /> Escritorio
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sub === 'terminal'}
            className={cn(sub === 'terminal' && 'is-active')}
            onClick={() => onSubChange('terminal')}
          >
            <Terminal size={13} /> Terminal
            {execs.some((e) => e.running) && <span className="uv-live-dot is-working" />}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sub === 'files'}
            className={cn(sub === 'files' && 'is-active')}
            onClick={() => onSubChange('files')}
          >
            <FolderOpen size={13} /> Archivos
          </button>
        </div>
        <span className="uv-grow" />
        {venue.state?.active && (
          <button
            type="button"
            className="uv-btn is-ghost is-sm"
            onClick={() => void venue.stop()}
            disabled={venue.stopping}
            title="Apaga la computadora virtual (se conserva para la próxima vez)"
          >
            {venue.stopping ? <Loader2 size={13} className="uv-spin" /> : <Power size={13} />}{' '}
            Apagar
          </button>
        )}
      </div>

      <DesktopPane venue={venue} sub={sub} />
      {sub === 'terminal' && <TerminalPane entries={execs} onRun={run} active={active} />}
      {sub === 'files' && <FilesPane active={active} refreshKey={filesKey} />}

      {venue.error && sub === 'desktop' && (
        <div className="uv-banner" role="alert">
          <span>{venue.error}</span>
          <IconButton
            label="Cerrar aviso"
            size="sm"
            tip={false}
            onClick={() => venue.setError(null)}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}

      {previews.length > 0 && (
        <div className="uv-block">
          <div className="uv-block-head">
            <span>Apps que están corriendo</span>
          </div>
          {previews.slice(0, 6).map((p) => (
            <a
              key={p.url}
              className="uv-link-card"
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <AppWindow size={16} />
              <div>
                <strong>{p.label || `Vista previa · puerto ${p.port ?? ''}`}</strong>
                <span>Enlace temporal · {timeAgo(p.ts)}</span>
              </div>
              <ExternalLink size={14} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

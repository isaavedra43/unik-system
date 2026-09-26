'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, Globe, Monitor, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentInfo, ArtifactInfo, MessageData, TeamTask, WorkspaceTab } from '../lib/types';
import { useRealtime } from '../lib/realtime';
import { stepLabel } from '../lib/tools';
import { IconButton } from '../ui';
import { useVenue } from './useVenue';
import { BrowserView, type BrowserFeedItem } from './BrowserView';
import { ComputerView, type ExecEntry, type PreviewEntry } from './ComputerView';
import { TeamView } from './TeamView';
import { FilesView, type MediaEntry, type PageEntry } from './FilesView';

/**
 * Right column — where the agents' work becomes visible: their browser, the
 * virtual computer (desktop, terminal, files), the team and every file they
 * produced. History comes from the thread's tool records; live updates from
 * the `assistant:{conversationId}` realtime channel.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);

const WS_EVENTS = [
  'workspace.tool',
  'workspace.pages',
  'workspace.page_content',
  'workspace.screen',
  'workspace.browser',
  'workspace.artifact',
  'workspace.media',
  'workspace.secure_input',
  'workspace.desktop',
  'workspace.desktop_screen',
  'workspace.preview',
  'workspace.site',
] as const;

function mediaUrlOf(res: Obj): string | undefined {
  const inner = obj(res.result);
  return (
    str(inner.url) ??
    str(inner.imageUrl) ??
    str(inner.videoUrl) ??
    str(inner.mediaUrl) ??
    str(arr(inner.images)[0]?.url) ??
    str(arr(inner.results)[0]?.url)
  );
}

interface Derived {
  feed: BrowserFeedItem[];
  execs: ExecEntry[];
  pages: PageEntry[];
  media: MediaEntry[];
  previews: PreviewEntry[];
  artifacts: ArtifactInfo[];
}

/** History of this thread, rebuilt from the persisted tool records. */
function deriveFromMessages(messages: MessageData[]): Derived {
  const out: Derived = { feed: [], execs: [], pages: [], media: [], previews: [], artifacts: [] };
  for (const m of messages) {
    const ts = Date.parse(m.createdAt) || Date.now();
    for (const a of m.artifacts ?? []) out.artifacts.push(a);
    for (const r of m.toolCallRecords ?? []) {
      const args = obj(r.args);
      const res = obj(r.result);
      switch (r.toolName) {
        case 'browser':
          out.feed.push({
            id: r.id,
            label: stepLabel('browser', r.args, false),
            url: str(res.url) ?? str(args.url) ?? null,
            ok: r.success && res.ok !== false && !str(res.error),
            ts,
          });
          break;
        case 'venueExec':
          out.execs.push({
            id: r.id,
            command: String(args.command ?? ''),
            output:
              typeof res.output === 'string'
                ? res.output.slice(0, 6000)
                : r.success
                  ? ''
                  : (r.errorCode ?? 'Error'),
            exitCode: typeof res.exitCode === 'number' ? res.exitCode : r.success ? 0 : 1,
            by: 'agent',
            ts,
          });
          break;
        case 'web_search':
          for (const p of arr(res.results)) {
            const url = str(p.url);
            if (url)
              out.pages.push({
                url,
                title: str(p.title),
                snippet: str(p.content) ?? str(p.snippet),
                ts,
              });
          }
          break;
        case 'web_research':
          for (const p of arr(res.sources)) {
            const url = str(p.url);
            if (url) out.pages.push({ url, title: str(p.title), snippet: str(p.excerpt), ts });
          }
          break;
        case 'fetch_url': {
          const url = str(res.url) ?? str(args.url);
          if (url) out.pages.push({ url, title: str(res.title), ts });
          break;
        }
        case 'venuePreview': {
          const url = str(res.url);
          if (url)
            out.previews.push({
              url,
              port: typeof res.port === 'number' ? res.port : null,
              label: str(res.label),
              ts,
            });
          break;
        }
        default:
          if (str(res.medium)) {
            const url = mediaUrlOf(res);
            if (url) out.media.push({ url, medium: String(res.medium), ts });
          }
      }
    }
  }
  out.feed.reverse();
  out.pages.reverse();
  out.media.reverse();
  out.previews.reverse();
  return out;
}

export interface WorkspaceProps {
  conversationId: string | null;
  messages: MessageData[];
  agentWorking: boolean;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  visible: boolean;
  teachRequested: boolean;
  onTeachHandled: () => void;
  teamTasks: TeamTask[];
  agents: AgentInfo[];
  onOpenConversation: (id: string) => void;
  onClose: () => void;
  /** Something new happened on a surface the user isn't looking at. */
  onActivity?: (tab: WorkspaceTab) => void;
}

export function Workspace({
  conversationId,
  messages,
  agentWorking,
  tab,
  onTabChange,
  visible,
  teachRequested,
  onTeachHandled,
  teamTasks,
  agents,
  onOpenConversation,
  onClose,
  onActivity,
}: WorkspaceProps) {
  const [control, setControl] = useState(false);
  const [computerSub, setComputerSub] = useState<'desktop' | 'terminal' | 'files'>('desktop');
  const [live, setLive] = useState<Derived>({
    feed: [],
    execs: [],
    pages: [],
    media: [],
    previews: [],
    artifacts: [],
  });
  const [userExecs, setUserExecs] = useState<ExecEntry[]>([]);
  const [siteBump, setSiteBump] = useState(0);

  const surface =
    tab === 'browser'
      ? 'browser'
      : tab === 'computer' && computerSub === 'desktop'
        ? 'desktop'
        : 'none';
  const venue = useVenue({ surface, visible, hot: agentWorking || control });

  // A new thread starts with a clean live layer (history comes from its records).
  useEffect(() => {
    setLive({ feed: [], execs: [], pages: [], media: [], previews: [], artifacts: [] });
    setUserExecs([]);
  }, [conversationId]);
  // Giving control back when the browser goes away.
  useEffect(() => {
    if (!venue.state?.active) setControl(false);
  }, [venue.state?.active]);

  const history = useMemo(() => deriveFromMessages(messages), [messages]);

  const onEvent = useCallback(
    (type: string, p: Obj) => {
      const ts = Date.now();
      switch (type) {
        case 'workspace.tool': {
          const detail = obj(p.detail);
          if (detail.kind === 'exec') {
            setLive((l) => ({
              ...l,
              execs: [
                ...l.execs,
                {
                  id: `rt-${ts}`,
                  command: String(detail.command ?? ''),
                  output: String(detail.output ?? ''),
                  exitCode: typeof detail.exitCode === 'number' ? detail.exitCode : null,
                  by: 'agent',
                  ts,
                },
              ],
            }));
            onActivity?.('computer');
          }
          break;
        }
        case 'workspace.browser':
          setLive((l) => ({
            ...l,
            feed: [
              {
                id: `rt-${ts}`,
                label: stepLabel('browser', { action: p.action, url: p.url }, false),
                url: str(p.url) ?? null,
                ok: p.ok !== false && !p.error,
                ts,
              },
              ...l.feed,
            ],
          }));
          onActivity?.('browser');
          break;
        case 'workspace.screen':
          if (str(p.dataUrl)) {
            venue.applyBrowser({
              frame: String(p.dataUrl),
              url: str(p.url) ?? null,
              title: str(p.title) ?? null,
              ...(p.viewport ? { viewport: p.viewport as { width: number; height: number } } : {}),
              ready: true,
            });
          }
          break;
        case 'workspace.desktop_screen':
          if (str(p.dataUrl)) {
            venue.applyDesktop({
              frame: String(p.dataUrl),
              width: typeof p.width === 'number' ? p.width : null,
              height: typeof p.height === 'number' ? p.height : null,
              running: true,
            });
          }
          onActivity?.('computer');
          break;
        case 'workspace.pages':
          setLive((l) => ({
            ...l,
            pages: [
              ...arr(p.pages)
                .filter((x) => str(x.url))
                .map((x) => ({
                  url: String(x.url),
                  title: str(x.title),
                  snippet: str(x.snippet),
                  ts,
                })),
              ...l.pages,
            ],
          }));
          break;
        case 'workspace.media':
          if (str(p.url))
            setLive((l) => ({
              ...l,
              media: [{ url: String(p.url), medium: str(p.medium) ?? 'image', ts }, ...l.media],
            }));
          onActivity?.('files');
          break;
        case 'workspace.artifact':
          if (str(p.artifactId)) {
            setLive((l) => ({
              ...l,
              artifacts: [
                ...l.artifacts,
                {
                  artifactId: String(p.artifactId),
                  type: ((['pdf', 'xlsx', 'docx', 'csv', 'table', 'chart', 'image'] as const).find(
                    (t) => t === p.artifactType
                  ) ?? 'pdf') as ArtifactInfo['type'],
                  title: str(p.title) ?? str(p.fileName) ?? 'Archivo',
                  filename: str(p.fileName),
                  downloadUrl: str(p.downloadUrl),
                  mimeType: str(p.mimeType),
                },
              ],
            }));
          }
          onActivity?.('files');
          break;
        case 'workspace.preview':
          if (str(p.url)) {
            setLive((l) => ({
              ...l,
              previews: [
                {
                  url: String(p.url),
                  port: typeof p.port === 'number' ? p.port : null,
                  label: str(p.label),
                  ts,
                },
                ...l.previews,
              ],
            }));
          }
          onActivity?.('computer');
          break;
        case 'workspace.site':
          setSiteBump((n) => n + 1);
          onActivity?.('files');
          break;
        case 'workspace.secure_input':
          void venue.refresh();
          onTabChange('browser');
          break;
        case 'workspace.desktop':
          void venue.refresh();
          break;
        default:
          break;
      }
    },
    [venue, onActivity, onTabChange]
  );

  useRealtime([conversationId ? `assistant:${conversationId}` : null], WS_EVENTS, onEvent);

  // Live layer first, then history (deduped by id/url where it matters).
  const feed = [...live.feed, ...history.feed];
  const execs = useMemo(() => {
    const list = [
      ...history.execs,
      ...live.execs.filter(
        (e) =>
          !history.execs.some((h) => h.command === e.command && Math.abs(h.ts - e.ts) < 120_000)
      ),
      ...userExecs,
    ];
    return list.sort((a, b) => a.ts - b.ts).slice(-60);
  }, [history.execs, live.execs, userExecs]);
  const pages = [...live.pages, ...history.pages];
  const media = [
    ...new Map([...live.media, ...history.media].map((m) => [m.url, m] as const)).values(),
  ];
  const previews = [
    ...new Map([...live.previews, ...history.previews].map((m) => [m.url, m] as const)).values(),
  ];
  const artifacts = [...history.artifacts, ...live.artifacts];

  const browserLive = Boolean(
    venue.state?.active && venue.state.browser?.ready && !venue.state.paused
  );
  const pendingInputs = venue.state?.pendingInputs?.length ?? 0;
  const runningTasks = teamTasks.filter((t) =>
    ['queued', 'pending', 'running'].includes(t.status)
  ).length;

  const tabs: Array<{
    id: WorkspaceTab;
    label: string;
    icon: React.ReactNode;
    dot?: 'live' | 'working' | 'warn' | null;
  }> = [
    {
      id: 'browser',
      label: 'Navegador',
      icon: <Globe size={15} />,
      dot: pendingInputs ? 'warn' : browserLive ? (agentWorking ? 'working' : 'live') : null,
    },
    {
      id: 'computer',
      label: 'Computadora',
      icon: <Monitor size={15} />,
      dot: venue.state?.desktop?.running ? 'live' : execs.some((e) => e.running) ? 'working' : null,
    },
    {
      id: 'team',
      label: 'Equipo',
      icon: <Users size={15} />,
      dot: runningTasks ? 'working' : null,
    },
    { id: 'files', label: 'Archivos', icon: <FolderOpen size={15} /> },
  ];

  return (
    <aside className="uv-ws" aria-label="Espacio de trabajo">
      <div className="uv-ws-head">
        <div className="uv-ws-tabs" role="tablist" aria-label="Superficies de trabajo">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`uv-tab-${t.id}`}
              aria-controls={`uv-panel-${t.id}`}
              aria-selected={tab === t.id}
              data-state={tab === t.id ? 'active' : 'inactive'}
              className="uv-ws-tab"
              onClick={() => onTabChange(t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
              {t.dot && (
                <span
                  className={cn(
                    'uv-live-dot',
                    t.dot === 'working' && 'is-working',
                    t.dot === 'warn' && 'is-warn'
                  )}
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
        <IconButton label="Cerrar el espacio de trabajo" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </div>

      <div
        className="uv-ws-body"
        role="tabpanel"
        id={`uv-panel-${tab}`}
        aria-labelledby={`uv-tab-${tab}`}
      >
        {tab === 'browser' && (
          <BrowserView
            venue={venue}
            control={control}
            onControlChange={setControl}
            teachRequested={teachRequested}
            onTeachHandled={onTeachHandled}
            feed={feed}
          />
        )}
        {tab === 'computer' && (
          <ComputerView
            venue={venue}
            execs={execs}
            onUserExec={(e) => setUserExecs((prev) => [...prev.filter((x) => x.id !== e.id), e])}
            previews={previews}
            sub={computerSub}
            onSubChange={setComputerSub}
          />
        )}
        {tab === 'team' && (
          <TeamView
            tasks={teamTasks}
            agents={agents}
            visible={visible && tab === 'team'}
            onOpenConversation={onOpenConversation}
          />
        )}
        {tab === 'files' && (
          <FilesView
            conversationId={conversationId}
            artifacts={artifacts}
            media={media}
            pages={pages}
            visible={visible && tab === 'files'}
            siteBump={siteBump}
          />
        )}
      </div>
    </aside>
  );
}

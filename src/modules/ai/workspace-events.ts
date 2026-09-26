import { publishRealtime } from '@/modules/realtime/realtime-service';
import type { ToolExecutionResult } from './tools/registry';

/**
 * Agent Workspace feed — the third column of the assistant page.
 *
 * Every meaningful thing the agent does (search the web, open a page, act in
 * the virtual computer, produce a file) is mirrored here as a persisted
 * realtime event on the `assistant:{conversationId}` channel. The workspace
 * panel subscribes through /app/realtime/api/stream and replays on reconnect,
 * so the feed survives reloads and shows what the agent did while you were
 * away.
 *
 * Failure policy: emitting must NEVER break or delay the answer — every emit
 * swallows its own errors and the caller fire-and-forgets it.
 */

export const workspaceChannel = (conversationId: string) => `assistant:${conversationId}`;

export type WorkspaceEventType =
  'tool' | 'pages' | 'page_content' | 'screen' | 'browser' | 'artifact' | 'media' | 'secure_input';

interface WorkspaceEvent {
  type: WorkspaceEventType;
  payload: Record<string, unknown>;
}

/** Screenshots go inline (compressed jpeg). Cap so a giant frame can't bloat the event row. */
const MAX_SCREENSHOT_B64 = 1_400_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);

function summarize(tool: string, args: unknown): string {
  const a = obj(args);
  switch (tool) {
    case 'web_search':
      return `Búsqueda: ${str(a.query) ?? ''}`;
    case 'fetch_url':
      return `Leyendo: ${str(a.url) ?? ''}`;
    case 'web_crawl':
      return `Rastreo: ${str(a.url) ?? ''}`;
    case 'browser':
      return `Navegador: ${str(a.action) ?? ''}${a.url ? ` ${a.url}` : ''}`;
    case 'venueExec':
      return `Terminal: ${String(a.command ?? '').slice(0, 90)}`;
    case 'venueScreenshot':
      return 'Captura de pantalla de la computadora';
    case 'venueListFiles':
      return `Archivos: ${str(a.path) ?? '/'}`;
    case 'venueReadFile':
      return `Leer: ${str(a.path) ?? ''}`;
    case 'venueWriteFile':
      return `Escribir: ${str(a.path) ?? ''}`;
    default:
      return '';
  }
}

/** Output caps for the panel — the terminal shows real results, not everything. */
const MAX_EXEC_OUTPUT = 6_000;
const MAX_FILE_PREVIEW = 4_000;
const MAX_FILE_ENTRIES = 200;

/**
 * What the "Computadora" surface renders under a tool line: the command's
 * output, a directory listing, a file preview. Untrusted content — the panel
 * renders it as text only. Nothing here is sent to the model.
 */
function venueDetail(tool: string, args: unknown, res: Obj): Record<string, unknown> | undefined {
  const a = obj(args);
  switch (tool) {
    case 'venueExec':
      return {
        kind: 'exec',
        command: String(a.command ?? '').slice(0, 400),
        cwd: str(a.cwd),
        exitCode: typeof res.exitCode === 'number' ? res.exitCode : null,
        output: String(res.output ?? '').slice(0, MAX_EXEC_OUTPUT),
        truncated: String(res.output ?? '').length > MAX_EXEC_OUTPUT,
      };
    case 'venueListFiles': {
      const files = arr(res.files)
        .slice(0, MAX_FILE_ENTRIES)
        .map((f) => ({
          name: str(f.name) ?? '',
          path: str(f.path),
          isDir: f.isDir === true,
          size: typeof f.size === 'number' ? f.size : null,
          modifiedAt: str(f.modifiedAt),
        }));
      return { kind: 'files', path: str(a.path) ?? '/', files, total: arr(res.files).length };
    }
    case 'venueReadFile':
      return {
        kind: 'file',
        path: str(res.path) ?? str(a.path),
        preview: String(res.content ?? '').slice(0, MAX_FILE_PREVIEW),
        truncated: String(res.content ?? '').length > MAX_FILE_PREVIEW,
      };
    case 'venueWriteFile':
      return {
        kind: 'file',
        path: str(res.path) ?? str(a.path),
        bytes: typeof res.bytes === 'number' ? res.bytes : null,
        written: true,
      };
    default:
      return undefined;
  }
}

function dataUrl(b64: unknown, mime: unknown): string | undefined {
  const s = str(b64);
  if (!s || s.length > MAX_SCREENSHOT_B64) return undefined;
  return `data:${str(mime) ?? 'image/jpeg'};base64,${s}`;
}

/**
 * Maps a finished tool call to the workspace events it produces.
 * Pure function — the orchestrator emits whatever this returns.
 */
export function workspaceEventsForTool(
  tool: string,
  args: unknown,
  result: ToolExecutionResult
): WorkspaceEvent[] {
  const events: WorkspaceEvent[] = [];
  const res = result.success ? obj(result.result) : {};
  const summary = summarize(tool, args);

  const softError = str(res.error);
  const detail = result.success && !softError ? venueDetail(tool, args, res) : undefined;
  events.push({
    type: 'tool',
    payload: {
      tool,
      // success:true also covers tools that returned {error} gracefully —
      // show the red mark for those too, or every failure looks green.
      ok: result.success && !softError && res.ok !== false,
      needsApproval: result.needsApproval === true,
      summary,
      error: result.success ? softError : str(result.error),
      ...(detail ? { detail } : {}),
    },
  });

  if (!result.success) return events;

  switch (tool) {
    case 'web_search': {
      const pages = arr(res.results)
        .map((r) => ({
          url: str(r.url),
          title: str(r.title),
          snippet: str(r.content) ?? str(r.snippet),
        }))
        .filter((p) => p.url);
      if (pages.length > 0) {
        events.push({
          type: 'pages',
          payload: { source: 'web_search', query: str(obj(args).query), pages },
        });
      }
      break;
    }
    case 'web_research': {
      const pages = arr(res.sources)
        .map((s) => ({ url: str(s.url), title: str(s.title), snippet: str(s.excerpt) }))
        .filter((p) => p.url);
      if (pages.length > 0) {
        events.push({
          type: 'pages',
          payload: { source: 'web_research', query: str(obj(args).goal), pages },
        });
      }
      for (const s of arr(res.sources)) {
        const url = str(s.url);
        if (url && str(s.excerpt)) {
          events.push({
            type: 'page_content',
            payload: { url, title: str(s.title), markdown: str(s.excerpt) },
          });
        }
      }
      break;
    }
    case 'fetch_url': {
      const url = str(res.url) ?? str(obj(args).url);
      if (url) {
        events.push({
          type: 'pages',
          payload: { source: 'fetch_url', pages: [{ url, title: str(res.title), reading: true }] },
        });
        events.push({
          type: 'page_content',
          payload: { url, title: str(res.title), markdown: str(res.content)?.slice(0, 40_000) },
        });
      }
      break;
    }
    case 'web_crawl': {
      const pages = arr(res.pages)
        .map((p) => ({ url: str(p.url), title: str(p.title), snippet: str(p.excerpt) }))
        .filter((p) => p.url);
      if (pages.length > 0) {
        events.push({ type: 'pages', payload: { source: 'web_crawl', pages } });
      }
      break;
    }
    case 'browser': {
      events.push({
        type: 'browser',
        payload: {
          action: str(obj(args).action) ?? 'open',
          url: str(res.url) ?? str(obj(args).url),
          ok: res.ok === true,
          error: str(res.error),
        },
      });
      const shot = dataUrl(res.screenshotBase64, res.screenshotMimeType ?? 'image/jpeg');
      if (shot)
        events.push({
          type: 'screen',
          payload: { dataUrl: shot, url: str(res.url) ?? str(obj(args).url) },
        });
      // secureInput — user takeover: the workspace renders the masked form.
      const inputRequest = obj(res.inputRequest);
      if (res.awaitingUserInput === true && str(inputRequest.id)) {
        events.push({
          type: 'secure_input',
          payload: {
            requestId: str(inputRequest.id),
            venueSessionId: str(res.venueSessionId),
            message: str(inputRequest.message),
            fields: arr(inputRequest.fields).map((f) => ({
              selector: str(f.selector),
              label: str(f.label) ?? 'Campo',
              sensitive: f.sensitive === true,
            })),
          },
        });
      }
      break;
    }
    case 'venueScreenshot': {
      const shot = dataUrl(res.imageBase64, res.mimeType);
      if (shot) events.push({ type: 'screen', payload: { dataUrl: shot } });
      break;
    }
    default: {
      // Media generation tools return { medium, providerTool, result: {…url…} }.
      if (str(res.medium)) {
        const inner = obj(res.result);
        const mediaUrl =
          str(inner.url) ??
          str(inner.imageUrl) ??
          str(inner.videoUrl) ??
          str(inner.mediaUrl) ??
          str(arr(inner.images)[0]?.url) ??
          str(arr(inner.results)[0]?.url);
        events.push({
          type: 'media',
          payload: {
            medium: str(res.medium),
            providerTool: str(res.providerTool),
            url: mediaUrl,
            ok: !str(res.error),
          },
        });
      }
      // Artifact-producing tools return { artifactId, title, filename, downloadUrl }.
      const artifactId = str(res.artifactId);
      if (artifactId) {
        events.push({
          type: 'artifact',
          payload: {
            artifactId,
            title: str(res.title) ?? str(res.filename),
            fileName: str(res.filename),
            mimeType: str(res.mimeType),
            downloadUrl:
              str(res.downloadUrl) ?? `/app/assistant/api/artifacts/${artifactId}/download`,
            artifactType: str(res.type),
          },
        });
      }
      break;
    }
  }
  return events;
}

/** Emits workspace events for a conversation. Never throws, never delays the turn. */
export function emitWorkspaceEvents(
  conversationId: string | undefined,
  events: WorkspaceEvent[]
): void {
  if (!conversationId || events.length === 0) return;
  for (const ev of events) {
    void publishRealtime(workspaceChannel(conversationId), `workspace.${ev.type}`, {
      ...ev.payload,
      ts: new Date().toISOString(),
    }).catch(() => undefined);
  }
}

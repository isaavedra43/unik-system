import {
  MAX_UI_COMPONENTS_PER_TOOL,
  MAX_UI_ITEMS,
  type UiComponent,
  type UiField,
  type UiMcpResource,
  type UiRecord,
  type UiToolResultInput,
  type UiTone,
} from './types';

/**
 * Tool result → UI specs. Deterministic and defensive: every string is cut,
 * every URL must be http(s), unknown shapes fall back to a generic record or
 * table instead of failing. No model output is ever interpreted as markup.
 */

const TITLE_KEYS = [
  'title',
  'summary',
  'subject',
  'name',
  'full_name',
  'fullName',
  'displayName',
  'display_name',
  'filename',
  'fileName',
  'label',
  'text',
  'message',
  'id',
];
const SUBTITLE_KEYS = [
  'from',
  'sender',
  'author',
  'organizer',
  'owner',
  'user',
  'creator',
  'assignee',
  'channel',
  'email',
  'company',
  'location',
];
const BODY_KEYS = [
  'snippet',
  'preview',
  'messageText',
  'message_text',
  'body',
  'description',
  'content',
  'text',
  'notes',
];
const DATE_KEYS = [
  'start',
  'startTime',
  'date',
  'messageTimestamp',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
  'timestamp',
  'modifiedTime',
  'createdTime',
  'due',
  'due_date',
  'ts',
];
const URL_KEYS = [
  'html_url',
  'htmlLink',
  'webViewLink',
  'webLink',
  'permalink',
  'url',
  'link',
  'web_url',
  'alternateLink',
];
const BADGE_KEYS = ['state', 'status', 'priority', 'stage'];
const ARRAY_PRIORITY = [
  'messages',
  'items',
  'results',
  'events',
  'issues',
  'pull_requests',
  'records',
  'values',
  'files',
  'channels',
  'threads',
  'repositories',
  'tasks',
  'pages',
  'rows',
  'data',
  'contacts',
  'deals',
  'tickets',
  'list',
];
const SKIP_FIELD =
  /(^|_)(id|ids|etag|kind|node_id|sha|token|hash|key)$|^(id|etag|kind|labelIds|_omitted)$|url$|_url$|Url$/;
const NAME_LIKE = [
  'login',
  'name',
  'displayName',
  'display_name',
  'email',
  'emailAddress',
  'address',
  'title',
  'summary',
  'dateTime',
  'date',
];

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Human text of a scalar or of a "person/date-like" object (author, start, organizer…). */
function textOf(value: unknown, depth = 0): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => textOf(v, depth + 1)).filter((v): v is string => Boolean(v));
    return parts.length ? cut(parts.slice(0, 4).join(', '), 120) : undefined;
  }
  if (isObj(value) && depth < 2) {
    for (const k of NAME_LIKE) {
      const t = textOf(value[k], depth + 1);
      if (t) return t;
    }
  }
  return undefined;
}

function toIso(key: string, value: unknown): string | undefined {
  const raw = textOf(value);
  if (!raw) return undefined;
  if (/^\d{10}(\.\d+)?$/.test(raw)) return new Date(Number(raw) * 1000).toISOString();
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw)).toISOString();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) || key === 'date') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : raw;
  }
  return undefined;
}

function toneFor(label: string): UiTone {
  const v = label.toLowerCase();
  if (
    /(open|active|success|done|complete|paid|approved|merged|resolved|confirmed|connected)/.test(v)
  )
    return 'success';
  if (/(fail|error|closed|declined|rejected|overdue|cancel|denied|blocked)/.test(v))
    return 'danger';
  if (/(pending|draft|review|waiting|tentative|progress|high|urgent)/.test(v)) return 'warning';
  return 'neutral';
}

export function toRecord(obj: Record<string, unknown>): UiRecord | null {
  const used = new Set<string>();
  const pick = (
    keys: string[],
    transform: (k: string, v: unknown) => string | undefined
  ): string | undefined => {
    for (const k of keys) {
      if (!(k in obj)) continue;
      const t = transform(k, obj[k]);
      if (t) {
        used.add(k);
        return t;
      }
    }
    return undefined;
  };

  const title = pick(TITLE_KEYS, (_k, v) => textOf(v));
  if (!title) return null;
  const subtitle = pick(SUBTITLE_KEYS, (_k, v) => textOf(v));
  let body = pick(BODY_KEYS, (_k, v) =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : undefined
  );
  if (body && (body === title || title.startsWith(body.slice(0, 40)))) body = undefined;
  const date = pick(DATE_KEYS, (k, v) => toIso(k, v));
  const url = (() => {
    for (const k of URL_KEYS) {
      const u = safeHttpUrl(obj[k]);
      if (u) {
        used.add(k);
        return u;
      }
    }
    return undefined;
  })();
  const badgeText = pick(BADGE_KEYS, (_k, v) => textOf(v));

  const fields: UiField[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (used.has(k) || SKIP_FIELD.test(k) || fields.length >= 4) continue;
    const t =
      typeof v === 'object' && !Array.isArray(v)
        ? textOf(v)
        : typeof v === 'object'
          ? undefined
          : textOf(v);
    if (t && t.length <= 80) fields.push({ label: humanize(k), value: t });
  }

  return {
    title: cut(title.replace(/\s+/g, ' '), 140),
    ...(subtitle ? { subtitle: cut(subtitle, 120) } : {}),
    ...(body ? { body: cut(body, 260) } : {}),
    ...(date ? { date } : {}),
    ...(url ? { url } : {}),
    ...(badgeText ? { badge: { label: cut(badgeText, 30), tone: toneFor(badgeText) } } : {}),
    ...(fields.length ? { fields } : {}),
  };
}

/** Finds the list of records inside an arbitrary payload (depth ≤ 3). */
function findRecordArray(data: unknown, depth = 0): { key: string; rows: unknown[] } | null {
  if (Array.isArray(data)) return data.length > 0 ? { key: 'items', rows: data } : null;
  if (!isObj(data) || depth > 2) return null;
  const candidates: Array<{ key: string; rows: unknown[] }> = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > 0 && !key.startsWith('_'))
      candidates.push({ key, rows: value });
  }
  if (candidates.length > 0) {
    const ranked = candidates.sort((a, b) => {
      const pa = ARRAY_PRIORITY.indexOf(a.key);
      const pb = ARRAY_PRIORITY.indexOf(b.key);
      return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb) || b.rows.length - a.rows.length;
    });
    return ranked[0];
  }
  for (const value of Object.values(data)) {
    if (isObj(value)) {
      const nested = findRecordArray(value, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function omittedCount(rows: unknown[]): number {
  const last = rows[rows.length - 1];
  return isObj(last) && typeof last._omitted === 'number' ? last._omitted : 0;
}

function toTable(rows: Record<string, unknown>[]): { columns: string[]; rows: string[][] } | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (SKIP_FIELD.test(k)) continue;
      if (textOf(v) !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const columns = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k);
  if (columns.length < 2) return null;
  return {
    columns: columns.map(humanize),
    rows: rows.slice(0, MAX_UI_ITEMS).map((r) => columns.map((c) => cut(textOf(r[c]) ?? '', 80))),
  };
}

export function extractUiFromData(data: unknown, source?: string): UiComponent[] {
  if (data === null || data === undefined) return [];
  const found = findRecordArray(data);

  if (found) {
    const omitted = omittedCount(found.rows);
    const rows = found.rows.filter((r) => !(isObj(r) && '_omitted' in r));
    const total = rows.length + omitted;

    // Spreadsheet-like: array of arrays → table with first row as header.
    if (rows.every((r) => Array.isArray(r))) {
      const matrix = rows as unknown[][];
      const [head, ...body] = matrix;
      if (!head) return [];
      const columns = head.slice(0, 8).map((h) => cut(textOf(h) ?? '', 40));
      return [
        {
          type: 'table',
          source,
          columns,
          rows: body
            .slice(0, MAX_UI_ITEMS)
            .map((r) => columns.map((_c, i) => cut(textOf(r[i]) ?? '', 80))),
          total: Math.max(0, total - 1),
        },
      ];
    }

    const objects = rows.filter(isObj);
    if (objects.length === 0) {
      const texts = rows.map((r) => textOf(r)).filter((t): t is string => Boolean(t));
      return texts.length
        ? [
            {
              type: 'records',
              source,
              items: texts.slice(0, MAX_UI_ITEMS).map((t) => ({ title: cut(t, 140) })),
              total,
            },
          ]
        : [];
    }
    const records = objects.map(toRecord);
    const recognized = records.filter((r): r is UiRecord => r !== null);
    const titled = recognized.filter(
      (r) => r.title !== undefined && (r.subtitle || r.body || r.date || r.url || r.badge)
    );
    if (titled.length >= Math.ceil(objects.length * 0.6)) {
      return [{ type: 'records', source, items: recognized.slice(0, MAX_UI_ITEMS), total }];
    }
    const table = toTable(objects);
    if (table) return [{ type: 'table', source, ...table, total }];
    if (recognized.length)
      return [{ type: 'records', source, items: recognized.slice(0, MAX_UI_ITEMS), total }];
    return [];
  }

  if (isObj(data)) {
    // A single entity (or an envelope around one): look one level down for the record.
    const inner = Object.values(data).find(
      (v): v is Record<string, unknown> => isObj(v) && toRecord(v) !== null
    );
    const record = toRecord(data) ?? (inner ? toRecord(inner) : null);
    if (record) return [{ type: 'record', source, record }];
  }
  return [];
}

// ── MCP-UI resources ───────────────────────────────────────────────────────

const MCP_UI_MAX_HTML = 120_000;

/** `content[]` blocks of an MCP tool result → sandboxable UI resources (`ui://`). */
export function extractMcpUiResources(result: unknown): UiMcpResource[] {
  if (!isObj(result)) return [];
  const blocks = Array.isArray(result.uiResources)
    ? result.uiResources
    : Array.isArray(result.content)
      ? result.content
      : [];
  const out: UiMcpResource[] = [];
  for (const block of blocks) {
    if (!isObj(block)) continue;
    const res = isObj(block.resource) ? block.resource : block;
    const uri = typeof res.uri === 'string' ? res.uri : '';
    const mime =
      typeof res.mimeType === 'string' ? res.mimeType.split(';')[0].trim().toLowerCase() : '';
    if (!uri.startsWith('ui://')) continue;
    if (
      mime === 'text/html' &&
      typeof res.text === 'string' &&
      res.text.length > 0 &&
      res.text.length <= MCP_UI_MAX_HTML
    ) {
      out.push({ uri, mimeType: 'text/html', text: res.text });
    } else if (mime === 'text/uri-list' && typeof res.text === 'string') {
      const url = safeHttpUrl(res.text.split('\n')[0]);
      if (url && url.startsWith('https://'))
        out.push({ uri, mimeType: 'text/uri-list', text: url });
    }
    if (out.length >= 2) break;
  }
  return out;
}

// ── entry point ────────────────────────────────────────────────────────────

const slugLabel = (slug: string) => humanize(slug.toLowerCase());

export function buildUiComponents(input: UiToolResultInput): UiComponent[] {
  const { toolName, result, success } = input;
  if (!success || !isObj(result)) return [];
  const out: UiComponent[] = [];

  if (toolName === 'composioConnect') {
    if (typeof result.error === 'string') {
      out.push({
        type: 'notice',
        tone: 'danger',
        title: 'No se pudo preparar la conexión',
        detail: cut(result.error, 240),
      });
    } else if (typeof result.toolkit === 'string') {
      out.push({
        type: 'connect',
        toolkit: result.toolkit,
        name: typeof result.name === 'string' ? result.name : slugLabel(result.toolkit),
        connected: result.connected === true,
      });
    }
    return out;
  }

  if (toolName === 'composioListToolkits') {
    const toolkits = Array.isArray(result.toolkits) ? result.toolkits.filter(isObj) : [];
    if (toolkits.length > 0) {
      out.push({
        type: 'records',
        heading: 'Apps disponibles',
        source: 'Composio',
        total: toolkits.length,
        items: toolkits.slice(0, MAX_UI_ITEMS).map((t) => ({
          title: String(t.name ?? t.slug ?? ''),
          subtitle: String(t.slug ?? ''),
          badge: t.connected
            ? { label: 'Conectada', tone: 'success' as const }
            : { label: 'Sin conectar', tone: 'neutral' as const },
        })),
      });
    }
    return out;
  }

  if (toolName === 'composioExecute') {
    const tool = typeof result.tool === 'string' ? result.tool : 'Composio';
    const toolkit = typeof result.toolkit === 'string' ? result.toolkit : '';
    if (result.needsConnection === true && toolkit) {
      return [{ type: 'connect', toolkit, name: slugLabel(toolkit), connected: false }];
    }
    if (result.successful === false) {
      return [
        {
          type: 'notice',
          tone: result.uncertain === true ? 'warning' : 'danger',
          title:
            result.uncertain === true
              ? `Resultado por confirmar · ${tool}`
              : `No se pudo ejecutar ${tool}`,
          detail: typeof result.error === 'string' ? cut(result.error, 300) : undefined,
        },
      ];
    }
    const source = toolkit ? slugLabel(toolkit) : 'Composio';
    const parts = extractUiFromData(result.data, source);
    if (parts.length > 0) return parts.slice(0, MAX_UI_COMPONENTS_PER_TOOL);
    return [
      {
        type: 'notice',
        tone: 'success',
        title: `${source}: acción completada`,
        detail: cut(tool, 120),
      },
    ];
  }

  // MCP extension tools ("<namespace>__<tool>") and their UI resources.
  if (toolName.includes('__')) {
    for (const resource of extractMcpUiResources(result))
      out.push({ type: 'mcp_ui', resource, title: humanize(toolName.split('__')[1] ?? toolName) });
    if (out.length === 0 && result.structuredContent) {
      out.push(
        ...extractUiFromData(result.structuredContent, humanize(toolName.split('__')[0] ?? ''))
      );
    }
  }
  return out.slice(0, MAX_UI_COMPONENTS_PER_TOOL);
}

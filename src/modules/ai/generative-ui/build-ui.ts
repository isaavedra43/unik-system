import { sanitizeGenUiSpec } from '../genui/validate';
import {
  MAX_UI_COMPONENTS_PER_TOOL,
  MAX_UI_ITEMS,
  type UiCardAction,
  type UiComponent,
  type UiField,
  type UiMcpResource,
  type UiMediaItem,
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
  /(^|_)(id|ids|etag|kind|node_id|sha|token|hash|key)$|^(id|etag|kind|ok|success|labelIds|_omitted)$|url$|_url$|Url$|Base64$/;
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

/** Spanish labels for the keys ERP tools return most (the rest are humanized). */
const LABELS_ES: Record<string, string> = {
  count: 'Cantidad',
  total: 'Total',
  totalsum: 'Total',
  subtotal: 'Subtotal',
  balance: 'Saldo',
  balancesum: 'Saldo',
  amount: 'Monto',
  price: 'Precio',
  rate: 'Precio',
  quantity: 'Cantidad',
  qty: 'Cantidad',
  ordernumber: 'Orden',
  ordernumbers: 'Órdenes',
  salesordernumber: 'Orden',
  customer: 'Cliente',
  customername: 'Cliente',
  vendorname: 'Proveedor',
  salesperson: 'Vendedor',
  salespersonname: 'Vendedor',
  date: 'Fecha',
  createdat: 'Creado',
  updatedat: 'Actualizado',
  duedate: 'Vence',
  status: 'Estado',
  ticketstatus: 'Ticket',
  paymentmethod: 'Pago',
  deliverymethod: 'Entrega',
  branch: 'Sucursal',
  location: 'Sucursal',
  locationname: 'Sucursal',
  warehouse: 'Almacén',
  product: 'Producto',
  productname: 'Producto',
  name: 'Nombre',
  sku: 'SKU',
  email: 'Correo',
  phone: 'Teléfono',
  label: 'Concepto',
  group: 'Grupo',
  key: 'Grupo',
  value: 'Valor',
};

/** Tools whose name the user sees as the source of a card. */
const TOOL_LABELS_ES: Record<string, string> = {
  querysalesorders: 'Ventas',
  getsalesorderdetail: 'Orden de venta',
  queryproducts: 'Productos',
  querycontacts: 'Contactos',
  getcontactfile: 'Expediente',
  querypayments: 'Pagos',
  queryinvoices: 'Facturas',
  querypurchaseorders: 'Compras',
  querypackages: 'Envíos',
  queryquotes: 'Cotizaciones',
  queryinventory: 'Inventario',
  universalsearch: 'Búsqueda',
  getdatabaseoverview: 'Panorama',
};

/** Money-like keys get currency format; other numbers get thousands separators. */
const MONEY_KEY =
  /(total|balance|saldo|amount|monto|price|precio|subtotal|importe|sum$|cost|costo|revenue|venta)/i;

export function formatCell(key: string, value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (MONEY_KEY.test(key)) {
      return `$${value.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return Number.isInteger(value)
      ? value.toLocaleString('es-MX')
      : value.toLocaleString('es-MX', { maximumFractionDigits: 2 });
  }
  return textOf(value);
}

export function toolLabel(toolName: string): string {
  return TOOL_LABELS_ES[toolName.toLowerCase()] ?? humanize(toolName);
}

export function humanize(key: string): string {
  const known = LABELS_ES[key.replace(/[_\s-]+/g, '').toLowerCase()];
  if (known) return known;
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
          : formatCell(k, v);
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
    rows: rows
      .slice(0, MAX_UI_ITEMS)
      .map((r) => columns.map((c) => cut(formatCell(c, r[c]) ?? '', 80))),
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

// ── generated media (image/video/audio URLs) ───────────────────────────────

const MEDIA_KIND_BY_EXT: Record<string, UiMediaItem['kind']> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  avif: 'image',
  bmp: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  opus: 'audio',
};
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/g;
const MEDIA_FIELD =
  /(image|img|photo|thumbnail|poster|video|clip|movie|media|file|output|download|asset|result)(_?url|_?uri|_?link)?$/i;
const MAX_MEDIA_ITEMS = 6;

function kindFromExt(url: string): UiMediaItem['kind'] | null {
  const ext = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase();
  return (ext && MEDIA_KIND_BY_EXT[ext]) || null;
}

function kindFromKey(key: string): UiMediaItem['kind'] | null {
  const k = key.toLowerCase();
  if (/(video|clip|movie|reel)/.test(k)) return 'video';
  if (/(audio|voice|sound|music)/.test(k)) return 'audio';
  if (/(image|img|photo|thumbnail|poster|picture)/.test(k)) return 'image';
  return null;
}

function pushMedia(
  out: UiMediaItem[],
  seen: Set<string>,
  url: string | undefined,
  kind: UiMediaItem['kind'] | null,
  title?: string
): void {
  if (!url || out.length >= MAX_MEDIA_ITEMS) return;
  const k = kind ?? kindFromExt(url);
  if (!k || seen.has(url)) return;
  seen.add(url);
  out.push({ kind: k, url, ...(title ? { title } : {}) });
}

/**
 * Pulls generated-media URLs out of an arbitrary tool result. Covers the
 * shapes media providers actually return: `{url, video_url, imageUrl}`,
 * `content[]` text blocks containing bare links, arrays of assets, and
 * `media/mimeType` hints next to a URL. http(s) only — never data: or ui://.
 */
export function extractMediaItems(data: unknown, depth = 0): UiMediaItem[] {
  const out: UiMediaItem[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, keyHint: string | null, d: number): void => {
    if (out.length >= MAX_MEDIA_ITEMS || d > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const direct = safeHttpUrl(value);
      if (direct) {
        pushMedia(out, seen, direct, keyHint ? kindFromKey(keyHint) : kindFromExt(direct));
        return;
      }
      if (value.includes('http')) {
        for (const m of value.match(URL_IN_TEXT) ?? []) {
          const u = safeHttpUrl(m.replace(/[.,;:!?]+$/, ''));
          if (u && kindFromExt(u)) pushMedia(out, seen, u, kindFromExt(u));
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, keyHint, d + 1);
      return;
    }
    if (!isObj(value)) return;
    // A node shaped like a media asset: a URL field + optional mime/title siblings.
    const mime =
      typeof value.mimeType === 'string'
        ? value.mimeType
        : typeof value.mediaType === 'string'
          ? value.mediaType
          : '';
    const nodeKind =
      (['image', 'video', 'audio'] as const).find((k) => mime.startsWith(`${k}/`)) ?? null;
    let nodeTitle: string | undefined;
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'string') continue;
      const u = safeHttpUrl(v);
      if (!u) continue;
      if (!MEDIA_FIELD.test(k) && !kindFromExt(u)) continue;
      if (!nodeTitle && typeof value.title === 'string') nodeTitle = cut(value.title, 100);
      if (!nodeTitle && typeof value.name === 'string') nodeTitle = cut(value.name, 100);
      pushMedia(out, seen, u, nodeKind ?? kindFromKey(k), nodeTitle);
    }
    for (const [k, v] of Object.entries(value)) walk(v, k, d + 1);
  };
  void depth;
  walk(data, null, 0);
  return out;
}

/** Follow-up chips a media card can offer: variations and cross-medium hops. */
function mediaActions(
  kind: UiMediaItem['kind'] | undefined,
  prompt: string | undefined,
  firstImageUrl?: string
): UiCardAction[] | undefined {
  if (!prompt || !kind) return undefined;
  const base = cut(prompt.replace(/\s+/g, ' ').trim(), 200);
  const actions: UiCardAction[] = [
    {
      label: 'Otra variación',
      sendText:
        kind === 'video'
          ? `Genera otro video del mismo tema pero con una toma diferente: ${base}`
          : `Genera otra versión de esta imagen con una variación interesante: ${base}`,
    },
    kind === 'image'
      ? {
          label: 'Estilo cinematográfico',
          sendText: `Genera la misma imagen pero con estilo cinematográfico: ${base}`,
        }
      : {
          label: 'Formato vertical',
          sendText: `Genera el mismo video en formato vertical 9:16: ${base}`,
        },
  ];
  if (kind === 'image' && firstImageUrl) {
    actions.push({
      label: 'Convertir en video',
      sendText: `Genera un video corto animando esta imagen: ${firstImageUrl}`,
    });
  }
  return actions.slice(0, 3);
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

// ── renderView: model-emitted view specs, revalidated here ─────────────────

const VIEW_TONES = new Set(['neutral', 'success', 'warning', 'danger', 'info']);
const viewTone = (v: unknown): UiTone => (VIEW_TONES.has(String(v)) ? (v as UiTone) : 'neutral');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown, max = 80): string => cut(textOf(v) ?? '', max);

/** Defensive parse of a `renderView` spec → closed-vocabulary UiComponent. */
export function sanitizeViewSpec(view: unknown): UiComponent | null {
  if (!isObj(view)) return null;
  switch (view.type) {
    case 'chart': {
      const labels = Array.isArray(view.labels)
        ? view.labels.slice(0, 24).map((l) => str(l, 40))
        : [];
      const series = (Array.isArray(view.series) ? view.series : [])
        .slice(0, 4)
        .map((s): { name?: string; data: number[] } | null =>
          isObj(s)
            ? {
                ...(s.name ? { name: str(s.name, 40) } : {}),
                data: (Array.isArray(s.data) ? s.data : []).slice(0, 24).map(num),
              }
            : null
        )
        .filter((s): s is { name?: string; data: number[] } => s !== null && s.data.length > 0);
      if (labels.length === 0 || series.length === 0) return null;
      const chart = view.chart === 'line' || view.chart === 'pie' ? view.chart : 'bar';
      return {
        type: 'chart',
        chart,
        labels,
        series,
        ...(view.title ? { title: str(view.title, 100) } : {}),
        ...(view.unit ? { unit: str(view.unit, 20) } : {}),
      };
    }
    case 'kpi': {
      const items = (Array.isArray(view.items) ? view.items : [])
        .filter(isObj)
        .slice(0, 8)
        .map((i) => ({
          label: str(i.label, 60),
          value: str(i.value, 60),
          ...(i.delta ? { delta: str(i.delta, 40) } : {}),
          tone: viewTone(i.tone),
        }))
        .filter((i) => i.label && i.value);
      return items.length
        ? { type: 'kpi', items, ...(view.title ? { title: str(view.title, 100) } : {}) }
        : null;
    }
    case 'progress': {
      const steps = (Array.isArray(view.steps) ? view.steps : [])
        .filter(isObj)
        .slice(0, 20)
        .map((s) => ({
          title: str(s.title, 100),
          status: (['pending', 'running', 'done', 'failed'] as const).includes(s.status as never)
            ? (s.status as 'pending' | 'running' | 'done' | 'failed')
            : 'pending',
          ...(s.detail ? { detail: str(s.detail, 120) } : {}),
        }))
        .filter((s) => s.title);
      return steps.length
        ? { type: 'progress', title: str(view.title, 100) || 'Progreso', steps }
        : null;
    }
    case 'timeline': {
      const events = (Array.isArray(view.events) ? view.events : [])
        .filter(isObj)
        .slice(0, 20)
        .map((e) => ({
          label: str(e.label, 100),
          ...(e.at ? { at: str(e.at, 40) } : {}),
          ...(e.detail ? { detail: str(e.detail, 160) } : {}),
          tone: viewTone(e.tone),
        }))
        .filter((e) => e.label);
      return events.length
        ? { type: 'timeline', events, ...(view.title ? { title: str(view.title, 100) } : {}) }
        : null;
    }
    default:
      return null;
  }
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
          badge: t.isNoAuth
            ? { label: 'Sin cuenta necesaria', tone: 'success' as const }
            : t.connected
              ? { label: 'Conectada', tone: 'success' as const }
              : { label: 'Sin conectar', tone: 'neutral' as const },
        })),
      });
      // The "Conectar" button can't depend on the model remembering to call
      // composioConnect — every unconnected app gets a live connect card.
      for (const t of toolkits.filter((x) => x.connected !== true).slice(0, 3)) {
        const slug = typeof t.slug === 'string' ? t.slug : '';
        if (!slug) continue;
        out.push({
          type: 'connect',
          toolkit: slug,
          name: typeof t.name === 'string' ? t.name : slugLabel(slug),
          connected: false,
        });
      }
    }
    return out;
  }

  // generateImage / generateVideo — the dispatcher wraps the provider result;
  // any media URL it returns becomes a real media card (img / video player),
  // not a raw link in prose.
  if (toolName === 'generateImage' || toolName === 'generateVideo') {
    const medium = toolName === 'generateImage' ? 'imagen' : 'video';
    const prompt =
      isObj(input.args) && typeof input.args.prompt === 'string'
        ? cut(input.args.prompt, 140)
        : undefined;
    if (typeof result.error === 'string') {
      return [
        {
          type: 'notice',
          tone: 'danger',
          title: `No se pudo generar el ${medium}`,
          detail: cut(result.error, 300),
        },
      ];
    }
    const items = extractMediaItems(result.result ?? result);
    if (items.length > 0) {
      const firstImage = items.find((i) => i.kind === 'image')?.url;
      out.push({
        type: 'media',
        source: typeof result.providerTool === 'string' ? humanize(result.providerTool) : undefined,
        title: prompt,
        items,
        actions: mediaActions(items[0]?.kind, prompt, firstImage),
      });
    } else {
      out.push({
        type: 'notice',
        tone: 'info',
        title: `Generación de ${medium} enviada`,
        detail:
          'El proveedor aceptó la solicitud; si devuelve un archivo o URL aparecerá aquí como tarjeta.',
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
    if (/(image|img|imagen|photo|video|media|higgs|generat|render)/i.test(tool)) {
      const items = extractMediaItems(result.data);
      if (items.length > 0) out.push({ type: 'media', source, items });
    }
    const parts = extractUiFromData(result.data, source);
    if (parts.length > 0) return [...out, ...parts].slice(0, MAX_UI_COMPONENTS_PER_TOOL);
    if (out.length > 0) return out;
    return [
      {
        type: 'notice',
        tone: 'success',
        title: `${source}: acción completada`,
        detail: cut(tool, 120),
      },
    ];
  }

  // renderInteractiveUi: agent-authored interface — payload revalidated here so a
  // tampered record can never reach the iframe.
  if (
    toolName === 'renderInteractiveUi' &&
    result.rendered === true &&
    typeof result.html === 'string'
  ) {
    out.push({
      type: 'interactive',
      title: typeof result.title === 'string' ? cut(result.title, 120) : undefined,
      html: cut(result.html, 95_000),
      css: typeof result.css === 'string' ? cut(result.css, 45_000) : undefined,
      js: typeof result.js === 'string' ? cut(result.js, 55_000) : undefined,
      height:
        typeof result.height === 'number' ? Math.min(1200, Math.max(120, result.height)) : null,
    });
    return out;
  }

  // renderUi: json-render card — the persisted spec is sanitized again.
  if (toolName === 'renderUi' && result.rendered === true && isObj(result.spec)) {
    const { spec } = sanitizeGenUiSpec(result.spec);
    if (spec) {
      out.push({
        type: 'genui',
        spec,
        ...(typeof result.title === 'string' && result.title
          ? { title: result.title.slice(0, 120) }
          : {}),
      });
    }
    return out;
  }

  // renderView: the model drew a chart/kpi/progress/timeline — spec revalidated.
  if (toolName === 'renderView' && isObj(result.view)) {
    const spec = sanitizeViewSpec(result.view);
    if (spec) out.push(spec);
    return out;
  }

  // MCP extension tools ("<namespace>__<tool>") and their UI resources. Media
  // generators (Higgsfield & co.) get a real media card first — the provider's
  // own ui:// component and the raw data cards come after.
  if (toolName.includes('__')) {
    const media = extractMediaItems(result);
    if (media.length > 0) {
      const argPrompt =
        isObj(input.args) && typeof input.args.prompt === 'string'
          ? cut(input.args.prompt, 140)
          : undefined;
      out.push({
        type: 'media',
        source: humanize(toolName.split('__')[0] ?? ''),
        title: argPrompt,
        items: media,
        actions: mediaActions(
          media[0]?.kind,
          argPrompt,
          media.find((i) => i.kind === 'image')?.url
        ),
      });
    }
    for (const resource of extractMcpUiResources(result))
      out.push({ type: 'mcp_ui', resource, title: humanize(toolName.split('__')[1] ?? toolName) });
    if (out.length === 0 && result.structuredContent) {
      out.push(
        ...extractUiFromData(result.structuredContent, humanize(toolName.split('__')[0] ?? ''))
      );
    }
    return out.slice(0, MAX_UI_COMPONENTS_PER_TOOL);
  }

  // Web tools → record cards (title + snippet + link). This is what turns a
  // "list of links" answer into browsable cards.
  if (toolName === 'web_search' || toolName === 'web_research' || toolName === 'web_crawl') {
    const heading =
      toolName === 'web_search'
        ? 'Resultados de internet'
        : toolName === 'web_research'
          ? 'Fuentes consultadas'
          : 'Páginas rastreadas';
    const cards = extractUiFromData(result, 'Internet');
    for (const c of cards) if ('heading' in c && !c.heading) c.heading = heading;
    if (cards.length) return cards.slice(0, MAX_UI_COMPONENTS_PER_TOOL);
    return out;
  }
  if (toolName === 'fetch_url') {
    const cards = extractUiFromData(result, 'Internet');
    for (const c of cards) if ('heading' in c && !c.heading) c.heading = 'Página leída';
    if (cards.length) return cards.slice(0, MAX_UI_COMPONENTS_PER_TOOL);
    return out;
  }

  // Generic fallback: any other tool result with record/table-shaped data gets
  // cards too (ERP lookups, lists, KPIs). Defensive — non-shaped results just
  // render nothing. Browser/venue tools are excluded: their live surface is
  // the workspace panel, not chat cards.
  if (!toolName.startsWith('browser') && !toolName.startsWith('venue')) {
    out.push(...extractUiFromData(result, toolLabel(toolName)));
  }
  return out.slice(0, MAX_UI_COMPONENTS_PER_TOOL);
}

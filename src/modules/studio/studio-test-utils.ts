import { deflateSync } from 'zlib';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { StudioContent } from './studio-content';

/**
 * Fixtures shared by the studio unit tests: a sample document full of amounts,
 * a tiny valid PNG (no image library needed) and an in-memory Prisma stub.
 * Not a test file itself (no `.test.ts`), so vitest does not run it.
 */

export function makeActor(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u1',
    username: 'u1',
    name: 'Usuario Uno',
    email: null,
    mustChangePassword: false,
    roleKeys: ['ventas'],
    permissionKeys: ['studio.use'] as never,
    isSuperAdmin: false,
    ...overrides,
  };
}

/** Sample document: heading, KPIs, prose with figures, two amount tables, list, divider. */
export function sampleContent(imageObjectId?: string): StudioContent {
  const blocks: StudioContent['blocks'] = [
    { id: 'b_h1', type: 'heading', level: 1, text: 'Cierre de ventas septiembre 2026' },
    {
      id: 'b_kpi',
      type: 'kpi',
      cards: [
        { label: 'Ventas', value: '$1,234,567.89' },
        { label: 'Órdenes', value: '312' },
        { label: 'Ticket promedio', value: '$3,957.00' },
        { label: 'Margen', value: '18.5%' },
      ],
    },
    {
      id: 'b_p1',
      type: 'paragraph',
      text: 'Durante el mes se facturaron 312 órdenes por $1,234,567.89 MXN; el saldo pendiente es de $45,000.50 y el margen bruto fue de 18.5%.',
    },
    {
      id: 'b_t1',
      type: 'table',
      title: 'Ventas por sucursal',
      columns: [
        { key: 'branch', header: 'Sucursal' },
        { key: 'orders', header: 'Órdenes', format: 'number' },
        { key: 'total', header: 'Total', format: 'currency' },
        { key: 'balance', header: 'Saldo', format: 'currency' },
        { key: 'share', header: 'Participación', format: 'percentage' },
      ],
      rows: [
        { branch: 'Centro', orders: 120, total: 512300.5, balance: 12000, share: 41.5 },
        { branch: 'Norte', orders: 98, total: 402100.25, balance: '18,000.50', share: 32.6 },
        { branch: 'Sur', orders: 94, total: '320167.14', balance: 15000, share: 25.9 },
      ],
    },
    { id: 'b_h2', type: 'heading', level: 2, text: 'Cuentas por cobrar' },
    {
      id: 'b_t2',
      type: 'table',
      title: 'Saldos vencidos',
      columns: [
        { key: 'customer', header: 'Cliente' },
        { key: 'invoice', header: 'Factura' },
        { key: 'date', header: 'Vence', format: 'date' },
        { key: 'amount', header: 'Monto', format: 'currency' },
      ],
      rows: [
        {
          customer: 'Constructora Río Bravo, S.A.',
          invoice: 'F-10234',
          date: '2026-09-15',
          amount: 25000.5,
        },
        {
          customer: 'Pisos & Acabados "El Sol"',
          invoice: 'F-10241',
          date: '2026-09-20',
          amount: 20000,
        },
      ],
    },
    {
      id: 'b_list',
      type: 'list',
      ordered: true,
      items: [
        'Cobrar los $45,000.50 vencidos antes del día 30',
        'Revisar el margen de 18.5% en Sur',
      ],
    },
    { id: 'b_div', type: 'divider' },
  ];
  if (imageObjectId) {
    blocks.push({
      id: 'b_img',
      type: 'image',
      storageObjectId: imageObjectId,
      alt: 'Gráfica de ventas',
      caption: 'Ventas 2026',
    });
  }
  blocks.push({ id: 'b_pb', type: 'pageBreak' });
  blocks.push({ id: 'b_p2', type: 'paragraph', text: 'Anexo: metodología de cálculo.' });
  return { version: 1, blocks };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** A valid RGB PNG of the given size, filled with one color (decodable by pdfkit, docx, pptx). */
export function makeTestPng(
  width = 8,
  height = 6,
  rgb: [number, number, number] = [37, 99, 235]
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[rowStart + 1 + x * 3] = rgb[0];
      raw[rowStart + 2 + x * 3] = rgb[1];
      raw[rowStart + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// In-memory Prisma stub (only the surface the studio services use)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface Where {
  [key: string]: unknown;
}

function matchesWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Where[]).every((w) => matchesWhere(row, w))) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
      if ('not' in c && value === c.not) return false;
      if ('hasSome' in c) {
        const arr = Array.isArray(value) ? (value as unknown[]) : [];
        if (!(c.hasSome as unknown[]).some((v) => arr.includes(v))) return false;
      }
      if ('path' in c && 'array_contains' in c) {
        const path = c.path as string[];
        let target: unknown = value;
        for (const p of path) target = (target as Record<string, unknown> | undefined)?.[p];
        const needle = (c.array_contains as Row[])[0];
        const arr = Array.isArray(target) ? (target as Row[]) : [];
        if (!arr.some((item) => Object.entries(needle).every(([k, v]) => item[k] === v)))
          return false;
      }
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const orders = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<
    Record<string, 'asc' | 'desc'>
  >;
  if (orders.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      const [field, dir] = Object.entries(order)[0];
      const av = a[field] as number | string | Date;
      const bv = b[field] as number | string | Date;
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

export function createPrismaStub() {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}${++seq}`;
  const tables: Record<string, Map<string, Row>> = {
    studioDocument: new Map(),
    studioDocumentVersion: new Map(),
    studioTemplate: new Map(),
    studioExport: new Map(),
    aiProposal: new Map(),
    aiArtifact: new Map(),
    user: new Map(),
    auditLog: new Map(),
  };

  const withIncludes = (table: string, row: Row | null, include?: Record<string, unknown>) => {
    if (!row || !include) return row;
    const out = { ...row };
    if (include.document && (table === 'studioExport' || table === 'studioDocumentVersion')) {
      const doc = tables.studioDocument.get(row.documentId as string) ?? null;
      out.document = doc;
    }
    if (include.conversation && table === 'aiArtifact') {
      out.conversation = { userId: row.conversationUserId };
    }
    return out;
  };

  const model = (table: string, prefix: string) => ({
    async findUnique(args: { where: Where; include?: Record<string, unknown> }) {
      const row = [...tables[table].values()].find((r) => matchesWhere(r, args.where)) ?? null;
      return withIncludes(table, row, args.include);
    },
    async findFirst(args: { where?: Where; orderBy?: unknown; include?: Record<string, unknown> }) {
      const rows = sortRows(
        [...tables[table].values()].filter((r) => matchesWhere(r, args.where)),
        args.orderBy
      );
      return withIncludes(table, rows[0] ?? null, args.include);
    },
    async findMany(
      args: {
        where?: Where;
        orderBy?: unknown;
        take?: number;
        include?: Record<string, unknown>;
        select?: Record<string, unknown>;
      } = {}
    ) {
      let rows = sortRows(
        [...tables[table].values()].filter((r) => matchesWhere(r, args.where)),
        args.orderBy
      );
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((r) =>
        withIncludes(table, r, args.include ?? (args.select as Record<string, unknown>))
      );
    },
    async count(args: { where?: Where } = {}) {
      return [...tables[table].values()].filter((r) => matchesWhere(r, args.where)).length;
    },
    async create(args: { data: Row }) {
      const now = new Date();
      const row: Row = { id: nextId(prefix), createdAt: now, updatedAt: now, ...args.data };
      tables[table].set(row.id as string, row);
      return row;
    },
    async update(args: { where: Where; data: Row }) {
      const row = [...tables[table].values()].find((r) => matchesWhere(r, args.where));
      if (!row) throw new Error(`${table} not found`);
      const next = { ...row, ...args.data, updatedAt: new Date() };
      tables[table].set(row.id as string, next);
      return next;
    },
    async updateMany(args: { where: Where; data: Row }) {
      let count = 0;
      for (const row of tables[table].values()) {
        if (!matchesWhere(row, args.where)) continue;
        tables[table].set(row.id as string, { ...row, ...args.data, updatedAt: new Date() });
        count++;
      }
      return { count };
    },
  });

  const prisma = {
    studioDocument: model('studioDocument', 'doc'),
    studioDocumentVersion: model('studioDocumentVersion', 'ver'),
    studioTemplate: model('studioTemplate', 'tpl'),
    studioExport: model('studioExport', 'exp'),
    aiProposal: model('aiProposal', 'prop'),
    aiArtifact: model('aiArtifact', 'art'),
    user: model('user', 'user'),
    auditLog: model('auditLog', 'audit'),
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(prisma);
    },
  };
  return { prisma, tables, reset: () => Object.values(tables).forEach((t) => t.clear()) };
}

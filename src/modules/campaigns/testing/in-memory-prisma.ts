import { Prisma } from '@prisma/client';

/**
 * Minimal in-memory Prisma stand-in for unit tests (quotes + campaigns).
 * Supports the query shapes those services use: equality/`in`/`not`/range
 * filters, string `contains`, scalar-list `has*`, JSON `path`/`equals`,
 * `AND`/`OR`/`NOT`, orderBy, take/skip/cursor, select, groupBy, count,
 * upsert, createMany, atomic `increment` and `$transaction`.
 * Never used outside tests.
 */

export type Row = Record<string, unknown>;

let seq = 0;
export const nextId = (prefix = 'id'): string => `${prefix}${++seq}`;

function isDecimal(v: unknown): v is Prisma.Decimal {
  return v instanceof Prisma.Decimal;
}

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (isDecimal(a) || isDecimal(b))
    return new Prisma.Decimal(a as never).cmp(new Prisma.Decimal(b as never));
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (isDecimal(a) || isDecimal(b)) return cmp(a, b) === 0;
  return a === b;
}

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date || isDecimal(cond)) {
    return eq(value, cond);
  }
  const c = cond as Record<string, unknown>;
  if ('path' in c) {
    const path = c.path as string[];
    let cur: unknown = value;
    for (const key of path) cur = cur && typeof cur === 'object' ? (cur as Row)[key] : undefined;
    return 'equals' in c ? eq(cur, c.equals) : cur !== undefined;
  }
  for (const [op, expected] of Object.entries(c)) {
    switch (op) {
      case 'equals':
        if (!eq(value, expected)) return false;
        break;
      case 'not':
        if (matchField(value, expected)) return false;
        break;
      case 'in':
        if (!(expected as unknown[]).some((x) => eq(value, x))) return false;
        break;
      case 'notIn':
        if ((expected as unknown[]).some((x) => eq(value, x))) return false;
        break;
      case 'lt':
        if (!(cmp(value, expected) < 0)) return false;
        break;
      case 'lte':
        if (!(cmp(value, expected) <= 0)) return false;
        break;
      case 'gt':
        if (!(cmp(value, expected) > 0)) return false;
        break;
      case 'gte':
        if (!(cmp(value, expected) >= 0)) return false;
        break;
      case 'contains': {
        const a = String(value ?? '');
        const b = String(expected);
        const insensitive = c.mode === 'insensitive';
        if (!(insensitive ? a.toLowerCase().includes(b.toLowerCase()) : a.includes(b)))
          return false;
        break;
      }
      case 'startsWith':
        if (!String(value ?? '').startsWith(String(expected))) return false;
        break;
      case 'has':
        if (!Array.isArray(value) || !value.includes(expected)) return false;
        break;
      case 'hasSome':
        if (!Array.isArray(value) || !(expected as unknown[]).some((x) => value.includes(x)))
          return false;
        break;
      case 'hasEvery':
        if (!Array.isArray(value) || !(expected as unknown[]).every((x) => value.includes(x)))
          return false;
        break;
      case 'isEmpty':
        if ((Array.isArray(value) ? value.length === 0 : true) !== Boolean(expected)) return false;
        break;
      case 'mode':
        break;
      default:
        throw new Error(`in-memory-prisma: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'AND') {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w) => matches(row, w as Row))) return false;
    } else if (key === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
    } else if (key === 'NOT') {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w) => matches(row, w as Row))) return false;
    } else if (
      cond &&
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      !isDecimal(cond) &&
      !(key in row) &&
      Object.keys(cond as Row).every(
        (k) =>
          ![
            'equals',
            'not',
            'in',
            'notIn',
            'lt',
            'lte',
            'gt',
            'gte',
            'contains',
            'startsWith',
            'has',
            'hasSome',
            'hasEvery',
            'isEmpty',
            'mode',
            'path',
          ].includes(k)
      )
    ) {
      // Compound unique selector (e.g. `dimension_key_period_unit: {...}`)
      if (!matches(row, cond as Row)) return false;
    } else if (!matchField(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function applyOrder(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const list = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  return [...rows].sort((a, b) => {
    for (const spec of list) {
      const [field, dir] = Object.entries(spec)[0] ?? [];
      if (!field) continue;
      const r = cmp(a[field], b[field]);
      if (r !== 0) return dir === 'desc' ? -r : r;
    }
    return 0;
  });
}

function applyData(row: Row, data: Row): Row {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (
      value &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      !isDecimal(value) &&
      !Array.isArray(value)
    ) {
      const op = value as Row;
      if ('increment' in op) {
        const cur = next[key];
        next[key] =
          isDecimal(cur) || isDecimal(op.increment)
            ? new Prisma.Decimal((cur as never) ?? 0).plus(op.increment as never)
            : Number(cur ?? 0) + Number(op.increment);
        continue;
      }
      if ('decrement' in op) {
        next[key] = Number(next[key] ?? 0) - Number(op.decrement);
        continue;
      }
      if ('set' in op) {
        next[key] = op.set;
        continue;
      }
      if ('push' in op) {
        next[key] = [...((next[key] as unknown[]) ?? []), op.push];
        continue;
      }
    }
    next[key] = value;
  }
  next.updatedAt = new Date();
  return next;
}

function pick(row: Row, select?: Row): Row {
  if (!select) return row;
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

export interface TableOptions {
  idPrefix?: string;
  defaults?: () => Row;
  /** Unique field sets; createMany with skipDuplicates honours them. */
  uniques?: string[][];
}

export class Table {
  rows: Row[] = [];
  constructor(
    public readonly name: string,
    private readonly options: TableOptions = {}
  ) {}

  private conflict(row: Row): boolean {
    return (this.options.uniques ?? []).some((fields) =>
      this.rows.some((r) => fields.every((f) => eq(r[f], row[f])))
    );
  }

  private build(data: Row): Row {
    const now = new Date();
    return {
      id: nextId(this.options.idPrefix ?? this.name),
      createdAt: now,
      updatedAt: now,
      ...(this.options.defaults?.() ?? {}),
      ...data,
    };
  }

  async findUnique(args: { where: Row; select?: Row }) {
    const row = this.rows.find((r) => matches(r, args.where));
    return row ? pick(row, args.select) : null;
  }
  async findFirst(args: { where?: Row; orderBy?: unknown; select?: Row } = {}) {
    const row = applyOrder(
      this.rows.filter((r) => matches(r, args.where)),
      args.orderBy
    )[0];
    return row ? pick(row, args.select) : null;
  }
  async findMany(
    args: {
      where?: Row;
      orderBy?: unknown;
      take?: number;
      skip?: number;
      cursor?: Row;
      select?: Row;
      distinct?: string[];
    } = {}
  ) {
    let rows = applyOrder(
      this.rows.filter((r) => matches(r, args.where)),
      args.orderBy
    );
    if (args.cursor) {
      const idx = rows.findIndex((r) => matches(r, args.cursor));
      rows = idx >= 0 ? rows.slice(idx) : [];
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    if (args.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const key = args.distinct!.map((f) => String(r[f])).join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return rows.map((r) => pick(r, args.select));
  }
  async count(args: { where?: Row } = {}) {
    return this.rows.filter((r) => matches(r, args.where)).length;
  }
  async create(args: { data: Row; select?: Row }) {
    const row = this.build(args.data);
    if (this.conflict(row)) throw new Error(`Unique constraint failed on ${this.name}`);
    this.rows.push(row);
    return pick(row, args.select);
  }
  async createMany(args: { data: Row[]; skipDuplicates?: boolean }) {
    let count = 0;
    for (const data of args.data) {
      const row = this.build(data);
      if (this.conflict(row)) {
        if (args.skipDuplicates) continue;
        throw new Error(`Unique constraint failed on ${this.name}`);
      }
      this.rows.push(row);
      count++;
    }
    return { count };
  }
  async update(args: { where: Row; data: Row; select?: Row }) {
    const idx = this.rows.findIndex((r) => matches(r, args.where));
    if (idx < 0) throw new Error(`Record to update not found (${this.name})`);
    this.rows[idx] = applyData(this.rows[idx], args.data);
    return pick(this.rows[idx], args.select);
  }
  async updateMany(args: { where?: Row; data: Row }) {
    let count = 0;
    this.rows = this.rows.map((r) => {
      if (!matches(r, args.where)) return r;
      count++;
      return applyData(r, args.data);
    });
    return { count };
  }
  async upsert(args: { where: Row; create: Row; update: Row }) {
    const idx = this.rows.findIndex((r) => matches(r, args.where));
    if (idx >= 0) {
      this.rows[idx] = applyData(this.rows[idx], args.update);
      return this.rows[idx];
    }
    const row = this.build(args.create);
    this.rows.push(row);
    return row;
  }
  async delete(args: { where: Row }) {
    const idx = this.rows.findIndex((r) => matches(r, args.where));
    if (idx < 0) throw new Error(`Record to delete not found (${this.name})`);
    const [row] = this.rows.splice(idx, 1);
    return row;
  }
  async deleteMany(args: { where?: Row } = {}) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where));
    return { count: before - this.rows.length };
  }
  async groupBy(args: { by: string[]; where?: Row; _count?: Row; _sum?: Row }) {
    const groups = new Map<string, Row & { _count: Row; _sum: Row; _n: number }>();
    for (const row of this.rows.filter((r) => matches(r, args.where))) {
      const key = args.by.map((f) => String(row[f])).join('|');
      let g = groups.get(key);
      if (!g) {
        g = { _count: {}, _sum: {}, _n: 0 };
        for (const f of args.by) g[f] = row[f];
        groups.set(key, g);
      }
      g._n++;
      for (const f of Object.keys(args._sum ?? {})) {
        g._sum[f] = Number(g._sum[f] ?? 0) + Number(row[f] ?? 0);
      }
    }
    return [...groups.values()].map((g) => {
      const count: Row = {};
      for (const f of Object.keys(args._count ?? {})) count[f] = g._n;
      const { _n, ...rest } = g;
      void _n;
      return { ...rest, _count: count };
    });
  }
  async aggregate(args: { where?: Row; _sum?: Row; _count?: Row }) {
    const rows = this.rows.filter((r) => matches(r, args.where));
    const sum: Row = {};
    for (const f of Object.keys(args._sum ?? {})) {
      sum[f] = rows.reduce((acc, r) => acc + Number(r[f] ?? 0), 0);
    }
    return { _sum: sum, _count: { _all: rows.length } };
  }
}

export interface InMemoryPrisma {
  [model: string]: unknown;
  $transaction: (arg: unknown) => Promise<unknown>;
  $queryRaw: () => Promise<unknown[]>;
}

/** Builds a prisma-like object from table definitions. */
export function createInMemoryPrisma(tables: Record<string, TableOptions | undefined>): {
  prisma: InMemoryPrisma;
  tables: Record<string, Table>;
  reset(): void;
} {
  const created: Record<string, Table> = {};
  for (const [name, options] of Object.entries(tables)) created[name] = new Table(name, options);
  const prisma: InMemoryPrisma = {
    ...created,
    async $transaction(arg: unknown) {
      if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
      return Promise.all(arg as Promise<unknown>[]);
    },
    async $queryRaw() {
      return [];
    },
  };
  return {
    prisma,
    tables: created,
    reset() {
      for (const t of Object.values(created)) t.rows = [];
    },
  };
}

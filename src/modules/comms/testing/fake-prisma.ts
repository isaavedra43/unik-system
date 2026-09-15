/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '@prisma/client';

/**
 * Minimal in-memory Prisma stand-in for unit tests. Born for the
 * communications module and reusable by any service test:
 *
 * - Queries: equality, in/notIn/not, lt/lte/gt/gte, contains/startsWith/
 *   endsWith, has/hasSome/hasEvery, OR/AND/NOT, relation filters (`some`,
 *   `every`, `none`, nested object), include/select, orderBy (multi-key),
 *   take/skip/distinct, findUnique/findFirst (and their `OrThrow` variants),
 *   count, aggregate (`_count`/`_sum`/`_avg`/`_min`/`_max`) and a minimal
 *   groupBy (`by` + aggregates, orderBy, skip/take).
 * - Writes: create, createMany (`skipDuplicates`), createManyAndReturn,
 *   update, updateMany, upsert, delete, deleteMany. Updates accept plain
 *   values, `set` and numeric increment/decrement/multiply/divide (numbers
 *   and Prisma.Decimal).
 * - Uniqueness: the historical rules of CommMessage (accountId, externalId)
 *   and CommAccount (provider, identifier), row ids, and every field set the
 *   test declares in `uniques`; a violation throws P2002 like Prisma.
 * - Any model is reachable on the fly (`fake.client.anyModel`) with empty
 *   defaults; the constructor options add defaults, relations, compound keys
 *   and uniques on top of the built-in ones.
 * - `$queryRaw`/`$executeRaw` (and the `Unsafe` variants) reject with a clear
 *   error unless the test registers a handler with `fake.onRaw(fn)`.
 * - `$transaction` runs the callback (or the array) against this same client.
 *   It does NOT model PostgreSQL transactions: no isolation, no rollback when
 *   the callback throws, and no aborted state after a failed statement (in
 *   PostgreSQL every later statement fails with 25P02 and the commit rolls
 *   back). A test that catches P2002 inside `$transaction` and keeps writing
 *   passes here but fails in PostgreSQL; code that must survive a unique
 *   conflict inside a transaction has to avoid the error instead (e.g.
 *   `createManyAndReturn({ skipDuplicates: true })`, as `enqueueJob` does).
 */

export type Row = Record<string, any>;

export interface Relation {
  model: string;
  /** Foreign key on this model (belongs-to) ... */
  fk?: string;
  /** ...or on the child model (has-many). */
  childFk?: string;
}

export interface FakePrismaOptions {
  /** Default column values per model, merged over the built-in ones. */
  defaults?: Record<string, () => Row>;
  /** Relations per model, merged relation by relation with the built-in ones. */
  relations?: Record<string, Record<string, Relation>>;
  /** Compound unique selectors usable in `where` (e.g. `tenantId_code`). */
  compoundKeys?: Record<string, string[]>;
  /** Unique field sets per model. Multi-field sets also register their compound key. */
  uniques?: Record<string, string[][]>;
}

export type RawMethod = '$queryRaw' | '$executeRaw' | '$queryRawUnsafe' | '$executeRawUnsafe';

export interface RawQuery {
  method: RawMethod;
  /** SQL text with PostgreSQL placeholders ($1, $2, ...). */
  sql: string;
  values: unknown[];
}

export type RawHandler = (query: RawQuery) => unknown;

const RELATIONS: Record<string, Record<string, Relation>> = {
  commConversation: {
    account: { model: 'commAccount', fk: 'accountId' },
    contact: { model: 'commContact', fk: 'contactId' },
    messages: { model: 'commMessage', childFk: 'conversationId' },
    notes: { model: 'commNote', childFk: 'conversationId' },
  },
  commMessage: {
    account: { model: 'commAccount', fk: 'accountId' },
    conversation: { model: 'commConversation', fk: 'conversationId' },
  },
  consentRecord: { contact: { model: 'commContact', fk: 'contactId' } },
  user: { roles: { model: 'userRole', childFk: 'userId' } },
};

const COMPOUND_KEYS: Record<string, string[]> = {
  accountId_externalId: ['accountId', 'externalId'],
  provider_identifier: ['provider', 'identifier'],
};

const DEFAULTS: Record<string, () => Row> = {
  commAccount: () => ({
    connectionId: null,
    teamKeys: [],
    status: 'active',
    webhookSecret: null,
    config: null,
  }),
  commContact: () => ({
    phone: null,
    telegramId: null,
    email: null,
    zohoContactId: null,
    tags: [],
    duplicateOfId: null,
    duplicateReviewStatus: null,
  }),
  commConversation: () => ({
    status: 'open',
    assignedToUserId: null,
    subject: null,
    priority: 'normal',
    tags: [],
    unreadCount: 0,
    lastMessageAt: new Date(),
    lastInboundAt: null,
    snoozedUntil: null,
  }),
  commMessage: () => ({
    externalId: null,
    body: null,
    mediaObjectIds: [],
    status: 'received',
    error: null,
    sentByUserId: null,
    proposalId: null,
    campaignId: null,
    templateKey: null,
    providerMeta: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
  }),
  commNote: () => ({}),
  consentRecord: () => ({ note: null, recordedAt: new Date() }),
  responsible: () => ({ backupUserId: null, description: null, active: true }),
  commitment: () => ({
    contactId: null,
    sourceType: 'manual',
    sourceId: null,
    dueAt: null,
    status: 'pending',
    completedAt: null,
  }),
  user: () => ({ isActive: true, email: null }),
  storageObject: () => ({}),
  contact: () => ({}),
  extension: () => ({}),
  extensionConnection: () => ({}),
  auditLog: () => ({}),
  realtimeEvent: () => ({}),
};

interface UniqueRule {
  fields: string[];
  /** Whether the candidate row participates in the constraint at all. */
  applies: (row: Row) => boolean;
  same: (a: unknown, b: unknown) => boolean;
}

const strictSame = (a: unknown, b: unknown) => a === b;

/** Historical rules, kept with their exact semantics. */
const LEGACY_UNIQUES: Record<string, UniqueRule[]> = {
  commMessage: [
    {
      fields: ['accountId', 'externalId'],
      applies: (row) => Boolean(row.externalId),
      same: strictSame,
    },
  ],
  commAccount: [{ fields: ['provider', 'identifier'], applies: () => true, same: strictSame }],
};

const NUMERIC_OPS = ['increment', 'decrement', 'multiply', 'divide'] as const;
const AGGREGATE_OPS = ['_sum', '_avg', '_min', '_max'] as const;
const RAW_METHODS: RawMethod[] = [
  '$queryRaw',
  '$executeRaw',
  '$queryRawUnsafe',
  '$executeRawUnsafe',
];

/** Property names that must never become model delegates (thenables, inspectors...). */
const NOT_MODELS = new Set([
  'then',
  'catch',
  'finally',
  'constructor',
  'toJSON',
  'toString',
  'valueOf',
  'inspect',
  'asymmetricMatch',
  'nodeType',
  'tagName',
]);
const MODEL_NAME = /^[a-z][A-Za-z0-9]*$/;

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function isDecimal(value: unknown): value is Prisma.Decimal {
  return Prisma.Decimal.isDecimal(value);
}

function isPlain(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !Array.isArray(value) &&
    !isDecimal(value)
  );
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (isDecimal(a) || isDecimal(b)) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    try {
      return new Prisma.Decimal(a as Prisma.Decimal.Value).equals(b as Prisma.Decimal.Value);
    } catch {
      return false;
    }
  }
  return a === b;
}

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (isDecimal(value)) return value.toNumber();
  return value;
}

function cmp(a: unknown, b: unknown): number {
  const av = comparable(a) as number | string;
  const bv = comparable(b) as number | string;
  if (av === bv) return 0;
  if (av === null || av === undefined) return -1;
  if (bv === null || bv === undefined) return 1;
  return av < bv ? -1 : 1;
}

/** Accepts `'asc' | 'desc'` and Prisma's `{ sort, nulls }` form. */
function sortDirection(spec: unknown): 'asc' | 'desc' {
  if (isPlain(spec) && typeof spec.sort === 'string') return spec.sort === 'desc' ? 'desc' : 'asc';
  return spec === 'desc' ? 'desc' : 'asc';
}

function uniqueError(model: string, fields: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${fields.map((f) => `\`${f}\``).join(',')})`,
    { code: 'P2002', clientVersion: 'test', meta: { modelName: model, target: fields } }
  );
}

function notFoundError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record not found', {
    code: 'P2025',
    clientVersion: 'test',
  });
}

function applyNumericOp(current: unknown, op: Row): unknown {
  const name = NUMERIC_OPS.find((key) => key in op)!;
  const arg = op[name];
  if (isDecimal(current) || isDecimal(arg)) {
    const base = new Prisma.Decimal((current ?? 0) as Prisma.Decimal.Value);
    const by = arg as Prisma.Decimal.Value;
    if (name === 'increment') return base.plus(by);
    if (name === 'decrement') return base.minus(by);
    if (name === 'multiply') return base.times(by);
    return base.dividedBy(by);
  }
  const base = (current ?? 0) as number;
  if (name === 'increment') return base + arg;
  if (name === 'decrement') return base - arg;
  if (name === 'multiply') return base * arg;
  return base / arg;
}

/** `_count: true` → number; `_count: { _all, field }` → per-key counts (fields count non-null). */
function countOf(rows: Row[], spec: unknown): number | Row {
  if (!isPlain(spec)) return rows.length;
  const out: Row = {};
  for (const [field, on] of Object.entries(spec)) {
    if (!on) continue;
    out[field] =
      field === '_all'
        ? rows.length
        : rows.filter((r) => r[field] !== null && r[field] !== undefined).length;
  }
  return out;
}

function aggregateValues(op: (typeof AGGREGATE_OPS)[number], values: unknown[]): unknown {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return null;
  if (op === '_min' || op === '_max') {
    return present.reduce((best, v) => {
      const c = cmp(v, best);
      return (op === '_min' ? c < 0 : c > 0) ? v : best;
    });
  }
  if (present.some(isDecimal)) {
    const sum = present.reduce<Prisma.Decimal>(
      (acc, v) => acc.plus(v as Prisma.Decimal.Value),
      new Prisma.Decimal(0)
    );
    return op === '_sum' ? sum : sum.dividedBy(present.length);
  }
  const sum = present.reduce<number>((acc, v) => acc + Number(v), 0);
  return op === '_sum' ? sum : sum / present.length;
}

function isSqlObject(value: unknown): value is { text: string; values: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Row).strings) &&
    Array.isArray((value as Row).values)
  );
}

/** Normalizes tagged-template, `Prisma.sql` and `Unsafe(string, ...values)` calls. */
function toRawQuery(method: RawMethod, args: unknown[]): RawQuery {
  const [first, ...rest] = args;
  if (typeof first === 'string') return { method, sql: first, values: rest };
  if (isSqlObject(first)) return { method, sql: first.text, values: [...first.values] };
  if (Array.isArray(first)) {
    const sql = Prisma.sql(first as readonly string[], ...(rest as any[]));
    return { method, sql: sql.text, values: [...sql.values] };
  }
  return { method, sql: String(first), values: rest };
}

export class FakePrisma {
  readonly tables = new Map<string, Row[]>();
  private seq = 0;
  readonly client: Record<string, any>;
  private readonly defaults: Record<string, () => Row>;
  private readonly relations: Record<string, Record<string, Relation>>;
  private readonly compoundKeys: Record<string, string[]>;
  private readonly uniques: Record<string, UniqueRule[]> = {};
  private rawHandler: RawHandler | null = null;

  constructor(options: FakePrismaOptions = {}) {
    this.defaults = { ...DEFAULTS, ...options.defaults };

    this.relations = { ...RELATIONS };
    for (const [model, relations] of Object.entries(options.relations ?? {})) {
      this.relations[model] = { ...own(this.relations, model), ...relations };
    }

    const declaredKeys: Record<string, string[]> = {};
    for (const [model, rules] of Object.entries(LEGACY_UNIQUES)) this.uniques[model] = [...rules];
    for (const [model, sets] of Object.entries(options.uniques ?? {})) {
      for (const set of sets) {
        const fields = [...set];
        if (fields.length === 0) continue;
        (this.uniques[model] ??= []).push({
          fields,
          // SQL semantics: a NULL in any column never collides.
          applies: (row) => fields.every((f) => row[f] !== null && row[f] !== undefined),
          same: eq,
        });
        if (fields.length > 1) declaredKeys[fields.join('_')] = fields;
      }
    }
    this.compoundKeys = { ...COMPOUND_KEYS, ...declaredKeys, ...options.compoundKeys };

    const target: Record<string, any> = {};
    const declaredModels = new Set([
      ...Object.keys(this.defaults),
      ...Object.keys(this.relations),
      ...Object.keys(this.uniques),
    ]);
    for (const model of declaredModels) target[model] = this.delegate(model);
    target.$transaction = async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(this.client);
    for (const method of RAW_METHODS) {
      target[method] = (...args: unknown[]) => this.runRaw(method, args);
    }

    // Undeclared models are created on first access, with empty defaults.
    this.client = new Proxy(target, {
      get: (obj, prop, receiver) => {
        if (
          typeof prop === 'string' &&
          !(prop in obj) &&
          MODEL_NAME.test(prop) &&
          !NOT_MODELS.has(prop)
        ) {
          obj[prop] = this.delegate(prop);
        }
        return Reflect.get(obj, prop, receiver);
      },
    });
  }

  /** Registers (or clears with `null`) the handler for `$queryRaw`/`$executeRaw` calls. */
  onRaw(handler: RawHandler | null): this {
    this.rawHandler = handler;
    return this;
  }

  seed(model: string, row: Row): Row {
    const full = this.newRow(model, row);
    this.rows(model).push(full);
    return full;
  }

  rows(model: string): Row[] {
    if (!this.tables.has(model)) this.tables.set(model, []);
    return this.tables.get(model)!;
  }

  private async runRaw(method: RawMethod, args: unknown[]): Promise<unknown> {
    const query = toRawQuery(method, args);
    if (!this.rawHandler) {
      throw new Error(
        `FakePrisma: ${method} no se ejecuta en memoria; registra un manejador con fake.onRaw(fn) en la prueba. SQL: ${query.sql}`
      );
    }
    return this.rawHandler(query);
  }

  private newRow(model: string, data: Row | undefined): Row {
    return {
      id: `${model}_${++this.seq}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...this.defaults[model]?.(),
      ...data,
    };
  }

  private relation(model: string, name: string): Relation | undefined {
    const relations = own(this.relations, model);
    return relations ? own(relations, name) : undefined;
  }

  private related(model: string, row: Row, name: string): Row | Row[] | null {
    const rel = this.relation(model, name);
    if (!rel) return null;
    if (rel.fk) return this.rows(rel.model).find((r) => r.id === row[rel.fk!]) ?? null;
    return this.rows(rel.model).filter((r) => r[rel.childFk!] === row.id);
  }

  private matchField(model: string, row: Row, key: string, cond: unknown): boolean {
    const rel = this.relation(model, key);
    if (rel && isPlain(cond)) {
      const related = this.related(model, row, key);
      if (Array.isArray(related)) {
        if ('some' in cond) return related.some((r) => this.matches(rel.model, r, cond.some));
        if ('every' in cond) return related.every((r) => this.matches(rel.model, r, cond.every));
        if ('none' in cond) return !related.some((r) => this.matches(rel.model, r, cond.none));
        return false;
      }
      if (!related) return false;
      return this.matches(rel.model, related, cond);
    }
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (!isPlain(cond)) return eq(value, cond);
    const insensitive = cond.mode === 'insensitive';
    const str = (v: unknown) => (insensitive ? String(v ?? '').toLowerCase() : String(v ?? ''));
    for (const [op, arg] of Object.entries(cond)) {
      switch (op) {
        case 'mode':
          break;
        case 'equals':
          if (!eq(value, arg)) return false;
          break;
        case 'in':
          if (!(arg as unknown[]).some((x) => eq(x, value))) return false;
          break;
        case 'notIn':
          if ((arg as unknown[]).some((x) => eq(x, value))) return false;
          break;
        case 'not':
          if (isPlain(arg)) {
            if (this.matchField(model, row, key, arg)) return false;
          } else if (eq(value, arg)) return false;
          break;
        case 'lt':
          if (value === null || value === undefined || cmp(value, arg) >= 0) return false;
          break;
        case 'lte':
          if (value === null || value === undefined || cmp(value, arg) > 0) return false;
          break;
        case 'gt':
          if (value === null || value === undefined || cmp(value, arg) <= 0) return false;
          break;
        case 'gte':
          if (value === null || value === undefined || cmp(value, arg) < 0) return false;
          break;
        case 'contains':
          if (value === null || value === undefined || !str(value).includes(str(arg))) return false;
          break;
        case 'startsWith':
          if (!str(value).startsWith(str(arg))) return false;
          break;
        case 'endsWith':
          if (!str(value).endsWith(str(arg))) return false;
          break;
        case 'has':
          if (!Array.isArray(value) || !value.includes(arg)) return false;
          break;
        case 'hasSome':
          if (!Array.isArray(value) || !(arg as unknown[]).some((x) => value.includes(x)))
            return false;
          break;
        case 'hasEvery':
          if (!Array.isArray(value) || !(arg as unknown[]).every((x) => value.includes(x)))
            return false;
          break;
        default:
          throw new Error(`FakePrisma: operador no soportado ${op}`);
      }
    }
    return true;
  }

  matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      const compound = own(this.compoundKeys, key);
      if (key === 'OR') {
        if (!(cond as Row[]).some((c) => this.matches(model, row, c))) return false;
      } else if (key === 'AND') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((c) => this.matches(model, row, c))) return false;
      } else if (key === 'NOT') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((c) => this.matches(model, row, c))) return false;
      } else if (compound) {
        for (const field of compound) if (!eq(row[field], (cond as Row)[field])) return false;
      } else if (!this.matchField(model, row, key, cond)) return false;
    }
    return true;
  }

  private sort(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [key, dir] of keys) {
        const c = cmp(a[key], b[key]);
        if (c !== 0) return sortDirection(dir) === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  private project(model: string, row: Row, args: { select?: Row; include?: Row }): Row {
    const out: Row = { ...row };
    const include = args.include ?? {};
    for (const [name, spec] of Object.entries(include)) {
      if (!spec) continue;
      const related = this.related(model, row, name);
      const rel = this.relation(model, name);
      if (Array.isArray(related) && rel)
        out[name] = related.map((r) => this.project(rel.model, r, isPlain(spec) ? spec : {}));
      else if (related && rel)
        out[name] = this.project(rel.model, related as Row, isPlain(spec) ? spec : {});
      else out[name] = related;
    }
    if (args.select) {
      const picked: Row = {};
      for (const [name, spec] of Object.entries(args.select)) {
        if (!spec) continue;
        const rel = this.relation(model, name);
        if (rel) {
          const related = this.related(model, row, name);
          if (Array.isArray(related))
            picked[name] = related.map((r) =>
              this.project(rel.model, r, isPlain(spec) ? spec : {})
            );
          else
            picked[name] = related
              ? this.project(rel.model, related, isPlain(spec) ? spec : {})
              : null;
        } else picked[name] = out[name];
      }
      return picked;
    }
    return out;
  }

  private applyUpdate(row: Row, data: Row | undefined): void {
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value === undefined) continue;
      if (isPlain(value) && NUMERIC_OPS.some((op) => op in value))
        row[key] = applyNumericOp(row[key], value);
      else if (isPlain(value) && 'set' in value && Object.keys(value).length === 1)
        row[key] = value.set;
      else row[key] = value;
    }
    row.updatedAt = new Date();
  }

  /**
   * Returns the violated field set, or null. `pool` is the table as it would
   * look after the write; `touched` limits an update to the sets it writes.
   */
  private uniqueConflict(
    model: string,
    row: Row,
    pool: Row[],
    ignoreId?: string,
    touched?: Set<string>
  ): string[] | null {
    const others = pool.filter((r) => r !== row && (ignoreId === undefined || r.id !== ignoreId));
    const rules: UniqueRule[] = [
      { fields: ['id'], applies: (r) => r.id !== null && r.id !== undefined, same: eq },
      ...(own(this.uniques, model) ?? []),
    ];
    for (const rule of rules) {
      if (touched && !rule.fields.some((f) => touched.has(f))) continue;
      if (!rule.applies(row)) continue;
      if (others.some((other) => rule.fields.every((f) => rule.same(other[f], row[f]))))
        return rule.fields;
    }
    return null;
  }

  private assertUnique(
    model: string,
    row: Row,
    options: { pool?: Row[]; ignoreId?: string; touched?: Set<string> } = {}
  ): void {
    const conflict = this.uniqueConflict(
      model,
      row,
      options.pool ?? this.rows(model),
      options.ignoreId,
      options.touched
    );
    if (conflict) throw uniqueError(model, conflict);
  }

  /** Applies `data` to every target atomically: all rows change or none does. */
  private updateRows(model: string, targets: Row[], data: Row | undefined): void {
    if (targets.length === 0) return;
    const touched = new Set(
      Object.entries(data ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
    );
    const nexts = targets.map((row) => {
      const next = { ...row };
      this.applyUpdate(next, data);
      return next;
    });
    const replaced = new Map(targets.map((row, i) => [row, nexts[i]]));
    const pool = this.rows(model).map((row) => replaced.get(row) ?? row);
    for (const next of nexts) this.assertUnique(model, next, { pool, touched });
    targets.forEach((row, i) => Object.assign(row, nexts[i]));
  }

  /** createMany semantics: one atomic insert; duplicates are skipped or abort the batch. */
  private insertMany(model: string, args: Row): Row[] {
    const list: Row[] = Array.isArray(args.data) ? args.data : args.data ? [args.data] : [];
    const accepted: Row[] = [];
    for (const data of list) {
      const row = this.newRow(model, data);
      const conflict = this.uniqueConflict(model, row, [...this.rows(model), ...accepted]);
      if (conflict) {
        if (args.skipDuplicates) continue;
        throw uniqueError(model, conflict);
      }
      accepted.push(row);
    }
    this.rows(model).push(...accepted);
    return accepted;
  }

  /** Filter + sort + distinct + skip/take, without projection. */
  private query(model: string, args: Row = {}): Row[] {
    let rows = this.rows(model).filter((r) => this.matches(model, r, args.where));
    rows = this.sort(rows, args.orderBy);
    if (args.distinct) {
      const fields: string[] = Array.isArray(args.distinct) ? args.distinct : [args.distinct];
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const key = fields.map((k) => String(r[k])).join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows;
  }

  private aggregate(rows: Row[], args: Row): Row {
    const out: Row = {};
    if (args._count) out._count = countOf(rows, args._count);
    for (const op of AGGREGATE_OPS) {
      if (!isPlain(args[op])) continue;
      const values: Row = {};
      for (const [field, on] of Object.entries(args[op])) {
        if (on)
          values[field] = aggregateValues(
            op,
            rows.map((r) => r[field])
          );
      }
      out[op] = values;
    }
    return out;
  }

  private groupBy(model: string, args: Row): Row[] {
    if (args.having) throw new Error('FakePrisma: groupBy con having no está soportado');
    const by: string[] = Array.isArray(args.by) ? args.by : [args.by];
    const groups = new Map<string, Row[]>();
    for (const row of this.rows(model).filter((r) => this.matches(model, r, args.where))) {
      const key = JSON.stringify(by.map((f) => comparable(row[f]) ?? null));
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    let result = [...groups.values()].map((list) => ({
      ...Object.fromEntries(by.map((f) => [f, list[0][f] ?? null])),
      ...this.aggregate(list, args),
    }));
    if (args.orderBy) {
      const keys = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy])
        .flatMap((o: Row) => Object.entries(o))
        .flatMap(([key, spec]: [string, unknown]) =>
          key.startsWith('_') && isPlain(spec)
            ? Object.entries(spec).map(([field, dir]) => ({
                get: (g: Row) => g[key]?.[field],
                dir: sortDirection(dir),
              }))
            : [{ get: (g: Row) => g[key], dir: sortDirection(spec) }]
        );
      result = [...result].sort((a, b) => {
        for (const k of keys) {
          const c = cmp(k.get(a), k.get(b));
          if (c !== 0) return k.dir === 'desc' ? -c : c;
        }
        return 0;
      });
    }
    if (args.skip) result = result.slice(args.skip);
    if (args.take !== undefined) result = result.slice(0, args.take);
    return result;
  }

  private delegate(model: string) {
    const find = (args: Row = {}) =>
      this.query(model, args).map((r) => this.project(model, r, args));
    const findOrThrow = (args: Row = {}) => {
      const row = find({ ...args, take: 1 })[0];
      if (!row) throw notFoundError();
      return row;
    };
    return {
      findMany: async (args: Row = {}) => find(args),
      findFirst: async (args: Row = {}) => find({ ...args, take: 1 })[0] ?? null,
      findUnique: async (args: Row) => find({ ...args, take: 1 })[0] ?? null,
      findFirstOrThrow: async (args: Row = {}) => findOrThrow(args),
      findUniqueOrThrow: async (args: Row) => findOrThrow(args),
      count: async (args: Row = {}) => {
        const rows = this.rows(model).filter((r) => this.matches(model, r, args.where));
        return isPlain(args.select) ? countOf(rows, args.select) : rows.length;
      },
      aggregate: async (args: Row = {}) => this.aggregate(this.query(model, args), args),
      groupBy: async (args: Row) => this.groupBy(model, args),
      create: async (args: Row) => {
        const row = this.newRow(model, args.data);
        this.assertUnique(model, row);
        this.rows(model).push(row);
        return this.project(model, row, args);
      },
      createMany: async (args: Row = {}) => ({ count: this.insertMany(model, args).length }),
      createManyAndReturn: async (args: Row = {}) =>
        this.insertMany(model, args).map((r) => this.project(model, r, args)),
      update: async (args: Row) => {
        const row = this.rows(model).find((r) => this.matches(model, r, args.where));
        if (!row) throw notFoundError();
        const next = { ...row };
        this.applyUpdate(next, args.data);
        this.assertUnique(model, next, { ignoreId: row.id });
        Object.assign(row, next);
        return this.project(model, row, args);
      },
      updateMany: async (args: Row) => {
        const rows = this.rows(model).filter((r) => this.matches(model, r, args.where));
        this.updateRows(model, rows, args.data);
        return { count: rows.length };
      },
      upsert: async (args: Row) => {
        const row = this.rows(model).find((r) => this.matches(model, r, args.where));
        if (row) {
          this.updateRows(model, [row], args.update);
          return this.project(model, row, args);
        }
        const created = this.newRow(model, args.create);
        this.assertUnique(model, created);
        this.rows(model).push(created);
        return this.project(model, created, args);
      },
      delete: async (args: Row) => {
        const idx = this.rows(model).findIndex((r) => this.matches(model, r, args.where));
        if (idx < 0) throw notFoundError();
        return this.rows(model).splice(idx, 1)[0];
      },
      deleteMany: async (args: Row = {}) => {
        const before = this.rows(model).length;
        this.tables.set(
          model,
          this.rows(model).filter((r) => !this.matches(model, r, args.where))
        );
        return { count: before - this.rows(model).length };
      },
    };
  }
}

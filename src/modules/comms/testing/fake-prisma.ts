/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '@prisma/client';

/**
 * Minimal in-memory Prisma stand-in for unit tests of the communications
 * module. Supports the subset of the query API the services use: equality,
 * in/notIn/not, lt/lte/gt/gte, contains/startsWith/endsWith, has/hasSome,
 * OR/AND/NOT, relation filters (`some`, nested object), include/select,
 * orderBy (multi-key), take/skip/distinct, increment updates, upsert,
 * and the unique constraint on CommMessage (accountId, externalId).
 */

export type Row = Record<string, any>;

interface Relation {
  model: string;
  /** Foreign key on this model (belongs-to) ... */
  fk?: string;
  /** ...or on the child model (has-many). */
  childFk?: string;
}

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

function isPlain(value: unknown): value is Row {
  return (
    typeof value === 'object' && value !== null && !(value instanceof Date) && !Array.isArray(value)
  );
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function cmp(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number | string);
  const bv = b instanceof Date ? b.getTime() : (b as number | string);
  if (av === bv) return 0;
  if (av === null || av === undefined) return -1;
  if (bv === null || bv === undefined) return 1;
  return av < bv ? -1 : 1;
}

export class FakePrisma {
  readonly tables = new Map<string, Row[]>();
  private seq = 0;
  readonly client: Record<string, any> = {};

  constructor() {
    for (const model of Object.keys(DEFAULTS)) this.client[model] = this.delegate(model);
    this.client.$transaction = async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(this.client);
  }

  seed(model: string, row: Row): Row {
    const full = {
      id: `${model}_${++this.seq}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...DEFAULTS[model]?.(),
      ...row,
    };
    this.rows(model).push(full);
    return full;
  }

  rows(model: string): Row[] {
    if (!this.tables.has(model)) this.tables.set(model, []);
    return this.tables.get(model)!;
  }

  private related(model: string, row: Row, name: string): Row | Row[] | null {
    const rel = RELATIONS[model]?.[name];
    if (!rel) return null;
    if (rel.fk) return this.rows(rel.model).find((r) => r.id === row[rel.fk!]) ?? null;
    return this.rows(rel.model).filter((r) => r[rel.childFk!] === row.id);
  }

  private matchField(model: string, row: Row, key: string, cond: unknown): boolean {
    const rel = RELATIONS[model]?.[key];
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
      if (key === 'OR') {
        if (!(cond as Row[]).some((c) => this.matches(model, row, c))) return false;
      } else if (key === 'AND') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((c) => this.matches(model, row, c))) return false;
      } else if (key === 'NOT') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((c) => this.matches(model, row, c))) return false;
      } else if (COMPOUND_KEYS[key]) {
        for (const field of COMPOUND_KEYS[key])
          if (!eq(row[field], (cond as Row)[field])) return false;
      } else if (!this.matchField(model, row, key, cond)) return false;
    }
    return true;
  }

  private sort(model: string, rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [key, dir] of keys) {
        const c = cmp(a[key], b[key]);
        if (c !== 0) return dir === 'desc' ? -c : c;
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
      const rel = RELATIONS[model]?.[name];
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
        const rel = RELATIONS[model]?.[name];
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

  private applyUpdate(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (isPlain(value) && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
      else if (isPlain(value) && 'decrement' in value) row[key] = (row[key] ?? 0) - value.decrement;
      else if (isPlain(value) && 'set' in value && Object.keys(value).length === 1)
        row[key] = value.set;
      else row[key] = value;
    }
    row.updatedAt = new Date();
  }

  private assertUnique(model: string, row: Row, ignoreId?: string): void {
    if (model === 'commMessage' && row.externalId) {
      const dup = this.rows(model).find(
        (r) => r.id !== ignoreId && r.accountId === row.accountId && r.externalId === row.externalId
      );
      if (dup)
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
    }
    if (model === 'commAccount') {
      const dup = this.rows(model).find(
        (r) => r.id !== ignoreId && r.provider === row.provider && r.identifier === row.identifier
      );
      if (dup)
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
    }
  }

  private delegate(model: string) {
    const find = (args: Row = {}) => {
      let rows = this.rows(model).filter((r) => this.matches(model, r, args.where));
      rows = this.sort(model, rows, args.orderBy);
      if (args.distinct) {
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const key = (args.distinct as string[]).map((k) => String(r[k])).join('|');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (args.skip) rows = rows.slice(args.skip);
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return rows.map((r) => this.project(model, r, args));
    };
    return {
      findMany: async (args: Row = {}) => find(args),
      findFirst: async (args: Row = {}) => find({ ...args, take: 1 })[0] ?? null,
      findUnique: async (args: Row) => find({ ...args, take: 1 })[0] ?? null,
      count: async (args: Row = {}) =>
        this.rows(model).filter((r) => this.matches(model, r, args.where)).length,
      create: async (args: Row) => {
        const row = {
          id: `${model}_${++this.seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...DEFAULTS[model]?.(),
          ...args.data,
        };
        this.assertUnique(model, row);
        this.rows(model).push(row);
        return this.project(model, row, args);
      },
      update: async (args: Row) => {
        const row = this.rows(model).find((r) => this.matches(model, r, args.where));
        if (!row)
          throw new Prisma.PrismaClientKnownRequestError('Record not found', {
            code: 'P2025',
            clientVersion: 'test',
          });
        const next = { ...row };
        this.applyUpdate(next, args.data);
        this.assertUnique(model, next, row.id);
        Object.assign(row, next);
        return this.project(model, row, args);
      },
      updateMany: async (args: Row) => {
        const rows = this.rows(model).filter((r) => this.matches(model, r, args.where));
        for (const row of rows) this.applyUpdate(row, args.data);
        return { count: rows.length };
      },
      upsert: async (args: Row) => {
        const row = this.rows(model).find((r) => this.matches(model, r, args.where));
        if (row) {
          this.applyUpdate(row, args.update);
          return this.project(model, row, args);
        }
        const created = {
          id: `${model}_${++this.seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...DEFAULTS[model]?.(),
          ...args.create,
        };
        this.rows(model).push(created);
        return this.project(model, created, args);
      },
      delete: async (args: Row) => {
        const idx = this.rows(model).findIndex((r) => this.matches(model, r, args.where));
        if (idx < 0)
          throw new Prisma.PrismaClientKnownRequestError('Record not found', {
            code: 'P2025',
            clientVersion: 'test',
          });
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

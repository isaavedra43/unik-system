import { Prisma } from '@prisma/client';
import type { CurrentUser } from '@/modules/auth/authorization';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import {
  FakePrisma,
  type FakePrismaOptions,
  type RawQuery,
  type Relation,
  type Row,
} from '@/modules/comms/testing/fake-prisma';
import { AREA_KEYS, AREA_LABELS, type AreaKey } from '../types';

/**
 * Test fixtures shared by every operational module (operations, inventory,
 * logistics, purchases, manufacturing, finance, CRM).
 *
 * `createOpsFake()` returns a `FakePrisma` configured with the defaults,
 * relations and unique keys (simple and compound) of the core models as they
 * are in prisma/schema.prisma, plus an in-memory emulation of the atomic
 * `Sequence` upsert used by `sequence-service.ts`.
 *
 * Import it from `vi.hoisted` so the fake exists before `vi.mock('@/lib/prisma')`:
 *
 *   const { fake } = await vi.hoisted(async () => {
 *     const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
 *     return { fake: createOpsFake() };
 *   });
 *   vi.mock('@/lib/prisma', () => ({ prisma: fake.client }));
 *
 * This file only imports pure modules (no `@/lib/prisma`), so it is safe there.
 * To add raw SQL emulation use `addRawHandler(fake, fn)` instead of
 * `fake.onRaw(fn)` (which would replace the Sequence emulation).
 */

export const RAW_NOT_HANDLED: unique symbol = Symbol('ops-raw-not-handled');
export type OpsRawHandler = (query: RawQuery, fake: FakePrisma) => unknown;

const rawHandlers = new WeakMap<FakePrisma, OpsRawHandler[]>();

/** Adds a raw SQL handler; return `RAW_NOT_HANDLED` to let the next one try. Newer handlers run first. */
export function addRawHandler(fake: FakePrisma, handler: OpsRawHandler): void {
  const list = rawHandlers.get(fake);
  if (!list) throw new Error('addRawHandler: the fake was not created with createOpsFake()');
  list.unshift(handler);
}

/** Emulates `INSERT INTO "Sequence" … ON CONFLICT DO UPDATE … RETURNING next - 1`. */
function sequenceUpsertHandler(query: RawQuery, fake: FakePrisma): unknown {
  if (!/INSERT INTO "Sequence"/.test(query.sql)) return RAW_NOT_HANDLED;
  const key = String(query.values[0]);
  const rows = fake.rows('sequence');
  const row = rows.find((r) => r.key === key);
  if (!row) {
    rows.push({ key, next: 2, updatedAt: new Date() });
    return [{ value: 1 }];
  }
  row.next = Number(row.next) + 1;
  row.updatedAt = new Date();
  return [{ value: row.next - 1 }];
}

/** Emulates `SELECT "id" FROM "OperationalCase" WHERE "id" = … FOR UPDATE` (no real lock in memory). */
function caseLockHandler(query: RawQuery, fake: FakePrisma): unknown {
  if (!/FROM "OperationalCase"[\s\S]*FOR UPDATE/.test(query.sql)) return RAW_NOT_HANDLED;
  const id = String(query.values[0]);
  return fake
    .rows('operationalCase')
    .filter((row) => row.id === id)
    .map((row) => ({ id: row.id }));
}

const advisoryLocks = new WeakMap<FakePrisma, Array<{ key: string; mode: 'exclusive' | 'shared' }>>();

/**
 * Emulates `SELECT pg_advisory_xact_lock[_shared](hashtext($1))` (no real lock
 * in memory) and records each acquisition so tests can assert which keys a
 * command serialized on (`advisoryLocksOf(fake)`).
 */
function advisoryLockHandler(query: RawQuery, fake: FakePrisma): unknown {
  const match = /pg_advisory_xact_lock(_shared)?\s*\(/.exec(query.sql);
  if (!match) return RAW_NOT_HANDLED;
  const list = advisoryLocks.get(fake) ?? [];
  list.push({ key: String(query.values[0]), mode: match[1] ? 'shared' : 'exclusive' });
  advisoryLocks.set(fake, list);
  return 1;
}

/** Advisory lock acquisitions recorded by the fake (oldest first). Pass `clear` to reset the log. */
export function advisoryLocksOf(
  fake: FakePrisma,
  options: { clear?: boolean } = {}
): Array<{ key: string; mode: 'exclusive' | 'shared' }> {
  const list = [...(advisoryLocks.get(fake) ?? [])];
  if (options.clear) advisoryLocks.set(fake, []);
  return list;
}

const decimalZero = () => new Prisma.Decimal(0);

function coreDefaults(counters: { event: number; realtime: number }): Record<string, () => Row> {
  return {
    area: () => ({ leadUserId: null, chatChannelId: null, sortOrder: 0, active: true }),
    operationalCase: () => ({
      zohoSalesOrderId: null,
      salesOrderNumber: null,
      customerName: null,
      zohoCustomerId: null,
      salespersonName: null,
      locationId: null,
      locationName: null,
      deliveryMethod: null,
      orderDate: null,
      status: 'open',
      phase: 'planning',
      priority: 'normal',
      promisedAt: null,
      openedAt: new Date(),
      closedAt: null,
      cancelledAt: null,
      closeReason: null,
      lastActivityAt: new Date(),
      chatChannelId: null,
      aiSummary: null,
      aiSummaryEventId: null,
      version: 1,
    }),
    caseDemand: () => ({
      zohoItemId: null,
      sku: null,
      variantKey: '',
      variantJson: null,
      locationId: null,
      requestedAt: null,
      status: 'pending',
      fulfilledQuantity: decimalZero(),
      sortOrder: 0,
      version: 1,
    }),
    demandAllocation: () => ({
      status: 'planned',
      warehouseId: null,
      stockReservationId: null,
      linkedType: null,
      linkedId: null,
      expectedAt: null,
      readyAt: null,
      deliveredQuantity: decimalZero(),
      version: 1,
    }),
    processVersion: () => ({ active: true }),
    caseStep: () => ({
      scope: 'case',
      scopeKey: '',
      demandId: null,
      allocationId: null,
      status: 'pending',
      dependsOn: [],
      slaMinutes: 0,
      dueAt: null,
      startedAt: null,
      completedAt: null,
      exitEvidence: null,
      version: 1,
    }),
    workItem: () => ({
      caseId: null,
      stepId: null,
      description: null,
      status: 'open',
      backupUserId: null,
      escalationLevel: 0,
      escalatedAt: null,
      waitReason: null,
      waitUntil: null,
      objectType: null,
      objectId: null,
      requiredEvidence: [],
      result: null,
      completedBy: null,
      completedAt: null,
      version: 1,
    }),
    areaRequest: () => ({
      freeText: null,
      priority: 'normal',
      status: 'sent',
      blocksDelivery: false,
      backupUserId: null,
      workItemId: null,
      createdById: null,
      chatMessageId: null,
      answer: null,
      answeredAt: null,
      closedAt: null,
      version: 1,
    }),
    incident: () => ({
      caseId: null,
      severity: 'medium',
      status: 'open',
      detail: {},
      ownerUserId: null,
      openedAt: new Date(),
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      version: 1,
    }),
    operationalEvent: () => ({
      id: BigInt(++counters.event),
      occurredAt: new Date(),
      recordedAt: new Date(),
      caseId: null,
      areaKey: null,
      actorId: null,
      commandId: null,
      objectType: null,
      objectId: null,
      payload: {},
    }),
    operationalCommand: () => ({
      expectedVersion: null,
      deviceId: null,
      status: 'accepted',
      result: null,
      errorCode: null,
      receivedAt: new Date(),
      completedAt: null,
    }),
    evidenceLink: () => ({
      caseId: null,
      workItemId: null,
      stepId: null,
      storageObjectId: null,
      note: null,
    }),
    objectRelation: () => ({ validFrom: new Date(), validTo: null }),
    sequence: () => ({ next: 1 }),
    approvalPolicy: () => ({
      categoryId: null,
      minAmount: decimalZero(),
      maxAmount: null,
      currency: 'MXN',
      requiredApprovals: 1,
      approverRoleKeys: [],
      active: true,
    }),
    approvalRequest: () => ({
      currency: 'MXN',
      policyId: null,
      status: 'pending',
      decisions: [],
      expiresAt: null,
      decidedAt: null,
      caseId: null,
      areaKey: null,
      version: 1,
    }),
    agentIdentity: () => ({
      areaKey: null,
      mode: 'active',
      dailyTokenBudget: 150000,
      monthlyCostBudgetUsd: new Prisma.Decimal(40),
      maxTurnsPerCasePerDay: 4,
      quietHours: null,
    }),
    integrationConfig: () => ({ isEnabled: true }),
    user: () => ({
      email: null,
      isActive: true,
      isBot: false,
      botKind: null,
      mustChangePassword: false,
      failedLoginAttempts: 0,
    }),
    role: () => ({ description: null, isSystem: false, isActive: true }),
    userRole: () => ({ assignedAt: new Date() }),
    rolePermission: () => ({}),
    responsible: () => ({ backupUserId: null, description: null, active: true }),
    backgroundJob: () => ({
      status: 'pending',
      priority: 100,
      attempts: 0,
      maxAttempts: 3,
      dedupeKey: null,
      groupKey: null,
      createdBy: null,
      runAt: new Date(),
    }),
    notification: () => ({ readAt: null, pushStatus: 'pending', dedupeKey: null }),
    auditLog: () => ({}),
    realtimeEvent: () => ({ id: BigInt(++counters.realtime) }),
    internalChatMember: () => ({
      role: 'member',
      joinedAt: new Date(),
      lastReadAt: new Date(),
      mutedUntil: null,
      leftAt: null,
    }),
  };
}

const CORE_RELATIONS: Record<string, Record<string, Relation>> = {
  user: { roles: { model: 'userRole', childFk: 'userId' } },
  userRole: {
    user: { model: 'user', fk: 'userId' },
    role: { model: 'role', fk: 'roleId' },
  },
  role: {
    users: { model: 'userRole', childFk: 'roleId' },
    permissions: { model: 'rolePermission', childFk: 'roleId' },
  },
  rolePermission: { role: { model: 'role', fk: 'roleId' } },
  operationalCase: {
    demands: { model: 'caseDemand', childFk: 'caseId' },
    steps: { model: 'caseStep', childFk: 'caseId' },
  },
  caseDemand: {
    case: { model: 'operationalCase', fk: 'caseId' },
    allocations: { model: 'demandAllocation', childFk: 'demandId' },
  },
  demandAllocation: { demand: { model: 'caseDemand', fk: 'demandId' } },
  caseStep: { case: { model: 'operationalCase', fk: 'caseId' } },
};

const CORE_UNIQUES: Record<string, string[][]> = {
  area: [['key'], ['chatChannelId']],
  operationalCase: [
    ['caseSeq'],
    ['caseNumber'],
    ['kind', 'sourceType', 'sourceId'],
    ['chatChannelId'],
  ],
  caseDemand: [['caseId', 'lineRef']],
  processVersion: [['processKey', 'version']],
  caseStep: [['caseId', 'stepKey', 'scopeKey']],
  incident: [['dedupeKey']],
  objectRelation: [['fromType', 'fromId', 'toType', 'toId', 'relation']],
  sequence: [['key']],
  agentIdentity: [['key'], ['areaKey'], ['botUserId']],
  integrationConfig: [['source']],
  user: [['username'], ['email']],
  role: [['key']],
  userRole: [['userId', 'roleId']],
  rolePermission: [['roleId', 'permissionKey']],
  responsible: [['area']],
  backgroundJob: [['dedupeKey']],
  notification: [['dedupeKey']],
  internalChatMember: [['channelId', 'userId']],
};

/** FakePrisma with the operations core schema; `options` add or override per model. */
export function createOpsFake(options: FakePrismaOptions = {}): FakePrisma {
  const counters = { event: 0, realtime: 0 };
  const relations: Record<string, Record<string, Relation>> = { ...CORE_RELATIONS };
  for (const [model, rels] of Object.entries(options.relations ?? {})) {
    relations[model] = { ...relations[model], ...rels };
  }
  const uniques: Record<string, string[][]> = { ...CORE_UNIQUES };
  for (const [model, sets] of Object.entries(options.uniques ?? {})) {
    uniques[model] = [...(uniques[model] ?? []), ...sets];
  }
  const fake = new FakePrisma({
    defaults: { ...coreDefaults(counters), ...options.defaults },
    relations,
    uniques,
    compoundKeys: options.compoundKeys,
  });
  const handlers: OpsRawHandler[] = [caseLockHandler, sequenceUpsertHandler, advisoryLockHandler];
  rawHandlers.set(fake, handlers);
  fake.onRaw((query) => {
    for (const handler of handlers) {
      const result = handler(query, fake);
      if (result !== RAW_NOT_HANDLED) return result;
    }
    throw new Error(`createOpsFake: SQL sin manejador (usa addRawHandler): ${query.sql}`);
  });
  return fake;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/** Pure CurrentUser for tests that do not need the user rows. */
export function makeCurrentUser(overrides: Partial<CurrentUser> & { id: string }): CurrentUser {
  return {
    username: overrides.id,
    name: overrides.id,
    email: null,
    mustChangePassword: false,
    roleKeys: [],
    permissionKeys: [],
    isSuperAdmin: false,
    ...overrides,
  };
}

/** Creates (or returns) a role with the given permissions. */
export function seedRole(
  fake: FakePrisma,
  key: string,
  permissions: string[] = [],
  overrides: Row = {}
): Row {
  let role = fake.rows('role').find((r) => r.key === key);
  if (!role) role = fake.seed('role', { id: `role_${key}`, key, name: key, ...overrides });
  for (const permissionKey of permissions) {
    const exists = fake
      .rows('rolePermission')
      .some((p) => p.roleId === role!.id && p.permissionKey === permissionKey);
    if (!exists) fake.seed('rolePermission', { roleId: role.id, permissionKey });
  }
  return role;
}

export interface SeedUserInput {
  id?: string;
  name?: string;
  username?: string;
  email?: string | null;
  isActive?: boolean;
  isBot?: boolean;
  /** Existing or new roles assigned to the user. */
  roleKeys?: string[];
  /** Granted through a personal role `perm_<userId>`. */
  permissions?: string[];
  superAdmin?: boolean;
  createdAt?: Date;
}

/** Seeds a user with roles/permissions and returns the row plus the matching CurrentUser. */
export function seedUser(
  fake: FakePrisma,
  input: SeedUserInput = {}
): { user: Row; currentUser: CurrentUser } {
  const id = input.id ?? `user_${fake.rows('user').length + 1}`;
  const user = fake.seed('user', {
    id,
    username: input.username ?? id,
    name: input.name ?? id,
    email: input.email ?? null,
    passwordHash: 'x',
    isActive: input.isActive ?? true,
    isBot: input.isBot ?? false,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
  const roleKeys = [...(input.roleKeys ?? [])];
  if (input.superAdmin) roleKeys.push(SUPER_ADMIN_ROLE_KEY);
  if (input.permissions && input.permissions.length > 0) {
    const personal = `perm_${id}`;
    seedRole(fake, personal, input.permissions);
    roleKeys.push(personal);
  }
  for (const key of roleKeys) {
    const role = seedRole(fake, key);
    fake.seed('userRole', { userId: id, roleId: role.id });
  }
  const roles = fake.rows('role').filter((r) => roleKeys.includes(r.key) && r.isActive);
  const permissionKeys = [
    ...new Set(
      fake
        .rows('rolePermission')
        .filter((p) => roles.some((r) => r.id === p.roleId))
        .map((p) => p.permissionKey as string)
    ),
  ];
  return {
    user,
    currentUser: {
      id,
      username: user.username,
      name: user.name,
      email: user.email,
      mustChangePassword: false,
      roleKeys: roles.map((r) => r.key),
      permissionKeys,
      isSuperAdmin: roleKeys.includes(SUPER_ADMIN_ROLE_KEY),
    },
  };
}

/** Seeds one area with the same key as its `Responsible.area` slug. */
export function seedArea(fake: FakePrisma, key: AreaKey, overrides: Row = {}): Row {
  return fake.seed('area', {
    id: `area_${key}`,
    key,
    label: AREA_LABELS[key],
    responsibleArea: key,
    sortOrder: AREA_KEYS.indexOf(key),
    ...overrides,
  });
}

export function seedAreas(fake: FakePrisma, keys: readonly AreaKey[] = AREA_KEYS): Row[] {
  return keys.map((key) => seedArea(fake, key));
}

export function seedResponsible(
  fake: FakePrisma,
  input: {
    area: string;
    userId: string;
    backupUserId?: string | null;
    label?: string;
    active?: boolean;
  }
): Row {
  return fake.seed('responsible', {
    area: input.area,
    label: input.label ?? input.area,
    userId: input.userId,
    backupUserId: input.backupUserId ?? null,
    active: input.active ?? true,
  });
}

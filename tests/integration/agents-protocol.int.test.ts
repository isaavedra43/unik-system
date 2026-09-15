import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Protocol of the coordinated AI layer (plan 5.1–5.8) end to end against a REAL
 * PostgreSQL database with every migration applied, through the ONE existing AI
 * pipeline (runAssistant, registry, AiProposal, chat, notifications, jobs).
 *
 * - Runs only when UNIK_INTEGRATION_DATABASE_URL is set (`npm run test:integration`).
 * - The database must be local and disposable (same guard as the operations suite):
 *   the suite truncates the operations, chat and AI tables it uses.
 * - No real AI provider and no network: `chatCompletionStream` is a SCRIPTED
 *   provider that answers by trigger (`⟦auto:unblock⟧`, `⟦auto:mention⟧`) and records
 *   every call (tool choice, offered tools, actor); `chatCompletion` fails loudly if
 *   anything tries to use it. Web push is mocked. Everything else is real: the
 *   dispatcher listeners after each commit, the job handlers (drained here with the
 *   worker's semantics), identities, chat rooms, proposals, budgets and meters.
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;
if (!integrationUrl) {
  console.warn(
    '[integration] Se omite el protocolo de agentes: define UNIK_INTEGRATION_DATABASE_URL con una base ' +
      'PostgreSQL local y desechable con todas las migraciones aplicadas (por ejemplo unik_schema_check).'
  );
}

interface ScriptedCall {
  trigger: string | null;
  toolChoice: unknown;
  toolNames: string[];
  userId: string | undefined;
  conversationId: string | undefined;
  /** The call comes after tool results (not the first call of the turn). */
  afterTools: boolean;
}

const ai = vi.hoisted(() => ({
  calls: [] as ScriptedCall[],
  /** Request the scripted `unblock` turn proposes to accept. */
  requestId: null as string | null,
  mentionReply: 'Tienes una solicitud abierta de Inventario por el faltante; la reviso con Compras hoy.',
  utilityCalls: 0,
}));

const mocks = vi.hoisted(() => ({
  sendPushToUser: vi.fn(async () => ({ sent: 0, failed: 0, removed: 0, skipped: true })),
}));

vi.mock('@/modules/ai/ai-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ai/ai-client')>();
  const usage = { promptTokens: 1200, completionTokens: 80, totalTokens: 1280 };
  type ScriptMessage = { role: string; content: unknown };
  const textOf = (message: ScriptMessage | undefined): string =>
    typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? (message.content as Array<{ type?: string; text?: string }>)
            .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
            .join('\n')
        : '';
  return {
    ...actual,
    chatCompletion: vi.fn(async () => {
      ai.utilityCalls += 1;
      throw new Error('Proveedor guionizado: chatCompletion no está permitido en esta prueba');
    }),
    chatCompletionStream: vi.fn(async function* (opts: {
      messages: ScriptMessage[];
      tools?: Array<{ function: { name: string } }>;
      toolChoice?: unknown;
      userId?: string;
      conversationId?: string;
    }) {
      const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
      const trigger = /⟦auto:([a-z_]+)/.exec(textOf(lastUser))?.[1] ?? null;
      const afterTools = opts.messages[opts.messages.length - 1]?.role === 'tool';
      ai.calls.push({
        trigger,
        toolChoice: opts.toolChoice,
        toolNames: (opts.tools ?? []).map((t) => t.function.name),
        userId: opts.userId,
        conversationId: opts.conversationId,
        afterTools,
      });
      if (afterTools) {
        yield { delta: 'Listo.' };
        yield { finishReason: 'stop', usage };
        return;
      }
      const call = (name: string, args: Record<string, unknown>) => ({
        id: `call_${ai.calls.length}_${name}`,
        name,
        arguments: JSON.stringify(args),
      });
      const toolCalls =
        trigger === 'unblock' && ai.requestId
          ? [
              call('respondAreaRequest', {
                requestId: ai.requestId,
                action: 'accept',
                note: 'Compras atiende el faltante hoy.',
              }),
              call('concludeAgentTurn', {
                outcome: 'needs_human',
                message: 'Propuse aceptar la solicitud; decide la persona responsable de Compras.',
              }),
            ]
          : trigger === 'mention'
            ? [call('concludeAgentTurn', { outcome: 'acted', message: ai.mentionReply })]
            : [call('concludeAgentTurn', { outcome: 'no_action' })];
      yield { toolCalls };
      yield { finishReason: 'tool_calls', usage };
    }),
  };
});
vi.mock('@/modules/notifications/push-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/notifications/push-service')>()),
  sendPushToUser: mocks.sendPushToUser,
}));

import { prisma } from '@/lib/prisma';
import '@/modules/operations/register-commands';
// Registers agents.dispatch and subscribes the dispatcher (events, new cases, @mentions), like the app.
import { runDispatchJob } from '@/modules/agents/agents-jobs';
import { AI_USAGE_UNITS, recordAgentUsage } from '@/modules/agents/budget';
import { ensureAreaChannel } from '@/modules/agents/chat-bridge';
import { buildBotActor, ensureAgentIdentities } from '@/modules/agents/identities';
import { AGENT_TOOL_ALLOWLIST } from '@/modules/agents/tool-allowlist';
import { listAiConfig, updateAiConfig } from '@/modules/ai/ai-admin-config-service';
import { loadActiveCurrentUser, type CurrentUser } from '@/modules/auth/authorization';
import { sendMessage } from '@/modules/chat/chat-service';
import { approveProposal } from '@/modules/extensions/proposals-service';
import { ensureGeneralLocation } from '@/modules/inventory/warehouses-service';
import { enqueueJob, JOB_PRIORITY, type JobContext } from '@/modules/jobs/job-queue';
import {
  AREA_REQUEST_AUTO_ACK_JOB,
  runAreaRequestAutoAckJob,
} from '@/modules/operations/area-requests-service';
import {
  runCaseAdvanceJob,
  runCaseReplanJob,
  runCaseStartJob,
} from '@/modules/operations/case-jobs';
import type { CommandResult } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { clearProcessBlueprintCache } from '@/modules/operations/process-blueprints/registry';
import { CASE_JOB_TYPES, caseStartDedupeKey } from '@/modules/operations/sales-order-hooks';
import { ensureOperationsSeed } from '@/modules/operations/seed';
import { runSupervisorTick } from '@/modules/operations/supervisor';
import { AREA_KEYS, AREA_LABELS, type AreaKey } from '@/modules/operations/types';
import { completeWorkItem } from '@/modules/operations/work-items-service';

// ---------------------------------------------------------------------------
// Safety and cleanup
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_NAME = /(check|test|integration|scratch|ci)/i;

async function assertDisposableDatabase(): Promise<void> {
  if (process.env.DATABASE_URL !== integrationUrl) {
    throw new Error(
      '[integration] DATABASE_URL no coincide con UNIK_INTEGRATION_DATABASE_URL; ejecuta con `npm run test:integration`'
    );
  }
  const url = new URL(integrationUrl);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`[integration] Sólo se permite una base local (host recibido: ${url.hostname})`);
  }
  const [{ name }] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  const allowed = process.env.UNIK_INTEGRATION_ALLOW_DATABASE?.trim();
  if (name === 'unik_system' || (!DISPOSABLE_NAME.test(name) && allowed !== name)) {
    throw new Error(
      `[integration] La base "${name}" no parece desechable. Usa una base de prueba (p. ej. unik_schema_check) ` +
        'o confírmala con UNIK_INTEGRATION_ALLOW_DATABASE=<nombre>.'
    );
  }
  const [{ ready }] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT to_regclass('"OperationalCase"') IS NOT NULL
       AND to_regclass('"AgentIdentity"') IS NOT NULL
       AND to_regclass('internal_chat_channel') IS NOT NULL AS ready`;
  if (!ready) {
    throw new Error(
      `[integration] La base "${name}" no tiene las migraciones de operaciones y agentes; aplica \`prisma migrate deploy\` a esa base desechable`
    );
  }
}

/** Operations, agents, chat and AI tables this suite writes (disposable database only). */
const RESET_TABLES = [
  'Area',
  'OperationalCase',
  'CaseDemand',
  'DemandAllocation',
  'ProcessVersion',
  'CaseStep',
  'WorkItem',
  'AreaRequest',
  'Incident',
  'OperationalEvent',
  'OperationalCommand',
  'EvidenceLink',
  'ObjectRelation',
  'Sequence',
  'ApprovalPolicy',
  'ApprovalRequest',
  'AgentIdentity',
  'Warehouse',
  'StorageLocation',
  'ProductInventoryProfile',
  'StockItem',
  'StockMovement',
  'StockReservation',
  'StockCount',
  'StockCountLine',
  'LegacyCommitmentClaim',
  'DeliveryOrder',
  'BackgroundJob',
  'Notification',
  'AuditLog',
  'RealtimeEvent',
  'UsageMeter',
  'EntityChangeEvent',
  'UserNotificationSettings',
  // Internal chat models are mapped to snake_case tables (@@map).
  'internal_chat_channel',
  'internal_chat_member',
  'internal_chat_message',
  'internal_chat_mention',
  'internal_chat_read_receipt',
  'internal_chat_presence',
  'internal_chat_notification_preference',
  'internal_chat_thread',
  'AiConversation',
  'AiMessage',
  'AiToolCall',
  'AiApiCall',
  'AiProposal',
  'AiConfig',
  'AiUserPreference',
  'AiMemory',
];

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${RESET_TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`
  );
  await prisma.$executeRaw`DELETE FROM "SalesOrder" WHERE left("zohoSalesOrderId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "Product" WHERE left("zohoItemId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "Responsible" WHERE left("userId", 3) = 'it_'`;
  await prisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "isBot" = true OR left("id", 3) = 'it_')`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE "isBot" = true OR left("id", 3) = 'it_'`;
  await prisma.$executeRaw`DELETE FROM "Role" WHERE left("key", 3) = 'it_' OR left("key", 6) = 'agent_'`;
  await prisma.$executeRaw`DELETE FROM "IntegrationConfig" WHERE "source" = 'operations'`;
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

const CUTOVER = '2026-01-01T00:00:00.000Z';
const ZOHO_LOCATION = 'it-loc-agents';
const OPEN_WORK = ['open', 'in_progress', 'waiting', 'escalated'];
const VIEW = ['operations.view', 'chat.use', 'assistant.use'];
const INVENTORY = ['inventory.view', 'inventory.count', 'inventory.adjust', 'inventory.reserve'];

interface Team {
  byArea: Record<AreaKey, CurrentUser>;
  inventoryBackup: CurrentUser;
  purchasesBackup: CurrentUser;
  /** Receives the budget notices (operations.admin through a role). */
  manager: CurrentUser;
}

let team: Team;
let warehouseId = '';
let generalLocationId = '';
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

async function seedUser(id: string, name: string, permissions: string[]): Promise<CurrentUser> {
  await prisma.user.create({
    data: { id, username: id, name, passwordHash: 'integration', mustChangePassword: false },
  });
  const role = await prisma.role.create({ data: { key: `${id}_permisos`, name: `Permisos ${name}` } });
  await prisma.rolePermission.createMany({
    data: permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
  });
  await prisma.userRole.create({ data: { userId: id, roleId: role.id } });
  const user = await loadActiveCurrentUser(id);
  if (!user) throw new Error(`No se pudo cargar al usuario ${id}`);
  return user;
}

const AREA_PERMISSIONS: Record<AreaKey, string[]> = {
  ventas: [...VIEW, 'inventory.view', 'logistics.view'],
  compras: VIEW,
  inventario: [...VIEW, ...INVENTORY],
  manufactura: VIEW,
  logistica: [...VIEW, 'logistics.view'],
  contabilidad: VIEW,
  administracion: VIEW,
};

/** Agents on from minute one with no quiet window (start = end), so the suite never depends on the clock. */
async function configureAi(): Promise<void> {
  await listAiConfig();
  await updateAiConfig({
    isEnabled: true,
    settings: {
      provider: 'openai',
      deployment: 'gpt-4o-mini',
      fallbackDeployment: 'gpt-4o-mini',
      routingStandardModel: 'gpt-4o-mini',
      utilityModel: 'gpt-4o-mini',
      qualityJudgeEnabled: false,
      learningCaptureEnabled: false,
      agents: {
        enabled: true,
        quietHours: { start: '00:00', end: '00:00', tz: 'America/Mexico_City' },
        maxTurnsPerCasePerDay: 4,
        maxIterationsPerAutoTurn: 4,
        degradeAtPct: 80,
        alertAdminAtPct: 80,
      },
    },
  });
}

async function seedBase(): Promise<void> {
  const byArea = {} as Record<AreaKey, CurrentUser>;
  for (const area of AREA_KEYS) {
    byArea[area] = await seedUser(`it_${area}`, `Responsable ${AREA_LABELS[area]}`, AREA_PERMISSIONS[area]);
  }
  const inventoryBackup = await seedUser('it_inventario_suplente', 'Suplente Inventario', [...VIEW, ...INVENTORY]);
  const purchasesBackup = await seedUser('it_compras_suplente', 'Suplente Compras', VIEW);
  const manager = await seedUser('it_direccion', 'Dirección de operaciones', [
    ...VIEW,
    'operations.manage',
    'operations.admin',
  ]);
  for (const area of AREA_KEYS) {
    await prisma.responsible.create({
      data: {
        area,
        label: AREA_LABELS[area],
        userId: `it_${area}`,
        backupUserId:
          area === 'inventario' ? inventoryBackup.id : area === 'compras' ? purchasesBackup.id : null,
      },
    });
  }
  await prisma.integrationConfig.create({
    data: { source: 'operations', displayName: 'Operaciones', isEnabled: true, settings: { cutoverDate: CUTOVER } },
  });
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
  await ensureOperationsSeed();
  const summary = await ensureAgentIdentities();
  expect(summary.conflicts).toEqual([]);
  await configureAi();

  const warehouse = await prisma.warehouse.create({
    data: { key: 'it-agentes', name: 'Bodega agentes', zohoLocationId: ZOHO_LOCATION },
  });
  warehouseId = warehouse.id;
  generalLocationId = (await ensureGeneralLocation(prisma, warehouse.id)).id;
  team = { byArea, inventoryBackup, purchasesBackup, manager };
}

async function seedControlledStock(zohoItemId: string, quantity: number): Promise<void> {
  const now = new Date();
  await prisma.product.create({
    data: {
      zohoItemId,
      name: 'Loseta Perla',
      sku: zohoItemId.toUpperCase(),
      unit: 'pz',
      status: 'active',
      sourceRemoteModifiedAt: now,
      sourceSnapshotId: 'it-snapshot',
    },
  });
  await prisma.productInventoryProfile.create({
    data: {
      zohoItemId,
      baseUnit: 'pz',
      tolerancePct: 2,
      confidence: 'CONTROLLED',
      consecutiveGoodCounts: 2,
      lastCountAt: now,
      controlledAt: now,
    },
  });
  await prisma.stockItem.create({
    data: {
      zohoItemId,
      warehouseId,
      locationId: generalLocationId,
      baseline: quantity,
      knownQty: quantity,
      lastCountedAt: now,
    },
  });
}

async function seedSalesOrder(zohoItemId: string, quantity: number) {
  const zohoSalesOrderId = nextId('it-so-agentes');
  await prisma.salesOrder.create({
    data: {
      zohoSalesOrderId,
      salesOrderNumber: `SO-${zohoSalesOrderId.toUpperCase()}`,
      status: 'confirmed',
      shippedStatus: 'pending',
      invoicedStatus: 'not_invoiced',
      paidStatus: 'unpaid',
      createdTime: new Date(Date.now() - 60 * 60_000),
      orderDate: new Date(new Date().toISOString().slice(0, 10)),
      locationId: ZOHO_LOCATION,
      locationName: 'Bodega agentes',
      customerName: 'Constructora Agentes',
      deliveryMethod: 'Entrega a domicilio',
      shippingAttention: 'Juan Pérez',
      shippingAddressLine1: 'Av. Reforma 100',
      shippingCity: 'Monterrey',
      shippingState: 'NL',
      shippingPostalCode: '64000',
      shippingPhone: '8110000000',
      sourceRemoteModifiedAt: new Date(),
      sourceSnapshotId: `${zohoSalesOrderId}-snapshot`,
      items: {
        create: [
          {
            zohoLineItemId: `${zohoSalesOrderId}-li-1`,
            zohoItemId,
            sku: zohoItemId.toUpperCase(),
            name: 'Loseta Perla',
            quantity,
            unit: 'pz',
            locationId: ZOHO_LOCATION,
            sortOrder: 1,
          },
        ],
      },
    },
  });
  return { zohoSalesOrderId };
}

// ---------------------------------------------------------------------------
// Jobs: drained with the semantics of the worker (job-queue.ts runJob)
// ---------------------------------------------------------------------------

type Handler = (job: JobContext<unknown>) => Promise<unknown>;

const JOB_HANDLERS: Record<string, Handler> = {
  [CASE_JOB_TYPES.start]: runCaseStartJob,
  [CASE_JOB_TYPES.replan]: runCaseReplanJob,
  [CASE_JOB_TYPES.advance]: runCaseAdvanceJob,
  [AREA_REQUEST_AUTO_ACK_JOB]: runAreaRequestAutoAckJob,
  'agents.dispatch': runDispatchJob,
};

interface JobRun {
  type: string;
  outcome: 'completed' | 'retry' | 'failed';
  result?: unknown;
  error?: string;
}

const toJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined || value === null
    ? Prisma.JsonNull
    : JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

async function drainJobs(maxRuns = 80): Promise<JobRun[]> {
  const runs: JobRun[] = [];
  for (let i = 0; i < maxRuns; i++) {
    const job = await prisma.backgroundJob.findFirst({
      where: { status: 'pending', type: { in: Object.keys(JOB_HANDLERS) } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    if (!job) return runs;
    const attempt = job.attempts + 1;
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: 'running', attempts: attempt, lockedAt: new Date(), lockedBy: 'integration' },
    });
    const context: JobContext<unknown> = {
      id: job.id,
      type: job.type,
      payload: job.payload,
      attempt,
      signal: new AbortController().signal,
      async setProgress() {},
      log() {},
    };
    try {
      const result = await JOB_HANDLERS[job.type](context);
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          progress: 100,
          result: toJson(result),
          lockedAt: null,
          lockedBy: null,
          dedupeKey: null,
        },
      });
      runs.push({ type: job.type, outcome: 'completed', result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = attempt >= job.maxAttempts;
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: exhausted
          ? { status: 'failed', lastError: message.slice(0, 2000), completedAt: new Date(), lockedAt: null, lockedBy: null, dedupeKey: null }
          : { status: 'pending', lastError: message.slice(0, 2000), lockedAt: null, lockedBy: null },
      });
      runs.push({ type: job.type, outcome: exhausted ? 'failed' : 'retry', error: message });
    }
  }
  throw new Error(`drainJobs: más de ${maxRuns} ejecuciones; ¿un job se re-encola sin fin?`);
}

async function drainAll(): Promise<JobRun[]> {
  const runs = await drainJobs();
  expect(runs.filter((run) => run.outcome !== 'completed')).toEqual([]);
  return runs;
}

/** Decisions reported by the `agents.dispatch` jobs of a drain. */
function dispatchDecisions(runs: JobRun[]): Array<{ trigger: string; agent: string; mode: string; outcome: string; reason: string | null }> {
  return runs
    .filter((run) => run.type === 'agents.dispatch')
    .flatMap((run) => ((run.result as { decisions?: unknown[] } | undefined)?.decisions ?? []) as never[]);
}

// ---------------------------------------------------------------------------
// Flows and reads
// ---------------------------------------------------------------------------

function expectCompleted(result: Pick<CommandResult, 'status' | 'errorCode' | 'message'>): void {
  if (result.status !== 'completed') {
    throw new Error(`Se esperaba completed y llegó ${result.status} (${result.errorCode ?? ''}: ${result.message ?? ''})`);
  }
}

async function openWorkItemOfStep(caseId: string, stepKey: string, scopeKey: string) {
  const step = await prisma.caseStep.findFirstOrThrow({ where: { caseId, stepKey, scopeKey } });
  return prisma.workItem.findFirstOrThrow({ where: { stepId: step.id, status: { in: OPEN_WORK } } });
}

const metaOf = (message: { meta: Prisma.JsonValue | null } | null | undefined): Record<string, unknown> =>
  message?.meta && typeof message.meta === 'object' && !Array.isArray(message.meta)
    ? (message.meta as Record<string, unknown>)
    : {};

const payloadOf = (event: { payload: Prisma.JsonValue }): Record<string, unknown> =>
  event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};

async function botUserId(username: string): Promise<string> {
  return (await prisma.user.findUniqueOrThrow({ where: { username } })).id;
}

async function activeMembers(channelId: string): Promise<Array<{ userId: string; username: string; isBot: boolean }>> {
  const rows = await prisma.internalChatMember.findMany({
    where: { channelId, leftAt: null },
    include: { user: { select: { username: true, isBot: true } } },
  });
  return rows.map((row) => ({ userId: row.userId, username: row.user.username, isBot: row.user.isBot }));
}

async function channelMessages(channelId: string) {
  return prisma.internalChatMessage.findMany({ where: { channelId }, orderBy: { createdAt: 'asc' } });
}

/** A sales order opens its case through the start job (the dispatcher reacts after the commit). */
async function startCase(quantity = 10, stock = 6) {
  const zohoItemId = nextId('it-item-loseta');
  await seedControlledStock(zohoItemId, stock);
  const order = await seedSalesOrder(zohoItemId, quantity);
  await enqueueJob({
    type: CASE_JOB_TYPES.start,
    payload: { zohoSalesOrderId: order.zohoSalesOrderId },
    dedupeKey: caseStartDedupeKey(order.zohoSalesOrderId),
    priority: JOB_PRIORITY.interactive,
    maxAttempts: 3,
  });
  const runs = await drainAll();
  const opCase = await prisma.operationalCase.findFirstOrThrow({
    where: { sourceType: 'sales_order', sourceId: order.zohoSalesOrderId },
  });
  return { opCase, runs };
}

/**
 * Inventario counts 6 of 10 and Ventas accepts "6 from stock + 4 to buy": the engine confirms the
 * shortfall and asks Compras. Returns the case (with its room) and the purchase request.
 */
async function startShortfallCase() {
  const { opCase } = await startCase(10, 6);
  const [demand] = await prisma.caseDemand.findMany({ where: { caseId: opCase.id } });
  const verify = await openWorkItemOfStep(opCase.id, 'verificar_disponibilidad', demand.id);
  expectCompleted(
    await completeWorkItem(team.byArea.inventario, verify.id, { result: { availability_result: { counted: 6 } } })
  );
  const plan = await openWorkItemOfStep(opCase.id, 'plan_abastecimiento', demand.id);
  expectCompleted(
    await completeWorkItem(team.byArea.ventas, plan.id, { result: { allocation_plan: { acceptProposal: true } } })
  );
  const runs = await drainAll();
  const request = await prisma.areaRequest.findFirstOrThrow({
    where: { caseId: opCase.id, kind: 'purchase_shortfall' },
  });
  const refreshed = await prisma.operationalCase.findUniqueOrThrow({ where: { id: opCase.id } });
  return { opCase: refreshed, demandId: demand.id, request, runs };
}

/** The purchase request goes overdue; the supervisor flags it and the dispatcher runs the turn. */
async function overdueTurn() {
  const flow = await startShortfallCase();
  ai.calls.length = 0;
  ai.utilityCalls = 0;
  ai.requestId = flow.request.id;
  await prisma.areaRequest.update({
    where: { id: flow.request.id },
    data: { dueAt: new Date(Date.now() - 30 * 60_000) },
  });
  await runSupervisorTick();
  const runs = await drainAll();
  return { ...flow, runs };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describeDb('protocolo de la IA coordinada contra PostgreSQL real', () => {
  beforeAll(async () => {
    if (!process.env.UNIK_INTEGRATION_VERBOSE) {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
    }
    await assertDisposableDatabase();
    await resetDatabase();
  });

  afterAll(async () => {
    const scope = globalThis as typeof globalThis & { __unikAgentsDispatcherUnsubscribe?: Array<() => void> };
    for (const unsubscribe of scope.__unikAgentsDispatcherUnsubscribe ?? []) unsubscribe();
    try {
      await resetDatabase();
    } finally {
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    ai.calls.length = 0;
    ai.requestId = null;
    ai.utilityCalls = 0;
    await resetDatabase();
    await seedBase();
  });

  it('case.started: la sala del expediente nace con bots y responsables de las áreas involucradas, sin modelo e idempotente', async () => {
    const { opCase, runs } = await startCase();
    expect(dispatchDecisions(runs)).toEqual(
      expect.arrayContaining([expect.objectContaining({ trigger: 'ensure_case_room', mode: 'rule', outcome: 'done' })])
    );
    expect(opCase.chatChannelId).toBeTruthy();
    const roomId = opCase.chatChannelId!;
    const room = await prisma.internalChatChannel.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.type).toBe('case');

    const members = await activeMembers(roomId);
    const bots = members.filter((m) => m.isBot).map((m) => m.username);
    expect(bots).toEqual(expect.arrayContaining(['ia_admin', 'ia_ventas', 'ia_inventario']));
    // Compras is not involved yet: neither its bot nor its responsible are in the room.
    expect(bots).not.toContain('ia_compras');
    const humans = members.filter((m) => !m.isBot).map((m) => m.userId);
    expect(humans).toEqual(
      expect.arrayContaining([
        opCase.ownerUserId,
        team.byArea.ventas.id,
        team.byArea.inventario.id,
        team.inventoryBackup.id,
      ])
    );
    expect(humans).not.toContain(team.byArea.compras.id);

    const started = (await channelMessages(roomId)).filter((m) => metaOf(m).eventType === 'case.started');
    expect(started).toHaveLength(1);
    expect(started[0].senderId).toBe(await botUserId('ia_admin'));
    expect(metaOf(started[0])).toMatchObject({ kind: 'agent_update', caseId: opCase.id });

    // The same event delivered again (a re-delivered job) neither creates another room nor posts twice.
    const created = await prisma.operationalEvent.findFirstOrThrow({ where: { caseId: opCase.id, type: 'case.created' } });
    await enqueueJob({ type: 'agents.dispatch', payload: { kind: 'event', eventId: created.id.toString() }, maxAttempts: 1 });
    await drainAll();
    expect((await prisma.operationalCase.findUniqueOrThrow({ where: { id: opCase.id } })).chatChannelId).toBe(roomId);
    expect(await prisma.internalChatChannel.count({ where: { type: 'case' } })).toBe(1);
    expect((await channelMessages(roomId)).filter((m) => metaOf(m).eventType === 'case.started')).toHaveLength(1);

    expect(ai.calls).toEqual([]);
    expect(ai.utilityCalls).toBe(0);
  });

  it('faltante → solicitud a Compras con plantilla en la sala y en el canal del área, chatMessageId y aviso; cero llamadas al modelo', async () => {
    const { opCase, demandId, request, runs } = await startShortfallCase();

    // One purchase request for the shortfall: the engine asked Compras and the rule did not duplicate it.
    expect(await prisma.areaRequest.count({ where: { caseId: opCase.id, kind: 'purchase_shortfall' } })).toBe(1);
    expect(request).toMatchObject({
      fromAreaKey: 'inventario',
      toAreaKey: 'compras',
      ownerUserId: team.byArea.compras.id,
      blocksDelivery: true,
    });
    const decisions = dispatchDecisions(runs);
    const shortfall = decisions.filter((d) => d.trigger === 'shortfall_to_purchase_request');
    expect(shortfall.length).toBeGreaterThan(0);
    expect(shortfall.every((d) => d.mode === 'rule' && d.outcome !== 'failed')).toBe(true);
    expect(
      await prisma.operationalEvent.count({ where: { type: 'demand.shortfall_confirmed', objectId: demandId } })
    ).toBe(1);

    // Card in the case room, posted by the origin agent, linked to the request.
    const roomId = opCase.chatChannelId!;
    expect(request.chatMessageId).toBeTruthy();
    const card = await prisma.internalChatMessage.findUniqueOrThrow({ where: { id: request.chatMessageId! } });
    expect(card.channelId).toBe(roomId);
    expect(card.senderId).toBe(await botUserId('ia_inventario'));
    expect(metaOf(card)).toMatchObject({
      kind: 'agent_request',
      requestId: request.id,
      caseId: opCase.id,
      areaKey: 'compras',
      quickActions: ['accept', 'block', 'open_case'],
    });
    expect(card.content).toContain('Compras');

    // The room now includes the destination area (responsible, backup and bot).
    const members = await activeMembers(roomId);
    expect(members.map((m) => m.userId)).toEqual(
      expect.arrayContaining([team.byArea.compras.id, team.purchasesBackup.id, await botUserId('ia_compras')])
    );

    // Short copy in the Compras channel, posted by the IA de Compras.
    const comprasArea = await prisma.area.findUniqueOrThrow({ where: { key: 'compras' } });
    expect(comprasArea.chatChannelId).toBeTruthy();
    const copies = (await channelMessages(comprasArea.chatChannelId!)).filter(
      (m) => metaOf(m).kind === 'agent_request' && metaOf(m).requestId === request.id
    );
    expect(copies).toHaveLength(1);
    expect(copies[0].senderId).toBe(await botUserId('ia_compras'));
    expect(metaOf(copies[0]).copyOf).toBe(card.id);

    // ONE notice to the responsible for the request (the core's, linked to the work item); the
    // announcement templates never add a second one nor fan out chat notifications.
    const notices = await prisma.notification.findMany({
      where: { userId: team.byArea.compras.id, entityType: 'area_request', entityId: request.id },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ category: 'ops_request' });
    expect(await prisma.notification.count({ where: { userId: team.byArea.compras.id, category: 'agent_request' } })).toBe(0);

    // The automatic acknowledgement is not announced again (the card already names the responsible).
    expect((await prisma.areaRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('acknowledged');
    expect((await channelMessages(roomId)).filter((m) => metaOf(m).eventType === 'request.acknowledged')).toEqual([]);

    expect(ai.calls).toEqual([]);
    expect(ai.utilityCalls).toBe(0);
  });

  it('request.overdue → turno de la IA de Compras: tool_choice required, tools dentro de su lista y propuesta con alcance publicada en la sala', async () => {
    const { opCase, request } = await overdueTurn();
    const comprasBot = await botUserId('ia_compras');

    expect(await prisma.operationalEvent.count({ where: { type: 'request.overdue', objectId: request.id } })).toBe(1);

    // Only the unblock turn reached the model, as the bot, forced to act through tools on the first call.
    // The turn proposed and concluded in the same call: concludeAgentTurn ends it (ONE model call).
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls.every((call) => call.trigger === 'unblock' && call.userId === comprasBot)).toBe(true);
    const [first, ...rest] = ai.calls;
    expect(first).toMatchObject({ afterTools: false, toolChoice: 'required' });
    expect(rest.every((call) => call.toolChoice === undefined)).toBe(true);
    const allowlist = new Set(AGENT_TOOL_ALLOWLIST.compras);
    for (const call of ai.calls) {
      expect(call.toolNames.filter((name) => !allowlist.has(name))).toEqual([]);
      expect(call.toolNames.length).toBeLessThanOrEqual(20);
    }
    expect(first.toolNames).toEqual(expect.arrayContaining(['respondAreaRequest', 'concludeAgentTurn']));
    expect(first.toolNames).not.toContain('loadMoreTools');

    // The business write became a proposal with the approver scope of the destination area.
    const proposal = await prisma.aiProposal.findFirstOrThrow({
      where: { userId: comprasBot, toolName: 'respondAreaRequest' },
    });
    expect(proposal.status).toBe('pending');
    expect(proposal.args).toMatchObject({ requestId: request.id, action: 'accept' });
    expect(proposal.approverScope).toMatchObject({ caseId: opCase.id, areaKey: 'compras' });
    const scopeUsers = (proposal.approverScope as { userIds: string[] }).userIds;
    expect([...scopeUsers].sort()).toEqual([team.byArea.compras.id, team.purchasesBackup.id].sort());

    // Card in the case room and notice to every approver.
    const messages = await channelMessages(opCase.chatChannelId!);
    const proposalCard = messages.find((m) => metaOf(m).kind === 'agent_proposal' && metaOf(m).proposalId === proposal.id);
    expect(proposalCard?.senderId).toBe(comprasBot);
    expect(metaOf(proposalCard)).toMatchObject({ caseId: opCase.id, areaKey: 'compras', status: 'pending', toolName: 'respondAreaRequest' });
    expect(metaOf(proposalCard)).not.toHaveProperty('args');
    for (const userId of scopeUsers) {
      expect(await prisma.notification.count({ where: { userId, category: 'agent_proposal' } })).toBe(1);
    }

    // The conclusion line (needs_human) and the ai.turn audit event with tokens.
    const line = messages.find((m) => metaOf(m).kind === 'agent_reply' && m.senderId === comprasBot);
    expect(line?.content).toContain('Propuse aceptar la solicitud');
    const turn = await prisma.operationalEvent.findFirstOrThrow({ where: { type: 'ai.turn', actorId: comprasBot } });
    expect(payloadOf(turn)).toMatchObject({
      agentKey: 'area:compras',
      trigger: 'unblock',
      outcome: 'needs_human',
      proposalIds: [proposal.id],
      promptTokens: 1200 * ai.calls.length,
      completionTokens: 80 * ai.calls.length,
    });

    // Nothing changed yet: a person decides.
    expect((await prisma.areaRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('acknowledged');
  });

  it('la aprobación de la responsable ejecuta la propuesta; el bot y una persona ajena son rechazados', async () => {
    const { opCase, request } = await overdueTurn();
    const comprasBot = await botUserId('ia_compras');
    const proposal = await prisma.aiProposal.findFirstOrThrow({ where: { userId: comprasBot, toolName: 'respondAreaRequest' } });

    const bot = await buildBotActor('area:compras');
    await expect(approveProposal(bot, proposal.id)).rejects.toMatchObject({ status: 403 });
    const otherBot = await buildBotActor('area:inventario');
    await expect(approveProposal(otherBot, proposal.id)).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(approveProposal(team.byArea.logistica, proposal.id)).rejects.toMatchObject({ status: 404 });
    expect((await prisma.aiProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('pending');
    expect((await prisma.areaRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('acknowledged');

    const { proposal: decided, execution } = await approveProposal(team.byArea.compras, proposal.id);
    expect(execution.success).toBe(true);
    expect(decided).toMatchObject({ status: 'executed', decisionBy: team.byArea.compras.id, proposedBy: comprasBot });
    expect((await prisma.areaRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('accepted');
    expect(
      await prisma.operationalEvent.count({
        where: { type: 'request.accepted', objectId: request.id, actorId: team.byArea.compras.id },
      })
    ).toBe(1);

    // A second click (the backup) never runs it again.
    await expect(approveProposal(team.purchasesBackup, proposal.id)).rejects.toMatchObject({ status: 409 });

    // The decision by a person is announced in the room by rule.
    await drainAll();
    const updates = (await channelMessages(opCase.chatChannelId!)).filter(
      (m) => metaOf(m).eventType === 'request.accepted' && metaOf(m).requestId === request.id
    );
    expect(updates).toHaveLength(1);
  });

  it('presupuesto: degradado deja sólo lo bajo demanda; agotado pausa con una plantilla y avisa a dirección', async () => {
    const { request } = await startShortfallCase();
    ai.calls.length = 0;
    ai.requestId = request.id;
    const identity = await prisma.agentIdentity.update({
      where: { key: 'area:compras' },
      data: { dailyTokenBudget: 10_000 },
    });
    const bot = identity.botUserId;
    await recordAgentUsage({ agentKey: 'area:compras', areaKey: 'compras', userId: bot, promptTokens: 8_500, completionTokens: 0, model: 'gpt-4o-mini' });

    // Degraded (85 %): the automatic unblock is skipped without calling the model.
    await prisma.areaRequest.update({ where: { id: request.id }, data: { dueAt: new Date(Date.now() - 30 * 60_000) } });
    await runSupervisorTick();
    await drainAll();
    expect(ai.calls).toEqual([]);
    const skipped = await prisma.operationalEvent.findMany({ where: { type: 'ai.turn_skipped', actorId: bot } });
    expect(skipped.map(payloadOf)).toEqual([expect.objectContaining({ trigger: 'unblock', reason: 'budget_degraded' })]);
    expect(await prisma.notification.count({ where: { userId: team.manager.id, category: 'agent_budget' } })).toBe(1);

    // Degraded = on demand: a person mentioning the bot still gets an answer.
    const channel = await ensureAreaChannel('compras');
    const human = team.byArea.compras;
    await sendMessage(human, { channelId: channel.id, content: '@ia_compras ¿qué solicitudes tengo abiertas?' });
    await drainAll();
    expect(ai.calls.filter((call) => call.trigger === 'mention').length).toBeGreaterThan(0);
    const repliesBefore = (await channelMessages(channel.id)).filter((m) => m.senderId === bot && metaOf(m).kind === 'agent_reply');
    expect(repliesBefore).toHaveLength(1);

    // Exhausted: even a mention pauses, with ONE pause template and a second (exhausted) notice.
    await recordAgentUsage({ agentKey: 'area:compras', areaKey: 'compras', userId: bot, promptTokens: 5_000, completionTokens: 0, model: 'gpt-4o-mini' });
    const callsBefore = ai.calls.length;
    await sendMessage(human, { channelId: channel.id, content: '@ia_compras ¿sigues ahí?' });
    await drainAll();
    await sendMessage(human, { channelId: channel.id, content: '@ia_compras ¿me respondes?' });
    await drainAll();
    expect(ai.calls.length).toBe(callsBefore);
    const exhausted = (await prisma.operationalEvent.findMany({ where: { type: 'ai.turn_skipped', actorId: bot } }))
      .map(payloadOf)
      .filter((p) => p.reason === 'budget_exhausted');
    expect(exhausted).toHaveLength(2);
    const pauses = (await channelMessages(channel.id)).filter((m) => metaOf(m).notice === 'budget_exhausted');
    expect(pauses).toHaveLength(1);
    expect(pauses[0].senderId).toBe(bot);
    expect(pauses[0].content).toContain('Responsable Compras');
    expect(await prisma.notification.count({ where: { userId: team.manager.id, category: 'agent_budget' } })).toBe(2);
    expect(
      (await channelMessages(channel.id)).filter((m) => m.senderId === bot && metaOf(m).kind === 'agent_reply')
    ).toHaveLength(1);
  });

  it('mención a @ia_compras: una respuesta en el hilo y un evento ai.turn con tokens medidos una sola vez', async () => {
    const channel = await ensureAreaChannel('compras');
    const bot = await botUserId('ia_compras');
    const human = team.byArea.compras;
    const members = (await activeMembers(channel.id)).map((m) => m.userId);
    expect(members).toEqual(expect.arrayContaining([human.id, bot]));

    const message = await sendMessage(human, {
      channelId: channel.id,
      content: '@ia_compras ¿qué solicitudes tengo abiertas hoy?',
    });
    const runs = await drainAll();
    expect(dispatchDecisions(runs)).toEqual([
      expect.objectContaining({ trigger: 'mention', agent: 'area:compras', mode: 'llm', outcome: 'done' }),
    ]);

    // Concluding ends the turn: one model call, no extra call to write prose.
    expect(ai.calls.length).toBe(1);
    expect(ai.calls[0]).toMatchObject({ trigger: 'mention', toolChoice: 'required', afterTools: false, userId: bot });
    expect(ai.calls[0].toolNames.filter((name) => !AGENT_TOOL_ALLOWLIST.compras.includes(name))).toEqual([]);

    const replies = await prisma.internalChatMessage.findMany({ where: { channelId: channel.id, senderId: bot } });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ replyToId: message.id, content: ai.mentionReply });
    expect(metaOf(replies[0])).toMatchObject({ kind: 'agent_reply', trigger: 'mention', outcome: 'acted', areaKey: 'compras' });

    const turn = await prisma.operationalEvent.findFirstOrThrow({ where: { type: 'ai.turn', actorId: bot } });
    expect(payloadOf(turn)).toMatchObject({
      agentKey: 'area:compras',
      trigger: 'mention',
      outcome: 'acted',
      chatMessageId: replies[0].id,
      promptTokens: 1200,
      completionTokens: 80,
      model: 'gpt-4o-mini',
    });
    expect(Number(payloadOf(turn).costUsd)).toBeGreaterThan(0);

    // Metered once by the orchestrator (the runner never adds it again).
    const tokens = await prisma.usageMeter.aggregate({
      where: { dimension: 'ai_agent', key: 'area:compras', unit: AI_USAGE_UNITS.tokens },
      _sum: { amount: true },
    });
    expect(Number(tokens._sum.amount)).toBe(1280);

    // The same mention delivered again does not answer twice.
    await enqueueJob({
      type: 'agents.dispatch',
      payload: { kind: 'mention', messageId: message.id, channelId: channel.id, botUserIds: [bot] },
      maxAttempts: 1,
    });
    await drainAll();
    expect(ai.calls.length).toBe(1);
    expect(await prisma.internalChatMessage.count({ where: { channelId: channel.id, senderId: bot } })).toBe(1);
    const skipped = await prisma.operationalEvent.findMany({ where: { type: 'ai.turn_skipped', actorId: bot } });
    expect(skipped.map((event) => payloadOf(event).reason)).toEqual([
      expect.stringMatching(/^(already_handled|duplicate_trigger)$/),
    ]);
  });
});

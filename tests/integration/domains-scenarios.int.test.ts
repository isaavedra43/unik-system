import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Business scenarios of the DOMAIN areas (plan sections 6.1 Compras y Sourcing,
 * 6.2 Manufactura, 6.4 Contabilidad interna and 6.5 Ventas/CRM) against a REAL
 * PostgreSQL database with every migration applied. The core, inventory and
 * logistics scenarios live in `operations-scenarios.int.test.ts`; this suite is
 * its sibling for everything those 15 cases never touch: procurement orders
 * with a double signature, the payment authorization and its settlement,
 * partial receipts with a difference, direct deliveries, a delayed supplier,
 * production with scrap inside and outside the tolerance, duplicate expenses,
 * the reconciliation of a Zoho payment split across two obligations, the AI
 * provider down without stopping the engine, and an accepted quote that becomes
 * exactly one sales order and one case.
 *
 * Why against Postgres and not only FakePrisma: the modules rely on row locks
 * (`FOR UPDATE`), partial unique indexes (`ObligationSettlement.externalRef`,
 * `BackgroundJob.dedupeKey`, `SalesOrderWriteRequest.requestKey`), `$queryRaw`
 * and `Decimal` arithmetic, and on `commands.ts` being one registry per
 * process. None of that is modelled by the fake.
 *
 * - Runs only when UNIK_INTEGRATION_DATABASE_URL is set (vitest project
 *   `integration`, `npm run test:integration`); otherwise it is skipped with a
 *   message.
 * - The database must be disposable and local: the suite refuses any other
 *   (see `assertDisposableDatabase`). Every test starts from an empty
 *   operational state that the suite seeds itself, and the data is removed at
 *   the end, so it tolerates the truncation the other suites do.
 * - Nothing external is called: web push and the AI provider are mocked (the AI
 *   deliberately FAILS on every call, so the scenarios prove the engine works
 *   with the provider down — one of them exercises that degradation on purpose),
 *   and the only Zoho write is the Books mock enabled by env inside its own
 *   test. Everything else is real: transactions, row locks,
 *   unique keys, raw SQL, the command ledger, the outbox and the job handlers
 *   (drained here with the worker's semantics).
 *
 * Para que estos escenarios sean EVIDENCIA y no sólo verde (plan §9.1):
 * - `drainAllOk` no se conforma con que el job termine: mira el resultado y
 *   revienta si el comando fue RECHAZADO o el payload descartado (los
 *   manejadores sólo re-lanzan los rechazos reintentables, así que un
 *   `invalid_state` o un `no_approvers` dejarían el job en «completado»). La
 *   prueba «un job «completado» con el comando rechazado no pasa por trabajo
 *   hecho» fija esa red.
 * - Cada lectura se acota al expediente/asignación del escenario: una fila
 *   huérfana no puede hacerse pasar por la que se está probando.
 * - Un `afterEach` comprueba que la semilla siguió viva durante la prueba. Si
 *   otra corrida vació la base al mismo tiempo, los fallos aparecen
 *   disfrazados de defectos del producto (el expediente que no se abre, el
 *   aprobador que no existe, el job que desapareció); la guarda lo dice con
 *   todas sus letras en vez de dejar que se culpe al dominio.
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;
if (!integrationUrl) {
  console.warn(
    '[integration] Se omiten los escenarios de dominio: define UNIK_INTEGRATION_DATABASE_URL ' +
      'con una base PostgreSQL local y desechable con todas las migraciones aplicadas ' +
      '(por ejemplo unik_schema_check) y ejecuta `npm run test:integration`.'
  );
}

const mocks = vi.hoisted(() => ({
  chatCompletion: vi.fn(async () => {
    throw new Error('proveedor de IA no disponible en pruebas');
  }),
  sendPushToUser: vi.fn(async () => ({ sent: 0, failed: 0, removed: 0, skipped: true })),
}));

// The coordinated AI layer is out of scope here (it has its own suite) and every
// scenario must hold with the provider down: the model call always fails.
vi.mock('@/modules/ai/ai-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/ai/ai-client')>()),
  chatCompletion: mocks.chatCompletion,
}));
vi.mock('@/modules/notifications/push-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/notifications/push-service')>()),
  sendPushToUser: mocks.sendPushToUser,
}));

import { prisma } from '@/lib/prisma';
// Every operational command (core + the four domains) through the barrel, like the app.
import '@/modules/operations/register-commands';
// Job handlers and cross-module listeners of the domains (finance subscribes to new cases here).
import '@/modules/purchases/purchases-jobs';
import '@/modules/manufacturing/manufacturing-jobs';
import '@/modules/finance/finance-jobs';
import '@/modules/crm/crm-jobs';

import { loadActiveCurrentUser, type CurrentUser } from '@/modules/auth/authorization';
import { ensurePipelineSeed } from '@/modules/crm/pipeline-service';
import {
  createSalesOrderFromQuote,
  runSalesOrderReadback,
} from '@/modules/crm/sales-order-write-service';
import { ensureFinanceSeed } from '@/modules/finance/catalog-service';
import { reconcileCollections } from '@/modules/finance/collections-service';
import {
  captureExpense,
  postExpense,
  resolveExpenseDuplicate,
  submitExpense,
} from '@/modules/finance/finance-commands';
import { invalidateFinanceSettingsCache } from '@/modules/finance/finance-config';
import { runExpenseProposeJob } from '@/modules/finance/finance-jobs';
import { settleObligation } from '@/modules/finance/obligations-service';
import { verifyAvailability } from '@/modules/inventory/inventory-service';
import { ensureGeneralLocation } from '@/modules/inventory/warehouses-service';
import { enqueueJob, JOB_PRIORITY, type JobContext } from '@/modules/jobs/job-queue';
import {
  createTransformationOrder,
  finishOperation,
  inspectProductionOrder,
  prepareProductionOrder,
  recordConsumption,
  recordOutput,
  releaseProductionOrder,
  startOperation,
} from '@/modules/manufacturing/manufacturing-commands';
import { getProductionOrderDetail } from '@/modules/manufacturing/manufacturing-queries';
import { decideApproval } from '@/modules/operations/approvals-service';
import {
  runCaseAdvanceJob,
  runCaseReplanJob,
  runCaseStartJob,
} from '@/modules/operations/case-jobs';
import { advanceCaseCommand } from '@/modules/operations/case-service';
import type { CommandResult } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { clearProcessBlueprintCache } from '@/modules/operations/process-blueprints/registry';
import { CASE_JOB_TYPES, caseStartDedupeKey } from '@/modules/operations/sales-order-hooks';
import { ensureOperationsSeed } from '@/modules/operations/seed';
import { AREA_KEYS, AREA_LABELS, type AreaKey } from '@/modules/operations/types';
import { completeWorkItem } from '@/modules/operations/work-items-service';
import * as purchases from '@/modules/purchases/purchases-commands';
import {
  runDirectDeliverySyncJob,
  runOrderFollowupJob,
  runShortfallSyncJob,
} from '@/modules/purchases/purchases-jobs';
import { listExpectedSupply } from '@/modules/purchases/purchases-queries';

import { assertDisposableDatabase, truncateTables } from './integration-db';

// ---------------------------------------------------------------------------
// Safety and cleanup
// ---------------------------------------------------------------------------

/** Tables owned by the operations program and its four domain areas. */
const RESET_TABLES = [
  // Operations core and agents layer
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
  // Inventory and logistics core
  'Warehouse',
  'StorageLocation',
  'ProductInventoryProfile',
  'StockItem',
  'StockMovement',
  'StockReservation',
  'StockCount',
  'StockCountLine',
  'LegacyCommitmentClaim',
  'Vehicle',
  'Driver',
  'DeliveryOrder',
  'Trip',
  'TripStop',
  'DeliveryEvidence',
  // Compras y Sourcing (6.1)
  'Supplier',
  'SupplierProduct',
  'SupplierEvaluation',
  'PurchaseRequest',
  'PurchaseRequestLine',
  'Rfq',
  'RfqLine',
  'RfqInvitation',
  'RfqResponse',
  'RfqResponseLine',
  'ProcurementOrder',
  'ProcurementOrderLine',
  'ProcurementAllocation',
  'GoodsReceipt',
  'GoodsReceiptLine',
  'SourcingSearch',
  'SourcingCandidate',
  // Manufactura (6.2)
  'WorkCenter',
  'Bom',
  'BomLine',
  'BomOperation',
  'ProductionOrder',
  'ProductionOperation',
  'MaterialConsumption',
  'ProductionOutput',
  'QualityCheck',
  // Contabilidad interna (6.4)
  'CashAccount',
  'FinanceCategory',
  'CostCenter',
  'LedgerEntry',
  'LedgerLine',
  'Obligation',
  'ObligationSettlement',
  'Expense',
  'ExpenseSplit',
  'ExpenseTemplate',
  'Budget',
  'Employee',
  'PayrollRun',
  'PayrollLine',
  'PeriodClose',
  // Ventas / CRM (6.5)
  'PipelineStage',
  'Opportunity',
  'OpportunityActivity',
  'SalesOrderWriteRequest',
  'RadarSignal',
  // Side effects of the commands (disposable database only)
  'BackgroundJob',
  'Notification',
  'AuditLog',
  'RealtimeEvent',
  'UsageMeter',
  'EntityChangeEvent',
  'UserNotificationSettings',
  // La tarjeta de la propuesta de IA (6.2) y su bitácora de ejecución: las
  // escribe ESTA suite, así que también las limpia (si no, cada corrida deja
  // tarjetas con usuarios `it_*` que ya no existen y ensucia a las demás).
  'AiProposal',
  'ExtensionExecution',
];

async function resetDatabase(): Promise<void> {
  await truncateTables(RESET_TABLES);
  await prisma.$executeRaw`DELETE FROM "StorageObject" WHERE left("objectKey", 12) = 'evidence/it-'`;
  await prisma.$executeRaw`DELETE FROM "QuoteItem" WHERE "quoteId" IN (SELECT "id" FROM "Quote" WHERE left("zohoEstimateId", 3) = 'it-')`;
  await prisma.$executeRaw`DELETE FROM "Quote" WHERE left("zohoEstimateId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "CustomerPayment" WHERE left("zohoPaymentId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "IntegrationSnapshot" WHERE left("externalId", 3) = 'it-' OR left("externalId", 7) = 'SO-MOCK'`;
  await prisma.$executeRaw`DELETE FROM "SalesOrderItem" WHERE "salesOrderId" IN (SELECT "id" FROM "SalesOrder" WHERE left("zohoSalesOrderId", 3) = 'it-' OR left("referenceNumber", 6) = 'it-COT')`;
  await prisma.$executeRaw`DELETE FROM "SalesOrder" WHERE left("zohoSalesOrderId", 3) = 'it-' OR left("referenceNumber", 6) = 'it-COT'`;
  await prisma.$executeRaw`DELETE FROM "Product" WHERE left("zohoItemId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "Contact" WHERE left("zohoContactId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "Responsible" WHERE left("userId", 3) = 'it_'`;
  await prisma.$executeRaw`DELETE FROM "Role" WHERE left("key", 3) = 'it_'`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE left("id", 3) = 'it_'`;
  await prisma.$executeRaw`DELETE FROM "IntegrationConfig" WHERE "source" IN ('operations', 'finance')`;
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  clearProcessBlueprintCache();
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

const CUTOVER = '2026-01-01T00:00:00.000Z';
const ZOHO_LOCATION = 'it-loc-1';
const OPEN_WORK = ['open', 'in_progress', 'waiting', 'escalated'];

const VIEW = ['operations.view'];

interface Team {
  byArea: Record<AreaKey, CurrentUser>;
  /** Compras */
  buyer: CurrentUser;
  approver: CurrentUser;
  director: CurrentUser;
  receiver: CurrentUser;
  /** Contabilidad */
  accountant: CurrentUser;
  capturer: CurrentUser;
  treasurer: CurrentUser;
  treasuryDirector: CurrentUser;
  /** Manufactura */
  planner: CurrentUser;
  operator: CurrentUser;
  inspector: CurrentUser;
  plantChief: CurrentUser;
  /** Ventas */
  seller: CurrentUser;
}

interface Base {
  team: Team;
  warehouseId: string;
  generalLocationId: string;
  workCenterId: string;
}

let base: Base;
/** Cuántos usuarios `it_*` dejó `seedBase()` en la corrida actual (guarda de `afterEach`). */
let seededUserCount = 0;
let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

async function seedUser(id: string, name: string, permissions: string[]): Promise<CurrentUser> {
  await prisma.user.create({
    data: { id, username: id, name, passwordHash: 'integration', mustChangePassword: false },
  });
  if (permissions.length > 0) {
    const role = await prisma.role.create({
      data: { key: `${id}_permisos`, name: `Permisos ${name}` },
    });
    await prisma.rolePermission.createMany({
      data: permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
    });
    await prisma.userRole.create({ data: { userId: id, roleId: role.id } });
  }
  const user = await loadActiveCurrentUser(id);
  if (!user) throw new Error(`No se pudo cargar al usuario ${id}`);
  return user;
}

/**
 * The area responsibles only see; every action needs its own person, so a
 * scenario can never pass because one omnipotent user did everything.
 */
const AREA_PERMISSIONS: Record<AreaKey, string[]> = {
  ventas: [...VIEW, 'inventory.view', 'crm.view'],
  compras: [...VIEW, 'purchases.view'],
  inventario: [...VIEW, 'inventory.view', 'inventory.count', 'inventory.reserve'],
  manufactura: [...VIEW, 'manufacturing.view'],
  logistica: [...VIEW, 'logistics.view'],
  contabilidad: [...VIEW, 'finance.view'],
  administracion: VIEW,
};

async function seedBase(): Promise<Base> {
  const byArea = {} as Record<AreaKey, CurrentUser>;
  for (const area of AREA_KEYS) {
    byArea[area] = await seedUser(
      `it_${area}`,
      `Responsable ${AREA_LABELS[area]}`,
      AREA_PERMISSIONS[area]
    );
  }
  const team: Team = {
    byArea,
    buyer: await seedUser('it_compradora', 'Compradora', [
      ...VIEW,
      'purchases.view',
      'purchases.request',
      'purchases.manage_orders',
      'purchases.manage_suppliers',
    ]),
    approver: await seedUser('it_aprobador', 'Jefe de compras', [
      'purchases.view',
      'purchases.approve',
    ]),
    director: await seedUser('it_director', 'Dirección', ['purchases.view', 'purchases.approve']),
    receiver: await seedUser('it_almacenista', 'Almacenista', [
      'purchases.view',
      'purchases.receive',
      'inventory.view',
    ]),
    accountant: await seedUser('it_contadora', 'Contadora', [
      ...VIEW,
      'finance.view',
      'finance.manage_obligations',
      'finance.post',
    ]),
    capturer: await seedUser('it_capturista', 'Capturista de gastos', [
      'finance.view',
      'finance.capture_expense',
    ]),
    treasurer: await seedUser('it_tesoreria', 'Tesorería', ['finance.view', 'finance.approve']),
    treasuryDirector: await seedUser('it_tesoreria_dir', 'Dirección de finanzas', [
      'finance.view',
      'finance.approve',
    ]),
    planner: await seedUser('it_planeadora', 'Planeadora', [
      ...VIEW,
      'manufacturing.view',
      'manufacturing.manage_orders',
      'manufacturing.manage_boms',
    ]),
    operator: await seedUser('it_operador', 'Operador', [
      'manufacturing.view',
      'manufacturing.operate',
    ]),
    inspector: await seedUser('it_calidad', 'Calidad', [
      'manufacturing.view',
      'manufacturing.inspect',
    ]),
    plantChief: await seedUser('it_jefa_planta', 'Jefa de planta', [
      'manufacturing.view',
      'manufacturing.approve_incidents',
    ]),
    seller: await seedUser('it_vendedora', 'Vendedora', [
      'crm.view',
      'crm.manage',
      'crm.create_sales_order',
    ]),
  };
  for (const area of AREA_KEYS) {
    await prisma.responsible.create({
      data: { area, label: AREA_LABELS[area], userId: `it_${area}` },
    });
  }
  // Everything on from minute one; the cutover is in the past so the test orders are eligible.
  await prisma.integrationConfig.create({
    data: {
      source: 'operations',
      displayName: 'Operaciones',
      isEnabled: true,
      settings: { cutoverDate: CUTOVER },
    },
  });
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  clearProcessBlueprintCache();
  await ensureOperationsSeed();
  await ensureFinanceSeed(prisma as unknown as Prisma.TransactionClient);
  await ensurePipelineSeed();

  const warehouse = await prisma.warehouse.create({
    data: { key: 'it-principal', name: 'Bodega integración', zohoLocationId: ZOHO_LOCATION },
  });
  const general = await ensureGeneralLocation(prisma, warehouse.id);
  const workCenter = await prisma.workCenter.create({
    data: {
      key: 'it-corte',
      name: 'Corte',
      capacityPerShift: new Prisma.Decimal(500),
      capacityUnit: 'pieces',
      shifts: [{ name: 'Matutino', start: '08:00', end: '16:00', days: [1, 2, 3, 4, 5, 6, 7] }],
      status: 'active',
    },
  });
  return {
    team,
    warehouseId: warehouse.id,
    generalLocationId: general.id,
    workCenterId: workCenter.id,
  };
}

async function seedProduct(zohoItemId: string, name = `Producto ${zohoItemId}`): Promise<void> {
  await prisma.product.create({
    data: {
      zohoItemId,
      name,
      sku: zohoItemId.toUpperCase(),
      unit: 'pz',
      status: 'active',
      sourceRemoteModifiedAt: new Date(),
      sourceSnapshotId: 'it-snapshot',
    },
  });
}

/** Product + CONTROLLED profile (no stock row: `quantity` 0 leaves the shelf empty). */
async function seedControlledStock(zohoItemId: string, quantity: number): Promise<void> {
  await seedProduct(zohoItemId);
  const now = new Date();
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
  if (quantity > 0) {
    await prisma.stockItem.create({
      data: {
        zohoItemId,
        warehouseId: base.warehouseId,
        locationId: base.generalLocationId,
        baseline: quantity,
        knownQty: quantity,
        lastCountedAt: now,
      },
    });
  }
}

interface OrderLine {
  zohoItemId: string;
  quantity: number;
}

interface SeededOrder {
  id: string;
  zohoSalesOrderId: string;
  salesOrderNumber: string;
}

async function seedSalesOrder(
  lines: OrderLine[],
  overrides: Partial<Prisma.SalesOrderCreateInput> = {}
): Promise<SeededOrder> {
  const zohoSalesOrderId = nextId('it-so');
  const salesOrderNumber = `SO-${zohoSalesOrderId.toUpperCase()}`;
  const order = await prisma.salesOrder.create({
    data: {
      zohoSalesOrderId,
      salesOrderNumber,
      status: 'confirmed',
      shippedStatus: 'pending',
      invoicedStatus: 'not_invoiced',
      paidStatus: 'unpaid',
      createdTime: new Date(Date.now() - 60 * 60_000),
      orderDate: new Date(new Date().toISOString().slice(0, 10)),
      locationId: ZOHO_LOCATION,
      locationName: 'Bodega integración',
      customerName: 'Constructora Integración',
      deliveryMethod: 'Entrega a domicilio',
      shippingAttention: 'Juan Pérez',
      shippingAddressLine1: 'Av. Reforma 100',
      shippingCity: 'Monterrey',
      shippingState: 'NL',
      shippingPostalCode: '64000',
      shippingPhone: '8110000000',
      sourceRemoteModifiedAt: new Date(),
      sourceSnapshotId: `${zohoSalesOrderId}-snapshot`,
      ...overrides,
      items: {
        create: lines.map((line, index) => ({
          zohoLineItemId: `${zohoSalesOrderId}-li-${index + 1}`,
          zohoItemId: line.zohoItemId,
          sku: line.zohoItemId.toUpperCase(),
          name: `Producto ${line.zohoItemId}`,
          quantity: line.quantity,
          unit: 'pz',
          locationId: ZOHO_LOCATION,
          sortOrder: index + 1,
        })),
      },
    },
  });
  return { id: order.id, zohoSalesOrderId, salesOrderNumber };
}

/** A photo already uploaded by `userId` (the evidence guard checks the uploader). */
async function uploadEvidence(userId: string): Promise<string> {
  const object = await prisma.storageObject.create({
    data: {
      provider: 'disk',
      bucketAlias: 'files',
      objectKey: `evidence/it-${randomUUID()}/v1`,
      versionId: 'v1',
      originalName: 'entrega.jpg',
      declaredMimeType: 'image/jpeg',
      detectedMimeType: 'image/jpeg',
      sizeBytes: BigInt(2048),
      status: 'ready',
      purpose: 'evidence',
      createdBy: userId,
    },
  });
  return object.id;
}

// ---------------------------------------------------------------------------
// Jobs: drained with the semantics of the worker (job-queue.ts runJob)
// ---------------------------------------------------------------------------

type Handler = (job: JobContext<never>) => Promise<unknown>;

const JOB_HANDLERS: Record<string, Handler> = {
  [CASE_JOB_TYPES.start]: runCaseStartJob as Handler,
  [CASE_JOB_TYPES.replan]: runCaseReplanJob as Handler,
  [CASE_JOB_TYPES.advance]: runCaseAdvanceJob as Handler,
  'purchases.shortfall_sync': runShortfallSyncJob as Handler,
  'purchases.order_followup': runOrderFollowupJob as Handler,
  'purchases.direct_delivery_sync': runDirectDeliverySyncJob as Handler,
  'crm.sales_order_readback': (async (job: JobContext<{ requestKey: string }>) =>
    runSalesOrderReadback(job.payload.requestKey)) as Handler,
};

interface JobRun {
  type: string;
  attempt: number;
  outcome: 'completed' | 'retry' | 'failed';
  error?: string;
  /** Lo que devolvió el manejador (el mismo JSON que el worker guarda en `BackgroundJob.result`). */
  result?: unknown;
}

/**
 * Un job «completado» NO significa que el dominio haya hecho el trabajo.
 *
 * Los manejadores devuelven `summarize(result)` y sólo vuelven a lanzar los
 * rechazos REINTENTABLES (`throwIfRetryable`): un comando rechazado por reglas
 * de negocio (`invalid_state`, `no_approvers`, `forbidden`…) o un payload
 * descartado (`skipped`) terminan como job COMPLETADO y con `status` dentro del
 * resultado. Si la suite se conformara con el estado del job, un escenario
 * podría quedar verde mientras el dominio rechazaba justo lo que se quería
 * probar, y el fallo aparecería mucho después disfrazado de otra cosa
 * (`No record was found` al buscar el expediente que nunca se abrió). Por eso
 * `drainAllOk` mira DENTRO del resultado.
 *
 * Devuelve la razón cuando el resultado confiesa que no se hizo el trabajo.
 */
function jobRejection(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const row = result as Record<string, unknown>;
  const status = typeof row.status === 'string' ? row.status : null;
  if (status === 'rejected' || status === 'failed') {
    return `${status} (${String(row.errorCode ?? 'sin código')}: ${String(row.message ?? '')})`;
  }
  const skipped =
    row.skipped !== undefined && row.skipped !== null
      ? row.skipped
      : status === 'skipped'
        ? (row.reason ?? true)
        : null;
  return skipped === null ? null : `skipped (${String(skipped)})`;
}

const toJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined || value === null
    ? Prisma.JsonNull
    : JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

/**
 * Claims pending jobs of the known types one by one (ignoring the retry
 * back-off, which only delays) and records the outcome exactly like the worker.
 */
async function drainJobs(maxRuns = 60): Promise<JobRun[]> {
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
    const context = {
      id: job.id,
      type: job.type,
      payload: job.payload,
      attempt,
      signal: new AbortController().signal,
      async setProgress() {},
      log() {},
    } as unknown as JobContext<never>;
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
      runs.push({ type: job.type, attempt, outcome: 'completed', result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = attempt >= job.maxAttempts;
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: exhausted
          ? {
              status: 'failed',
              lastError: message.slice(0, 2000),
              completedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
              dedupeKey: null,
            }
          : {
              status: 'pending',
              lastError: message.slice(0, 2000),
              lockedAt: null,
              lockedBy: null,
            },
      });
      runs.push({
        type: job.type,
        attempt,
        outcome: exhausted ? 'failed' : 'retry',
        error: message,
      });
    }
  }
  throw new Error(`drainJobs: más de ${maxRuns} ejecuciones; ¿un job se re-encola sin fin?`);
}

/**
 * Drena y exige que todo haya salido bien de verdad: el job completado Y su
 * comando aceptado (ver `jobRejection`). `allowRejected` tolera, por tipo de
 * job, un rechazo que el escenario espera a propósito.
 */
async function drainAllOk(allowRejected: readonly string[] = []): Promise<JobRun[]> {
  const runs = await drainJobs();
  expect(runs.filter((run) => run.outcome !== 'completed')).toEqual([]);
  const refused = runs
    .map((run) => ({ type: run.type, reason: jobRejection(run.result) }))
    .filter((row) => row.reason !== null && !allowRejected.includes(row.type));
  if (refused.length > 0) {
    throw new Error(
      'Un job terminó «completado» pero su comando no hizo el trabajo: ' +
        refused.map((row) => `${row.type} → ${row.reason}`).join('; ')
    );
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Reads and assertions
// ---------------------------------------------------------------------------

function expectStatus(
  result: Pick<CommandResult, 'status' | 'errorCode' | 'message'>,
  expected: string | string[]
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.status)) {
    throw new Error(
      `Se esperaba ${allowed.join(' | ')} y llegó ${result.status}` +
        (result.errorCode ? ` (${result.errorCode}: ${result.message ?? ''})` : '')
    );
  }
}

function ok<D>(result: CommandResult<D>): D {
  expectStatus(result, 'completed');
  return result.data as D;
}

/**
 * Retrato de la semilla en este instante. Se usa en los mensajes de error: si
 * la base desechable fue vaciada por OTRA corrida mientras la prueba corría,
 * los fallos aparecen disfrazados de defectos del producto (el expediente que
 * no se abre, el aprobador que no existe, el job que desapareció) y sin este
 * dato es imposible distinguirlos.
 */
async function describeSeedHealth(): Promise<string> {
  const [users, responsibles, config] = await Promise.all([
    prisma.user.count({ where: { id: { startsWith: 'it_' } } }),
    prisma.responsible.count({ where: { userId: { startsWith: 'it_' } } }),
    prisma.integrationConfig.count({ where: { source: 'operations' } }),
  ]);
  return (
    `Semilla viva: ${users} usuarios it_* (se sembraron ${seededUserCount}), ` +
    `${responsibles} responsables, ${config} configuración(es) de operaciones.`
  );
}

async function startCaseViaJob(order: SeededOrder) {
  await enqueueJob({
    type: CASE_JOB_TYPES.start,
    payload: { zohoSalesOrderId: order.zohoSalesOrderId },
    dedupeKey: caseStartDedupeKey(order.zohoSalesOrderId),
    priority: JOB_PRIORITY.interactive,
    maxAttempts: 3,
  });
  await drainAllOk();
  const opCase = await prisma.operationalCase.findFirst({
    where: { sourceType: 'sales_order', sourceId: order.zohoSalesOrderId },
  });
  if (!opCase) {
    const lines = await prisma.salesOrderItem.count({ where: { salesOrderId: order.id } });
    throw new Error(
      `El job ${CASE_JOB_TYPES.start} no abrió el expediente de ${order.zohoSalesOrderId}: ` +
        `la orden tiene ${lines} partida(s) en la base. ${await describeSeedHealth()}`
    );
  }
  return opCase;
}

async function stepOf(caseId: string, stepKey: string, scopeKey = '') {
  return prisma.caseStep.findFirstOrThrow({ where: { caseId, stepKey, scopeKey } });
}

async function openWorkItemOfStep(stepId: string) {
  return prisma.workItem.findFirstOrThrow({ where: { stepId, status: { in: OPEN_WORK } } });
}

async function eventTypes(where: Prisma.OperationalEventWhereInput): Promise<string[]> {
  const rows = await prisma.operationalEvent.findMany({ where, select: { type: true } });
  return rows.map((row) => row.type);
}

const num = (value: unknown) => Number(String(value));

/** Every posted ledger entry balances (debit = credit) — checked in SQL, not in JS. */
async function expectLedgerBalanced(): Promise<void> {
  const unbalanced = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT e."id" FROM "LedgerEntry" e
    JOIN "LedgerLine" l ON l."entryId" = e."id"
    GROUP BY e."id"
    HAVING SUM(l."debit") <> SUM(l."credit")`;
  expect(unbalanced).toEqual([]);
}

/** CONTROLLED stock never below zero and the reserved counter equals the active reservations. */
async function expectStockInvariants(): Promise<void> {
  const negative = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "StockItem" s
    JOIN "ProductInventoryProfile" p ON p."zohoItemId" = s."zohoItemId"
    WHERE p."confidence" = 'CONTROLLED'
      AND (s."knownQty" < 0 OR s."knownQty" - s."reserved" - s."blocked" - s."assignedToProduction" < 0)`;
  expect(negative).toEqual([]);
  const mismatched = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "StockItem" s
    LEFT JOIN "StockReservation" r ON r."stockItemId" = s."id" AND r."status" = 'active'
    GROUP BY s."id", s."reserved"
    HAVING s."reserved" <> COALESCE(SUM(r."quantity"), 0)`;
  expect(mismatched).toEqual([]);
}

/**
 * Case of `quantity` with `stock` counted: Inventario verifies and Ventas
 * decides the plan, so the engine creates the allocation of `source` and its
 * request to the owning area.
 */
async function caseWithAllocation(options: {
  zohoItemId: string;
  stock: number;
  quantity: number;
  source: 'purchase' | 'manufacture' | 'direct_supplier';
}) {
  await seedControlledStock(options.zohoItemId, options.stock);
  const order = await seedSalesOrder([
    { zohoItemId: options.zohoItemId, quantity: options.quantity },
  ]);
  const opCase = await startCaseViaJob(order);
  const demand = await prisma.caseDemand.findFirstOrThrow({ where: { caseId: opCase.id } });
  const verifyItem = await openWorkItemOfStep(
    (await stepOf(opCase.id, 'verificar_disponibilidad', demand.id)).id
  );
  expectStatus(
    await completeWorkItem(base.team.byArea.inventario, verifyItem.id, {
      result: { availability_result: { counted: options.stock } },
    }),
    'completed'
  );
  const planItem = await openWorkItemOfStep(
    (await stepOf(opCase.id, 'plan_abastecimiento', demand.id)).id
  );
  expectStatus(
    await completeWorkItem(base.team.byArea.ventas, planItem.id, {
      result: {
        allocation_plan: {
          lines: [
            ...(options.stock > 0 ? [{ source: 'stock' as const, quantity: options.stock }] : []),
            { source: options.source, quantity: options.quantity - options.stock },
          ],
        },
      },
    }),
    'completed'
  );
  const allocation = await prisma.demandAllocation.findFirstOrThrow({
    where: { demandId: demand.id, source: options.source },
  });
  const request = await prisma.areaRequest.findFirstOrThrow({
    where: { objectType: 'demand_allocation', objectId: allocation.id },
  });
  return { order, opCase, demand, allocation, request };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describeDb(
  'escenarios de dominio (compras, manufactura, contabilidad y CRM) contra PostgreSQL real',
  () => {
    beforeAll(async () => {
      if (!process.env.UNIK_INTEGRATION_VERBOSE)
        vi.spyOn(console, 'info').mockImplementation(() => {});
      await assertDisposableDatabase({
        requiredTables: [
          'ProcurementOrder',
          'ProductionOrder',
          'Obligation',
          'SalesOrderWriteRequest',
        ],
        missingLabel: 'los dominios',
      });
      await resetDatabase();
    });

    afterAll(async () => {
      try {
        await resetDatabase();
      } finally {
        await prisma.$disconnect();
      }
    });

    beforeEach(async () => {
      mocks.sendPushToUser.mockClear();
      mocks.chatCompletion.mockClear();
      await resetDatabase();
      base = await seedBase();
      seededUserCount = await prisma.user.count({ where: { id: { startsWith: 'it_' } } });
    });

    /**
     * Guarda anti-diagnóstico-falso: si la semilla DESAPARECIÓ mientras la
     * prueba corría, lo que se acaba de ejercer no es el producto sino una base
     * a medio vaciar por otra corrida, y el rojo (o el verde vacío) no vale
     * como evidencia. Una sola consulta por prueba; sólo habla cuando hay daño.
     */
    afterEach(async () => {
      const alive = await prisma.user.count({ where: { id: { startsWith: 'it_' } } });
      if (alive >= seededUserCount) return;
      throw new Error(
        `[integration] La semilla desapareció MIENTRAS corría la prueba (quedan ${alive} de ` +
          `${seededUserCount} usuarios it_*): otra corrida vació la base desechable al mismo tiempo. ` +
          'El resultado de esta prueba no es evidencia de nada; repite con la base en exclusiva ' +
          '(`npm run test:integration` toma el candado de corrida en tests/integration/global-setup.ts).'
      );
    });

    // -------------------------------------------------------------------------
    // 6.1 Compras y Sourcing
    // -------------------------------------------------------------------------

    it('faltante → solicitud → orden con doble firma → pago autorizado y liquidado → recepción parcial con diferencia → reserva → avance del expediente', async () => {
      const { team } = base;
      const { opCase, demand, allocation, request } = await caseWithAllocation({
        zohoItemId: 'it-item-piso',
        stock: 6,
        quantity: 10,
        source: 'purchase',
      });
      expect(request).toMatchObject({
        kind: 'purchase_shortfall',
        fromAreaKey: 'inventario',
        toAreaKey: 'compras',
        status: 'sent',
      });

      // 1. The shortfall becomes a purchase request (job planned in the same transaction).
      expect((await drainAllOk()).map((run) => run.type)).toContain('purchases.shortfall_sync');
      // Acotado al expediente/asignación de ESTE escenario: una fila huérfana de
      // otra corrida no puede hacerse pasar por la solicitud que se está probando.
      const purchaseRequest = await prisma.purchaseRequest.findFirstOrThrow({
        where: { caseId: opCase.id },
      });
      const requestLine = await prisma.purchaseRequestLine.findFirstOrThrow({
        where: { requestId: purchaseRequest.id, allocationId: allocation.id },
      });
      expect(purchaseRequest).toMatchObject({
        status: 'open',
        caseId: opCase.id,
        priority: 'high',
      });
      expect(requestLine).toMatchObject({
        demandId: demand.id,
        allocationId: allocation.id,
        zohoItemId: 'it-item-piso',
        status: 'open',
      });
      expect(num(requestLine.qty)).toBe(4);
      // Replaying the sync never duplicates the request (it is idempotent by area request).
      await purchases.runShortfallSync(request.id, 'it-job-repeat', 1);
      expect(await prisma.purchaseRequest.count()).toBe(1);

      // 2. Order above the double-signature threshold (4 × 15,000 = 69,600 with tax).
      const supplier = ok(
        await purchases.createSupplier(team.buyer, {
          name: 'Acme Materiales',
          paymentMode: 'prepaid',
        })
      ).supplier;
      const order = ok(
        await purchases.createProcurementOrder(team.buyer, {
          supplierId: supplier.id,
          expectedAt: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
          lines: [{ requestLineId: requestLine.id, qty: 4, unitPrice: 15_000, taxRate: 0.16 }],
        })
      ).order;
      expect(order).toMatchObject({ status: 'draft', total: '69600' });

      const submitted = ok(
        await purchases.submitProcurementOrder(team.buyer, { orderId: order.id })
      );
      expect(submitted).toMatchObject({ status: 'pending_approval', requiredApprovals: 2 });
      const procurementApproval = await prisma.approvalRequest.findFirstOrThrow({
        where: { scope: 'procurement', targetId: order.id },
      });
      expect(procurementApproval.requestedByUserId).toBe(team.buyer.id);
      expect(
        (
          await prisma.workItem.findMany({
            where: { objectType: 'approval_request', objectId: procurementApproval.id },
            select: { ownerUserId: true },
          })
        )
          .map((item) => item.ownerUserId)
          .sort()
      ).toEqual([team.approver.id, team.director.id].sort());

      // Nobody signs what they asked for, and one signature is not enough.
      expectStatus(
        await decideApproval(team.buyer, {
          approvalRequestId: procurementApproval.id,
          decision: 'approve',
        }),
        'rejected'
      );
      ok(
        await decideApproval(team.approver, {
          approvalRequestId: procurementApproval.id,
          decision: 'approve',
        })
      );
      expect(
        (await prisma.procurementOrder.findUniqueOrThrow({ where: { id: order.id } })).status
      ).toBe('pending_approval');
      ok(
        await decideApproval(team.director, {
          approvalRequestId: procurementApproval.id,
          decision: 'approve',
        })
      );
      expect(
        (await prisma.procurementOrder.findUniqueOrThrow({ where: { id: order.id } })).status
      ).toBe('approved');

      // 3. Payment: the follow-up job registers the payable and asks Contabilidad to authorize it.
      expect((await drainAllOk()).map((run) => run.type)).toContain('purchases.order_followup');
      const obligation = await prisma.obligation.findFirstOrThrow({
        where: { procurementOrderId: order.id },
      });
      expect(obligation).toMatchObject({
        kind: 'payable',
        counterpartyType: 'supplier',
        status: 'expected',
        caseId: opCase.id,
      });
      expect(num(obligation.expectedAmount)).toBe(69_600);
      const paymentApproval = await prisma.approvalRequest.findFirstOrThrow({
        where: { scope: 'payment', targetId: obligation.id },
      });
      expect(paymentApproval).toMatchObject({ status: 'pending', requiredApprovals: 2 });

      const bank = await prisma.cashAccount.findFirstOrThrow({ where: { key: 'banco_zoho' } });
      // Money never moves before the authorization is complete.
      expect(
        await settleObligation(team.accountant, {
          obligationId: obligation.id,
          amount: '69600',
          cashAccountId: bank.id,
        })
      ).toMatchObject({ status: 'rejected', errorCode: 'payment_not_authorized' });
      ok(
        await decideApproval(team.treasurer, {
          approvalRequestId: paymentApproval.id,
          decision: 'approve',
        })
      );
      expect(
        await settleObligation(team.accountant, {
          obligationId: obligation.id,
          amount: '69600',
          cashAccountId: bank.id,
        })
      ).toMatchObject({ status: 'rejected', errorCode: 'payment_not_authorized' });
      ok(
        await decideApproval(team.treasuryDirector, {
          approvalRequestId: paymentApproval.id,
          decision: 'approve',
        })
      );
      const settled = ok(
        await settleObligation(team.accountant, {
          obligationId: obligation.id,
          amount: '69600',
          cashAccountId: bank.id,
        })
      );
      expect(settled).toMatchObject({ status: 'settled' });
      expect(
        await prisma.procurementOrder.findUniqueOrThrow({ where: { id: order.id } })
      ).toMatchObject({ paymentStatus: 'paid' });
      expect(
        num((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).currentBalance)
      ).toBe(-69_600);
      await expectLedgerBalanced();

      // 4. Partial receipt with a damaged piece: only the good material enters and is reserved.
      const orderLine = await prisma.procurementOrderLine.findFirstOrThrow({
        where: { orderId: order.id },
      });
      const first = ok(
        await purchases.recordGoodsReceipt(team.receiver, {
          orderId: order.id,
          lines: [{ orderLineId: orderLine.id, qtyReceived: 3, qtyRejected: 1 }],
        })
      );
      expect(first.posted).toMatchObject({ status: 'disputed', orderStatus: 'disputed' });
      expect(first.posted?.reservations).toEqual([
        expect.objectContaining({ allocationId: allocation.id, quantity: '2' }),
      ]);
      expect(
        await prisma.incident.findFirstOrThrow({ where: { kind: 'purchase_difference' } })
      ).toMatchObject({ areaKey: 'compras', status: 'open' });
      expect(
        await prisma.areaRequest.findFirstOrThrow({ where: { kind: 'resolve_difference' } })
      ).toMatchObject({ fromAreaKey: 'inventario', toAreaKey: 'compras' });
      expect((await stepOf(opCase.id, 'esperar_recepcion', allocation.id)).status).toBe('waiting');
      await expectStockInvariants();

      const receiptLine = await prisma.goodsReceiptLine.findFirstOrThrow({
        where: { orderLineId: orderLine.id, differenceKind: { not: 'none' } },
      });
      expect(
        ok(
          await purchases.resolveReceiptDifference(team.buyer, {
            receiptLineId: receiptLine.id,
            resolution: 'replacement',
            note: 'El proveedor repone la pieza dañada',
          })
        )
      ).toMatchObject({ orderStatus: 'partially_received' });
      expect(
        (await prisma.incident.findFirstOrThrow({ where: { kind: 'purchase_difference' } })).status
      ).toBe('resolved');

      // 5. The replacement completes the allocation: reserved, request resolved, case advanced.
      const second = ok(
        await purchases.recordGoodsReceipt(team.receiver, {
          orderId: order.id,
          lines: [{ orderLineId: orderLine.id, qtyReceived: 2 }],
        })
      );
      expect(second.posted).toMatchObject({
        status: 'posted',
        orderStatus: 'received',
        readyAllocationIds: [allocation.id],
      });
      expect(
        await prisma.demandAllocation.findUniqueOrThrow({ where: { id: allocation.id } })
      ).toMatchObject({ status: 'ready' });
      const reserved = await prisma.stockReservation.findMany({
        where: { allocationId: allocation.id, status: 'active' },
      });
      expect(reserved.reduce((total, row) => total + num(row.quantity), 0)).toBe(4);
      expect(
        (await prisma.areaRequest.findUniqueOrThrow({ where: { id: request.id } })).status
      ).toBe('resolved');
      expect(
        (await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: purchaseRequest.id } }))
          .status
      ).toBe('closed');
      await expectStockInvariants();

      expect(await eventTypes({ caseId: opCase.id })).toEqual(
        expect.arrayContaining([
          'purchases.request.created',
          'purchases.order.created',
          'purchases.order.submitted',
          'purchases.order.approved',
          'purchases.order.payment_requested',
          'purchases.order.paid',
          'purchases.receipt.difference',
          'purchases.receipt.posted',
          'allocation.ready',
        ])
      );

      await drainAllOk();
      ok(await advanceCaseCommand(opCase.id, { commandId: `it-advance-${randomUUID()}` }));
      expect((await stepOf(opCase.id, 'esperar_recepcion', allocation.id)).status).toBe('done');
      expect((await stepOf(opCase.id, 'preparar_pedido')).status).toBe('ready');
      // The whole chain ran with the AI provider failing on every call.
      expect(mocks.chatCompletion).not.toHaveBeenCalled();
    });

    it('entrega directa del proveedor: sin movimiento de inventario, entrega registrada en logística y expediente avanzado', async () => {
      const { team } = base;
      const { opCase, allocation, request } = await caseWithAllocation({
        zohoItemId: 'it-item-tabla',
        stock: 0,
        quantity: 10,
        source: 'direct_supplier',
      });
      expect(request).toMatchObject({ kind: 'direct_delivery', toAreaKey: 'compras' });
      await drainAllOk();
      const requestLine = await prisma.purchaseRequestLine.findFirstOrThrow({
        where: { allocationId: allocation.id },
      });

      const supplier = ok(
        await purchases.createSupplier(team.buyer, { name: 'Fábrica Norte', paymentMode: 'credit' })
      ).supplier;
      const order = ok(
        await purchases.createProcurementOrder(team.buyer, {
          supplierId: supplier.id,
          deliveryMode: 'direct_to_customer',
          directDeliveryCaseId: opCase.id,
          lines: [{ requestLineId: requestLine.id, qty: 10, unitPrice: 80 }],
        })
      ).order;
      expect(
        await prisma.procurementOrder.findUniqueOrThrow({ where: { id: order.id } })
      ).toMatchObject({ deliveryMode: 'direct_to_customer', warehouseId: null });

      ok(await purchases.submitProcurementOrder(team.buyer, { orderId: order.id }));
      const approval = await prisma.approvalRequest.findFirstOrThrow({
        where: { scope: 'procurement', targetId: order.id },
      });
      expect(approval.requiredApprovals).toBe(1);
      ok(
        await decideApproval(team.approver, { approvalRequestId: approval.id, decision: 'approve' })
      );
      await drainAllOk();

      const orderLine = await prisma.procurementOrderLine.findFirstOrThrow({
        where: { orderId: order.id },
      });
      // A warehouse receipt is refused for a direct delivery order.
      expect(
        await purchases.recordGoodsReceipt(team.receiver, {
          orderId: order.id,
          lines: [{ orderLineId: orderLine.id, qtyReceived: 10 }],
        })
      ).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

      const foreignPhoto = await uploadEvidence(team.buyer.id);
      expect(
        await purchases.confirmDirectDelivery(team.receiver, {
          orderId: order.id,
          lines: [{ orderLineId: orderLine.id, qtyDelivered: 10 }],
          receivedBy: 'Residente de obra',
          evidenceObjectIds: [foreignPhoto],
        })
      ).toMatchObject({ status: 'rejected', errorCode: 'evidence_invalid' });

      const photo = await uploadEvidence(team.receiver.id);
      const confirmed = ok(
        await purchases.confirmDirectDelivery(team.receiver, {
          orderId: order.id,
          lines: [{ orderLineId: orderLine.id, qtyDelivered: 10 }],
          receivedBy: 'Residente de obra',
          evidenceObjectIds: [photo],
        })
      );
      expect(confirmed).toMatchObject({ orderStatus: 'received', syncQueued: true });
      expect(await prisma.stockMovement.count()).toBe(0);

      expect((await drainAllOk()).map((run) => run.type)).toContain(
        'purchases.direct_delivery_sync'
      );
      const deliveryOrder = await prisma.deliveryOrder.findFirstOrThrow({
        where: { caseId: opCase.id },
      });
      expect(deliveryOrder).toMatchObject({
        mode: 'direct_supplier',
        status: 'delivered',
        receivedBy: 'Residente de obra',
        allocationIds: [allocation.id],
      });
      expect(
        await prisma.deliveryEvidence.findFirstOrThrow({ where: { storageObjectId: photo } })
      ).toMatchObject({ kind: 'photo', deliveryOrderId: deliveryOrder.id });
      expect(
        await prisma.demandAllocation.findUniqueOrThrow({ where: { id: allocation.id } })
      ).toMatchObject({ status: 'delivered' });
      expect(await prisma.stockMovement.count()).toBe(0);
      await expectStockInvariants();
    });

    it('proveedor retrasado: lo esperado nunca cuenta como disponible y la orden aparece vencida', async () => {
      const { team } = base;
      const { allocation } = await caseWithAllocation({
        zohoItemId: 'it-item-perfil',
        stock: 0,
        quantity: 8,
        source: 'purchase',
      });
      await drainAllOk();
      const requestLine = await prisma.purchaseRequestLine.findFirstOrThrow({
        where: { allocationId: allocation.id },
      });
      const supplier = ok(
        await purchases.createSupplier(team.buyer, {
          name: 'Perfiles del Golfo',
          paymentMode: 'credit',
        })
      ).supplier;
      const expectedAt = new Date(Date.now() + 3 * 86_400_000);
      const order = ok(
        await purchases.createProcurementOrder(team.buyer, {
          supplierId: supplier.id,
          expectedAt: expectedAt.toISOString().slice(0, 10),
          lines: [{ requestLineId: requestLine.id, qty: 8, unitPrice: 200 }],
        })
      ).order;
      ok(await purchases.submitProcurementOrder(team.buyer, { orderId: order.id }));
      const approval = await prisma.approvalRequest.findFirstOrThrow({
        where: { scope: 'procurement', targetId: order.id },
      });
      ok(
        await decideApproval(team.approver, { approvalRequestId: approval.id, decision: 'approve' })
      );
      await drainAllOk();

      // Committed but not delivered: the shelf stays at zero, so nobody can promise it.
      const availability = await verifyAvailability(prisma as never, {
        zohoItemId: 'it-item-perfil',
        warehouseId: base.warehouseId,
      });
      expect(num(availability.available)).toBe(0);
      const committed = await prisma.demandAllocation.findUniqueOrThrow({
        where: { id: allocation.id },
      });
      expect(committed.status).toBe('in_progress');
      expect(committed.expectedAt?.toISOString().slice(0, 10)).toBe(
        expectedAt.toISOString().slice(0, 10)
      );

      // On time today, late the day after the promise: the same row, read at two instants.
      expect(
        await listExpectedSupply(team.buyer, {
          zohoItemId: 'it-item-perfil',
          now: new Date(),
        })
      ).toEqual([expect.objectContaining({ expectedQty: '8', overdue: false })]);
      const late = await listExpectedSupply(team.buyer, {
        zohoItemId: 'it-item-perfil',
        now: new Date(expectedAt.getTime() + 2 * 86_400_000),
      });
      expect(late).toEqual([
        expect.objectContaining({ orderNumber: order.number, expectedQty: '8', overdue: true }),
      ]);
      // Existencias lee una página completa de una sola consulta (`zohoItemIds`):
      // la misma línea, y nada para un artículo que no compró nadie.
      expect(
        await listExpectedSupply(team.buyer, {
          zohoItemIds: ['it-item-perfil', 'it-item-que-no-existe'],
          now: new Date(),
        })
      ).toEqual([expect.objectContaining({ zohoItemId: 'it-item-perfil', expectedQty: '8' })]);
      expect(await listExpectedSupply(team.buyer, { zohoItemIds: [] })).toEqual([]);
      // A late supplier does not invent stock: the case keeps waiting for the receipt.
      expect((await stepOf(allocation.caseId!, 'esperar_recepcion', allocation.id)).status).toBe(
        'waiting'
      );
      await expectStockInvariants();
    });

    /**
     * Plan 5.4: «si quien aprueba la propuesta de IA cumple la política, esa decisión se registra
     * también como primera firma de negocio para no pedir dos clics por lo mismo».
     *
     * Contra Postgres de verdad porque el punto que ninguna prueba con FakePrisma puede ver es el
     * empalme: la firma viaja por contexto asíncrono desde `approveProposal` hasta
     * `requestApproval`, atravesando `executeTool`, el motor de comandos y la transacción
     * interactiva de Prisma. Si ese contexto no sobreviviera, la orden quedaría esperando firmas
     * ajenas y aquí se vería.
     */
    it('propuesta de IA aprobada: esa decisión queda como la primera firma de la orden que abrió', async () => {
      const { team } = base;
      const { createProposal, approveProposal } =
        await import('@/modules/extensions/proposals-service');
      const { getToolDefinition } = await import('@/modules/ai/tools/registry');
      await import('@/modules/ai/tools/procurement-tools');
      const tool = getToolDefinition('submitProcurementOrder');
      if (!tool) throw new Error('submitProcurementOrder no está registrada');

      // Quien decide la tarjeta cumple la política de Compras (`purchases.approve`) y además
      // puede enviar la orden, que es lo que la herramienta hace.
      const jefa = await seedUser('it_compras_jefa', 'Jefa de compras', [
        ...VIEW,
        'purchases.view',
        'purchases.manage_orders',
        'purchases.manage_suppliers',
        'purchases.approve',
      ]);
      const supplier = ok(
        await purchases.createSupplier(jefa, {
          name: 'Tornillos del Norte',
          paymentMode: 'prepaid',
        })
      ).supplier;
      const order = ok(
        await purchases.createProcurementOrder(jefa, {
          supplierId: supplier.id,
          lines: [
            { description: 'Tornillo 1/4', unit: 'pz', qty: 10, unitPrice: 100, taxRate: 0.16 },
          ],
        })
      ).order;
      expect(order).toMatchObject({ status: 'draft', total: '1160' });

      const args = { orderId: order.id };
      const proposal = await createProposal({
        actor: jefa,
        tool,
        args,
        summary: `Enviar a aprobación la orden ${order.number}`,
        approverScope: { areaKey: 'compras', userIds: [jefa.id] },
      });

      const { execution } = await approveProposal(jefa, proposal.id);
      expect(execution).toMatchObject({ success: true });

      const approval = await prisma.approvalRequest.findFirstOrThrow({
        where: { scope: 'procurement', targetId: order.id },
      });
      expect(approval.requestedByUserId).toBe(jefa.id);
      expect(approval.requiredApprovals).toBe(1);
      expect(approval.status).toBe('approved');
      expect(approval.decisions).toMatchObject([{ userId: jefa.id, decision: 'approve' }]);
      // Nadie más tuvo que firmar: no se abrió ningún trabajo de aprobación.
      expect(
        await prisma.workItem.count({
          where: { objectType: 'approval_request', objectId: approval.id },
        })
      ).toBe(0);
      expect(
        (await prisma.procurementOrder.findUniqueOrThrow({ where: { id: order.id } })).status
      ).toBe('approved');

      // La compradora NO cumple la política (no tiene `purchases.approve`): su clic no firma nada
      // y la orden espera a quien sí puede.
      const other = ok(
        await purchases.createProcurementOrder(team.buyer, {
          supplierId: supplier.id,
          lines: [
            { description: 'Tuerca 1/4', unit: 'pz', qty: 10, unitPrice: 100, taxRate: 0.16 },
          ],
        })
      ).order;
      const otherProposal = await createProposal({
        actor: team.buyer,
        tool,
        args: { orderId: other.id },
        summary: `Enviar a aprobación la orden ${other.number}`,
        approverScope: { areaKey: 'compras', userIds: [team.buyer.id] },
      });
      expect((await approveProposal(team.buyer, otherProposal.id)).execution).toMatchObject({
        success: true,
      });
      const pending = await prisma.approvalRequest.findFirstOrThrow({
        where: { scope: 'procurement', targetId: other.id },
      });
      expect(pending.status).toBe('pending');
      expect(pending.decisions).toEqual([]);
      expect(
        (
          await prisma.workItem.findMany({
            where: { objectType: 'approval_request', objectId: pending.id },
            select: { ownerUserId: true },
          })
        )
          .map((item) => item.ownerUserId)
          .sort()
      ).toEqual([jefa.id, team.approver.id, team.director.id].sort());
    });

    // -------------------------------------------------------------------------
    // 6.2 Manufactura
    // -------------------------------------------------------------------------

    it('transformación con merma dentro de la tolerancia: producción cuadrada y liberada para la venta', async () => {
      const { team } = base;
      await seedControlledStock('it-lamina', 200);
      const { opCase, allocation, request } = await caseWithAllocation({
        zohoItemId: 'it-placa',
        stock: 0,
        quantity: 100,
        source: 'manufacture',
      });
      expect(request).toMatchObject({ kind: 'transformation', toAreaKey: 'manufactura' });

      const created = ok(
        await createTransformationOrder(team.planner, {
          demandAllocationId: allocation.id,
          inputs: [{ zohoItemId: 'it-lamina', qty: 105, unit: 'pz' }],
          scrapAllowancePct: 5,
          workCenterId: base.workCenterId,
          reserveNow: true,
        })
      );
      const orderId = created.productionOrderId;
      expect(created).toMatchObject({ kind: 'transformation', status: 'reserved' });
      expect(created.materials).toMatchObject({ complete: true });
      const laminaStock = await prisma.stockItem.findFirstOrThrow({
        where: { zohoItemId: 'it-lamina' },
      });
      expect(num(laminaStock.assignedToProduction)).toBe(105);

      ok(await prepareProductionOrder(team.planner, { productionOrderId: orderId }));
      const started = ok(await startOperation(team.operator, { productionOrderId: orderId }));
      expect(started).toMatchObject({ orderStatus: 'in_progress' });
      expect(
        await prisma.demandAllocation.findUniqueOrThrow({ where: { id: allocation.id } })
      ).toMatchObject({ status: 'in_progress' });

      ok(
        await recordConsumption(team.operator, {
          productionOrderId: orderId,
          lines: [{ zohoItemId: 'it-lamina', qty: 104, unit: 'pz' }],
        })
      );
      ok(
        await finishOperation(team.operator, {
          productionOrderId: orderId,
          operationId: started.operationId,
        })
      );
      const scrap = ok(
        await recordOutput(team.operator, {
          productionOrderId: orderId,
          kind: 'scrap',
          qty: 4,
          unit: 'pz',
          reason: 'Recortes',
        })
      );
      expect(scrap.scrap).toMatchObject({ exceeded: false, pending: false });
      expect(await prisma.approvalRequest.count({ where: { scope: 'production_incident' } })).toBe(
        0
      );

      // Nothing leaves the floor before quality signs it.
      expect(
        await recordOutput(team.operator, {
          productionOrderId: orderId,
          kind: 'finished',
          qty: 100,
        })
      ).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
      ok(
        await inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' })
      );
      const output = ok(
        await recordOutput(team.operator, {
          productionOrderId: orderId,
          kind: 'finished',
          qty: 100,
          unit: 'pz',
        })
      );
      expect(
        await prisma.stockItem.findUniqueOrThrow({ where: { id: output.stockItemId } })
      ).toMatchObject({ zohoItemId: 'it-placa', originProductionOrderId: orderId });

      const released = ok(
        await releaseProductionOrder(team.planner, { productionOrderId: orderId })
      );
      expect(released).toMatchObject({ released: true, status: 'released' });
      expect(
        num(
          (await prisma.stockItem.findUniqueOrThrow({ where: { id: laminaStock.id } }))
            .assignedToProduction
        )
      ).toBe(0);
      expect(
        await prisma.demandAllocation.findUniqueOrThrow({ where: { id: allocation.id } })
      ).toMatchObject({ status: 'ready', stockReservationId: released.reservationId });
      expect(
        (await prisma.areaRequest.findUniqueOrThrow({ where: { id: request.id } })).status
      ).toBe('resolved');

      // Produced + consumed + leftover + scrap add up and trace back to the raw material.
      const detail = await getProductionOrderDetail(team.byArea.manufactura, orderId);
      expect(detail.balance).toMatchObject({ comparable: true, balanced: true, unaccounted: 0 });
      expect(detail.materials[0]).toMatchObject({ required: '105', consumed: '104', scrap: '4' });
      expect(await eventTypes({ caseId: opCase.id })).toEqual(
        expect.arrayContaining(['production.started', 'production.finished', 'allocation.ready'])
      );
      await expectStockInvariants();
    });

    it('transformación con merma fuera de la tolerancia: aprobación e incidencia antes de poder liberar', async () => {
      const { team } = base;
      await seedControlledStock('it-lamina', 200);
      const { opCase, allocation } = await caseWithAllocation({
        zohoItemId: 'it-placa',
        stock: 0,
        quantity: 90,
        source: 'manufacture',
      });
      const orderId = ok(
        await createTransformationOrder(team.planner, {
          demandAllocationId: allocation.id,
          inputs: [{ zohoItemId: 'it-lamina', qty: 105, unit: 'pz' }],
          scrapAllowancePct: 5,
          workCenterId: base.workCenterId,
          reserveNow: true,
        })
      ).productionOrderId;
      ok(await prepareProductionOrder(team.planner, { productionOrderId: orderId }));
      const started = ok(await startOperation(team.operator, { productionOrderId: orderId }));
      ok(
        await recordConsumption(team.operator, {
          productionOrderId: orderId,
          lines: [{ zohoItemId: 'it-lamina', qty: 105, unit: 'pz' }],
        })
      );
      ok(
        await finishOperation(team.operator, {
          productionOrderId: orderId,
          operationId: started.operationId,
        })
      );

      const scrap = ok(
        await recordOutput(team.operator, {
          productionOrderId: orderId,
          kind: 'scrap',
          qty: 10,
          unit: 'pz',
          reason: 'Lámina astillada',
        })
      );
      expect(scrap.scrap).toMatchObject({ exceeded: true, approvalStatus: 'pending' });
      const approval = await prisma.approvalRequest.findFirstOrThrow({
        where: { scope: 'production_incident', targetId: orderId },
      });
      expect(approval).toMatchObject({
        targetType: 'production_order_scrap',
        status: 'pending',
        requestedByUserId: team.operator.id,
        caseId: opCase.id,
      });
      expect(
        (
          await prisma.workItem.findMany({
            where: { objectType: 'approval_request', objectId: approval.id },
            select: { ownerUserId: true },
          })
        ).map((item) => item.ownerUserId)
      ).toEqual([team.plantChief.id]);
      expect(
        await prisma.incident.findFirstOrThrow({ where: { kind: 'excess_scrap' } })
      ).toMatchObject({ status: 'open', caseId: opCase.id });

      ok(
        await inspectProductionOrder(team.inspector, { productionOrderId: orderId, result: 'pass' })
      );
      // 105 consumed = 90 finished + 10 scrap + 5 sellable leftover (the balance must close).
      const leftover = ok(
        await recordOutput(team.operator, {
          productionOrderId: orderId,
          kind: 'leftover',
          qty: 5,
          unit: 'pz',
          dimensions: { largo: 1, ancho: 5, unidad: 'm' },
        })
      );
      expect(
        await prisma.stockItem.findUniqueOrThrow({ where: { id: leftover.stockItemId } })
      ).toMatchObject({ originProductionOrderId: orderId });
      ok(
        await recordOutput(team.operator, {
          productionOrderId: orderId,
          kind: 'finished',
          qty: 90,
          unit: 'pz',
        })
      );
      const blocked = await releaseProductionOrder(team.planner, { productionOrderId: orderId });
      expect(blocked).toMatchObject({ status: 'rejected', errorCode: 'release_blocked' });
      expect(
        await prisma.demandAllocation.findUniqueOrThrow({ where: { id: allocation.id } })
      ).not.toMatchObject({ status: 'ready' });

      ok(
        await decideApproval(team.plantChief, {
          approvalRequestId: approval.id,
          decision: 'approve',
        })
      );
      expect(
        ok(await releaseProductionOrder(team.planner, { productionOrderId: orderId })).released
      ).toBe(true);
      expect(
        await prisma.demandAllocation.findUniqueOrThrow({ where: { id: allocation.id } })
      ).toMatchObject({ status: 'ready' });
      expect(await eventTypes({ caseId: opCase.id })).toEqual(
        expect.arrayContaining(['production.scrap_approved'])
      );
      await expectStockInvariants();
    });

    // -------------------------------------------------------------------------
    // 6.4 Contabilidad interna
    // -------------------------------------------------------------------------

    it('gasto duplicado: se detecta contra el ya contabilizado, se resuelve, se aprueba y se contabiliza', async () => {
      const { team } = base;
      const fuel = await prisma.financeCategory.findFirstOrThrow({ where: { key: 'combustible' } });
      const center = await prisma.costCenter.findFirstOrThrow({ where: { key: 'cc_logistica' } });
      const caja = await prisma.cashAccount.findFirstOrThrow({ where: { key: 'caja_general' } });
      const dateKey = new Date().toISOString().slice(0, 10);
      const fields = {
        captureMode: 'form' as const,
        amount: '2500',
        date: dateKey,
        supplierNameFree: 'Gasolinera Pemex del Valle',
        categoryId: fuel.id,
        costCenterId: center.id,
        paymentMethod: 'cash' as const,
        isPaid: true,
        description: 'Diésel de reparto',
      };

      // The original: above the auto-approval threshold, so it needs one signature.
      const original = ok(await captureExpense(team.capturer, fields));
      expect(original).toMatchObject({ status: 'draft', duplicateStatus: 'none' });
      const originalSubmit = ok(
        await submitExpense(team.capturer, { expenseId: original.expenseId })
      );
      expect(originalSubmit).toMatchObject({ autoApproved: false, requiredApprovals: 1 });
      ok(
        await decideApproval(team.treasurer, {
          approvalRequestId: originalSubmit.approvalRequestId!,
          decision: 'approve',
        })
      );
      ok(
        await postExpense(team.accountant, {
          expenseId: original.expenseId,
          cashAccountId: caja.id,
        })
      );
      expect(
        await prisma.expense.findUniqueOrThrow({ where: { id: original.expenseId } })
      ).toMatchObject({ status: 'posted' });

      // The same ticket captured again is suspected against the posted one.
      const copy = ok(await captureExpense(team.capturer, fields));
      expect(copy).toMatchObject({ duplicateStatus: 'suspect', duplicateOfId: original.expenseId });
      expect(await eventTypes({ type: 'finance.expense.duplicate_suspected' })).toHaveLength(1);
      expect(await submitExpense(team.capturer, { expenseId: copy.expenseId })).toMatchObject({
        status: 'rejected',
        errorCode: 'duplicate_unresolved',
      });

      // Confirmed as a duplicate: it is rejected and never reaches the ledger.
      ok(
        await resolveExpenseDuplicate(team.capturer, {
          expenseId: copy.expenseId,
          decision: 'duplicate',
          duplicateOfId: original.expenseId,
        })
      );
      const rejected = await prisma.expense.findUniqueOrThrow({ where: { id: copy.expenseId } });
      expect(rejected).toMatchObject({
        status: 'rejected',
        duplicateStatus: 'confirmed_duplicate',
        duplicateOfId: original.expenseId,
      });
      expect(rejected.rejectedReason).toContain(
        (await prisma.expense.findUniqueOrThrow({ where: { id: original.expenseId } })).number
      );

      // A genuinely different charge of the same day and supplier is resolved as unique and posted.
      const second = ok(
        await captureExpense(team.capturer, {
          ...fields,
          amount: '2512',
          description: 'Gasolina de la camioneta 2',
        })
      );
      expect(second.duplicateStatus).toBe('suspect');
      ok(
        await resolveExpenseDuplicate(team.capturer, {
          expenseId: second.expenseId,
          decision: 'unique',
        })
      );
      const submitted = ok(await submitExpense(team.capturer, { expenseId: second.expenseId }));
      expect(
        await decideApproval(team.capturer, {
          approvalRequestId: submitted.approvalRequestId!,
          decision: 'approve',
        })
      ).toMatchObject({ status: 'rejected', errorCode: 'self_approval' });
      ok(
        await decideApproval(team.treasurer, {
          approvalRequestId: submitted.approvalRequestId!,
          decision: 'approve',
        })
      );
      const posted = ok(
        await postExpense(team.accountant, { expenseId: second.expenseId, cashAccountId: caja.id })
      );
      expect(posted).toMatchObject({ status: 'posted', obligationId: null });
      const lines = await prisma.ledgerLine.findMany({
        where: { entryId: posted.ledgerEntryId! },
        orderBy: { seq: 'asc' },
      });
      expect(lines.map((line) => [line.accountType, num(line.debit), num(line.credit)])).toEqual([
        ['category', 2512, 0],
        ['cash', 0, 2512],
      ]);
      expect(
        num((await prisma.cashAccount.findUniqueOrThrow({ where: { id: caja.id } })).currentBalance)
      ).toBe(-(2500 + 2512));
      await expectLedgerBalanced();
      // Two expenses posted, one rejected: the rejected one produced no entry.
      expect(await prisma.ledgerEntry.count({ where: { sourceType: 'expense' } })).toBe(2);
      // The proposal never ran the model (form capture) and the AI stayed down all along.
      expect(mocks.chatCompletion).not.toHaveBeenCalled();
    });

    it('conciliación: un pago de Zoho se reparte entre dos obligaciones esperadas y no se aplica dos veces', async () => {
      const zohoContactId = 'it-cli-1';
      await prisma.contact.create({
        data: {
          zohoContactId,
          contactName: 'Constructora Río',
          contactType: 'customer',
          status: 'active',
          paymentTerms: 15,
          sourceRemoteModifiedAt: new Date(),
          sourceSnapshotId: 'it-contact-snapshot',
        },
      });
      await seedControlledStock('it-item-cobro', 50);
      const first = await seedSalesOrder([{ zohoItemId: 'it-item-cobro', quantity: 1 }], {
        zohoCustomerId: zohoContactId,
        customerName: 'Constructora Río',
        total: new Prisma.Decimal(3000),
        currencyCode: 'MXN',
      });
      const second = await seedSalesOrder([{ zohoItemId: 'it-item-cobro', quantity: 1 }], {
        zohoCustomerId: zohoContactId,
        customerName: 'Constructora Río',
        total: new Prisma.Decimal(2000),
        currencyCode: 'MXN',
      });

      // Starting the case expects its receivable through the finance case listener.
      const caseOne = await startCaseViaJob(first);
      const caseTwo = await startCaseViaJob(second);
      const receivableOne = await prisma.obligation.findFirstOrThrow({
        where: { kind: 'receivable', caseId: caseOne.id },
      });
      const receivableTwo = await prisma.obligation.findFirstOrThrow({
        where: { kind: 'receivable', caseId: caseTwo.id },
      });
      expect(receivableOne).toMatchObject({
        counterpartyType: 'customer',
        zohoContactId,
        status: 'expected',
      });
      expect([num(receivableOne.expectedAmount), num(receivableTwo.expectedAmount)]).toEqual([
        3000, 2000,
      ]);
      await expectLedgerBalanced();

      await prisma.customerPayment.create({
        data: {
          zohoPaymentId: 'it-pay-1',
          paymentNumber: 'PAGO-IT-77',
          amount: new Prisma.Decimal(5000),
          zohoCustomerId: zohoContactId,
          customerName: 'Constructora Río',
          date: new Date(new Date().toISOString().slice(0, 10)),
          currencyCode: 'MXN',
          sourceRemoteModifiedAt: new Date(),
          sourceSnapshotId: 'it-pay-snapshot',
        },
      });

      const summary = await reconcileCollections({});
      expect(summary).toMatchObject({
        payments: 1,
        matched: 1,
        settlements: 2,
        flagged: 0,
        errors: 0,
      });
      const settlements = await prisma.obligationSettlement.findMany({
        where: { zohoPaymentId: 'it-pay-1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        settlements.map((row) => [row.obligationId, num(row.amount), row.externalRef]).sort()
      ).toEqual(
        [
          [receivableOne.id, 3000, `zoho_payment:it-pay-1:${receivableOne.id}`],
          [receivableTwo.id, 2000, `zoho_payment:it-pay-1:${receivableTwo.id}`],
        ].sort()
      );
      expect(
        (
          await prisma.obligation.findMany({
            where: { id: { in: [receivableOne.id, receivableTwo.id] } },
            select: { status: true },
          })
        ).map((row) => row.status)
      ).toEqual(['settled', 'settled']);
      const bank = await prisma.cashAccount.findFirstOrThrow({ where: { key: 'banco_zoho' } });
      expect(
        num((await prisma.cashAccount.findUniqueOrThrow({ where: { id: bank.id } })).currentBalance)
      ).toBe(5000);
      await expectLedgerBalanced();

      // A second pass finds nothing new: `externalRef` is a real unique key.
      expect(await reconcileCollections({})).toMatchObject({ payments: 0, settlements: 0 });
      expect(
        await prisma.obligationSettlement.count({ where: { zohoPaymentId: 'it-pay-1' } })
      ).toBe(2);
      await expect(
        prisma.obligationSettlement.create({
          data: {
            obligationId: receivableOne.id,
            ledgerEntryId: settlements[0].ledgerEntryId,
            amount: new Prisma.Decimal(1),
            externalRef: `zoho_payment:it-pay-1:${receivableOne.id}`,
            createdByUserId: base.team.accountant.id,
          },
        })
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('IA caída: la propuesta del gasto degrada a reglas y el motor sigue hasta el asiento', async () => {
      const { team } = base;
      const freight = await prisma.financeCategory.findFirstOrThrow({ where: { key: 'fletes' } });
      const center = await prisma.costCenter.findFirstOrThrow({ where: { key: 'cc_logistica' } });
      const caja = await prisma.cashAccount.findFirstOrThrow({ where: { key: 'caja_general' } });
      // Two posted charges of the same supplier: the history the rules classify from.
      for (const [suffix, daysAgo] of [
        ['9001', 20],
        ['9002', 8],
      ] as const) {
        await prisma.expense.create({
          data: {
            number: `GX-IT${suffix}`,
            status: 'posted',
            amount: new Prisma.Decimal(900),
            date: new Date(new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)),
            supplierNameFree: 'Fletes Rápidos',
            categoryId: freight.id,
            costCenterId: center.id,
            createdByUserId: team.accountant.id,
          },
        });
      }

      const captured = ok(
        await captureExpense(team.capturer, {
          captureMode: 'text',
          rawInput: 'Pago de maniobra de descarga',
          supplierNameFree: 'FLETES RAPIDOS',
          amount: '1500',
          date: new Date().toISOString().slice(0, 10),
        })
      );
      expect(captured.proposalQueued).toBe(true);
      const proposalJob = await prisma.backgroundJob.findFirstOrThrow({
        where: { type: 'finance.expense_propose' },
      });
      expect(proposalJob.payload).toMatchObject({ expenseId: captured.expenseId });

      // The model is down: the proposal degrades to the rules and records why.
      const proposal = await runExpenseProposeJob({ payload: { expenseId: captured.expenseId } });
      expect(mocks.chatCompletion).toHaveBeenCalled();
      expect(proposal).toMatchObject({
        status: 'applied',
        source: 'rules',
        error: 'proveedor de IA no disponible en pruebas',
      });
      const classified = await prisma.expense.findUniqueOrThrow({
        where: { id: captured.expenseId },
      });
      expect(classified).toMatchObject({
        status: 'draft',
        categoryId: freight.id,
        costCenterId: center.id,
      });
      expect(classified.aiProposal).toMatchObject({ source: 'rules' });

      // And the engine finishes the expense without the model ever answering
      // (1,500 MXN is under the auto-approval threshold, so no signature is needed).
      const submitted = ok(await submitExpense(team.capturer, { expenseId: captured.expenseId }));
      expect(submitted).toMatchObject({
        submitted: true,
        autoApproved: true,
        requiredApprovals: 0,
        status: 'approved',
      });
      const posted = ok(
        await postExpense(team.accountant, {
          expenseId: captured.expenseId,
          cashAccountId: caja.id,
        })
      );
      expect(posted).toMatchObject({ status: 'posted' });
      expect(
        num((await prisma.cashAccount.findUniqueOrThrow({ where: { id: caja.id } })).currentBalance)
      ).toBe(-1500);
      await expectLedgerBalanced();
    });

    // -------------------------------------------------------------------------
    // 6.5 Ventas / CRM
    // -------------------------------------------------------------------------

    it('cotización aceptada → orden de venta en Zoho (mock) → un solo expediente aunque se reintente', async () => {
      const { team } = base;
      const previousMock = process.env.ZOHO_BOOKS_MOCK;
      process.env.ZOHO_BOOKS_MOCK = 'true';
      try {
        await seedControlledStock('it-item-porcelanato', 50);
        const quote = await prisma.quote.create({
          data: {
            zohoEstimateId: 'it-est-1',
            estimateNumber: 'it-COT-00042',
            status: 'accepted',
            date: new Date(new Date().toISOString().slice(0, 10)),
            zohoCustomerId: 'it-cli-9',
            customerName: 'Constructora Norte',
            currencyCode: 'MXN',
            subTotal: new Prisma.Decimal(4800),
            taxTotal: new Prisma.Decimal(768),
            total: new Prisma.Decimal(5568),
            sourceRemoteModifiedAt: new Date(),
            sourceSnapshotId: 'it-quote-snapshot',
            items: {
              create: [
                {
                  zohoItemId: 'it-item-porcelanato',
                  sku: 'IT-ITEM-PORCELANATO',
                  name: 'Porcelanato 60x60',
                  quantity: new Prisma.Decimal(15),
                  rate: new Prisma.Decimal(320),
                  unit: 'pz',
                  lineTotal: new Prisma.Decimal(4800),
                  sortOrder: 0,
                },
              ],
            },
          },
        });
        const stage = await prisma.pipelineStage.findFirstOrThrow({ where: { key: 'cotizado' } });
        const opportunity = await prisma.opportunity.create({
          data: {
            number: 'OPP-IT-0001',
            title: 'Porcelanato para Constructora Norte',
            contactName: 'Constructora Norte',
            zohoContactId: 'it-cli-9',
            salespersonUserId: team.seller.id,
            stageId: stage.id,
            zohoEstimateIds: ['it-est-1'],
          },
        });

        const requestKey = `it-req-${randomUUID()}`;
        const result = await createSalesOrderFromQuote(team.seller, {
          quoteId: quote.id,
          requestKey,
        });
        expect(result).toMatchObject({
          requestKey,
          quoteId: quote.id,
          opportunityId: opportunity.id,
          total: '5568',
          replayed: false,
          mock: true,
        });
        expect(await prisma.salesOrder.count({ where: { referenceNumber: 'it-COT-00042' } })).toBe(
          1
        );
        expect(
          await prisma.salesOrderWriteRequest.findFirstOrThrow({ where: { requestKey } })
        ).toMatchObject({ status: 'completed', salesOrderId: result.salesOrderId });
        expect(
          await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } })
        ).toMatchObject({ status: 'won', zohoSalesOrderIds: [result.zohoSalesOrderId] });

        // Retrying the same key replays: no second order, no second write request.
        const replay = await createSalesOrderFromQuote(team.seller, {
          quoteId: quote.id,
          requestKey,
        });
        expect(replay).toMatchObject({ salesOrderId: result.salesOrderId, replayed: true });
        // Another key for the same quote is refused (the quote was already converted).
        await expect(
          createSalesOrderFromQuote(team.seller, {
            quoteId: quote.id,
            requestKey: `${requestKey}-b`,
          })
        ).rejects.toMatchObject({ code: 'quote_already_converted' });
        expect(await prisma.salesOrder.count({ where: { referenceNumber: 'it-COT-00042' } })).toBe(
          1
        );

        // One case, however many times the start job is enqueued (real dedupe key).
        const startJobs = await prisma.backgroundJob.findMany({
          where: { type: CASE_JOB_TYPES.start },
        });
        expect(startJobs).toHaveLength(1);
        expect(startJobs[0]).toMatchObject({
          dedupeKey: caseStartDedupeKey(result.zohoSalesOrderId),
          payload: { zohoSalesOrderId: result.zohoSalesOrderId },
        });
        await enqueueJob({
          type: CASE_JOB_TYPES.start,
          payload: { zohoSalesOrderId: result.zohoSalesOrderId },
          dedupeKey: caseStartDedupeKey(result.zohoSalesOrderId),
          priority: JOB_PRIORITY.interactive,
          maxAttempts: 3,
        });
        expect(await prisma.backgroundJob.count({ where: { type: CASE_JOB_TYPES.start } })).toBe(1);

        const ranTypes = (await drainAllOk()).map((run) => run.type);
        expect(ranTypes).toContain(CASE_JOB_TYPES.start);
        expect(ranTypes).toContain('crm.sales_order_readback');
        // Enqueueing the start again after the first one ran still opens no second case.
        await enqueueJob({
          type: CASE_JOB_TYPES.start,
          payload: { zohoSalesOrderId: result.zohoSalesOrderId },
          dedupeKey: caseStartDedupeKey(result.zohoSalesOrderId),
          priority: JOB_PRIORITY.interactive,
          maxAttempts: 3,
        });
        await drainAllOk();
        const cases = await prisma.operationalCase.findMany({
          where: { sourceType: 'sales_order', sourceId: result.zohoSalesOrderId },
        });
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ zohoSalesOrderId: result.zohoSalesOrderId });
        // The read-back confirmed the order Zoho reports: no mismatch incident.
        expect(
          await prisma.salesOrderWriteRequest.findFirstOrThrow({ where: { requestKey } })
        ).toMatchObject({ status: 'completed' });
        expect(await prisma.incident.count({ where: { kind: 'sales_order_mismatch' } })).toBe(0);
      } finally {
        if (previousMock === undefined) delete process.env.ZOHO_BOOKS_MOCK;
        else process.env.ZOHO_BOOKS_MOCK = previousMock;
      }
    });

    // -------------------------------------------------------------------------
    // Red de seguridad de la propia suite (plan §9.1: los escenarios tienen que
    // ser EVIDENCIA, no sólo verde)
    // -------------------------------------------------------------------------

    /**
     * El motor de jobs sólo vuelve a lanzar los rechazos reintentables, así que un
     * comando rechazado por reglas de negocio deja el job en «completado». Esta
     * prueba fija las dos mitades: (1) el producto rechaza `case.start` sobre una
     * orden sin nada que surtir y no abre expediente, y (2) el drenado estricto de
     * esta suite lo denuncia en vez de dejar pasar el escenario. Sin (2), cualquier
     * escenario de arriba podría quedar verde con el dominio rechazando el trabajo.
     */
    it('un job «completado» con el comando rechazado no pasa por trabajo hecho', async () => {
      await prisma.product.create({
        data: {
          zohoItemId: 'it-item-flete',
          name: 'Flete',
          sku: 'IT-ITEM-FLETE',
          unit: 'servicio',
          status: 'active',
          productType: 'service',
          sourceRemoteModifiedAt: new Date(),
          sourceSnapshotId: 'it-snapshot',
        },
      });
      const order = await seedSalesOrder([{ zohoItemId: 'it-item-flete', quantity: 1 }]);
      const enqueueStart = () =>
        enqueueJob({
          type: CASE_JOB_TYPES.start,
          payload: { zohoSalesOrderId: order.zohoSalesOrderId },
          dedupeKey: caseStartDedupeKey(order.zohoSalesOrderId),
          priority: JOB_PRIORITY.interactive,
          maxAttempts: 3,
        });

      await enqueueStart();
      const runs = await drainJobs();
      // El job termina bien: no es un fallo de infraestructura, es un rechazo de negocio.
      expect(runs).toEqual([
        expect.objectContaining({ type: CASE_JOB_TYPES.start, outcome: 'completed' }),
      ]);
      expect(
        (await prisma.backgroundJob.findFirstOrThrow({ where: { type: CASE_JOB_TYPES.start } }))
          .status
      ).toBe('completed');
      // …y sin embargo el dominio no hizo nada: ni expediente ni demandas.
      expect(jobRejection(runs[0].result)).toMatch(/rejected \(invalid_state/);
      expect(await prisma.operationalCase.count()).toBe(0);
      expect(await prisma.caseDemand.count()).toBe(0);

      // La red: el mismo rechazo, drenado con `drainAllOk`, revienta con el motivo.
      await enqueueStart();
      await expect(drainAllOk()).rejects.toThrow(/invalid_state/);
      // Y se puede tolerar a propósito cuando un escenario espera el rechazo.
      await enqueueStart();
      expect((await drainAllOk([CASE_JOB_TYPES.start])).map((run) => run.type)).toEqual([
        CASE_JOB_TYPES.start,
      ]);
    });
  }
);

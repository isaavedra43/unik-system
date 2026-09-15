import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Business scenarios of the operations core, inventory and logistics (plan
 * section 9.1) against a REAL PostgreSQL database with every migration applied.
 *
 * - Runs only when UNIK_INTEGRATION_DATABASE_URL is set (vitest project
 *   `integration`, `npm run test:integration`); otherwise it is skipped with a
 *   message.
 * - The database must be disposable and local: the suite refuses any other
 *   (see `assertDisposableDatabase`). Every test starts from an empty
 *   operational state that the suite seeds itself, and the data is removed at
 *   the end.
 * - Nothing external is called: the Zoho package writes (`shipPackage`,
 *   `markPackageDelivered`, `cancelPackageShipment`), the Zoho read-back
 *   refresh and the web push transport are mocked. Everything else is real:
 *   transactions, row locks, unique keys, raw SQL, the command ledger, the
 *   outbox and the job handlers (drained here with the worker's semantics).
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;
if (!integrationUrl) {
  console.warn(
    '[integration] Se omiten los escenarios de operaciones: define UNIK_INTEGRATION_DATABASE_URL ' +
      'con una base PostgreSQL local y desechable con todas las migraciones aplicadas ' +
      '(por ejemplo unik_schema_check) y ejecuta `npm run test:integration`.'
  );
}

const mocks = vi.hoisted(() => ({
  shipPackage: vi.fn(),
  markPackageDelivered: vi.fn(),
  cancelPackageShipment: vi.fn(),
  refreshPackageOnDemand: vi.fn(),
  sendPushToUser: vi.fn(async () => ({ sent: 0, failed: 0, removed: 0, skipped: true })),
}));

vi.mock('@/modules/packages/packages-shipping-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/packages/packages-shipping-service')>()),
  shipPackage: mocks.shipPackage,
  markPackageDelivered: mocks.markPackageDelivered,
  cancelPackageShipment: mocks.cancelPackageShipment,
}));
vi.mock('@/modules/integrations/zoho/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/integrations/zoho/config')>()),
  isZohoBooksMockEnabled: () => false,
}));
vi.mock('@/modules/integrations/zoho/packages-shipment-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/integrations/zoho/packages-shipment-sweep')>()),
  refreshPackageOnDemand: mocks.refreshPackageOnDemand,
}));
vi.mock('@/modules/notifications/push-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/notifications/push-service')>()),
  sendPushToUser: mocks.sendPushToUser,
}));

import { prisma } from '@/lib/prisma';
// Every operational command (and the cross-module reactions) through the barrel, like the app.
import '@/modules/operations/register-commands';
import { runClientCommand, toDomainCommand } from '@/app/app/operations/api/commands/_shared';
import { loadActiveCurrentUser, type CurrentUser } from '@/modules/auth/authorization';
import {
  claimLegacyStock,
  closeStockCount,
  confirmLegacyStockClaim,
  recordStockCountLine,
  reserveStockForDemand,
  startStockCount,
} from '@/modules/inventory/inventory-commands';
import { ensureGeneralLocation } from '@/modules/inventory/warehouses-service';
import { enqueueJob, JOB_PRIORITY, type JobContext } from '@/modules/jobs/job-queue';
import {
  assignTransportCommand,
  buildTripCommand,
  recordDeliveryCommand,
  startTripCommand,
} from '@/modules/logistics/logistics-commands';
import {
  runCancelShipmentJob,
  runMarkDeliveredJob,
  runShipPackageJob,
} from '@/modules/logistics/logistics-jobs';
import {
  AREA_REQUEST_AUTO_ACK_JOB,
  acceptAreaRequest,
  runAreaRequestAutoAckJob,
} from '@/modules/operations/area-requests-service';
import {
  runCaseAdvanceJob,
  runCaseReplanJob,
  runCaseStartJob,
} from '@/modules/operations/case-jobs';
import {
  advanceCase,
  advanceCaseCommand,
  startCaseManually,
  startSalesFulfillment,
} from '@/modules/operations/case-service';
import { executeCommand, registerCommand, type CommandResult } from '@/modules/operations/commands';
import {
  invalidateOperationsConfigCache,
  updateOperationsConfig,
} from '@/modules/operations/operations-config';
import { clearProcessBlueprintCache } from '@/modules/operations/process-blueprints/registry';
import { rebuildObjectRelations } from '@/modules/operations/relations-rebuild';
import { CASE_JOB_TYPES, caseStartDedupeKey } from '@/modules/operations/sales-order-hooks';
import { ensureOperationsSeed } from '@/modules/operations/seed';
import { runSupervisorTick } from '@/modules/operations/supervisor';
import { AREA_KEYS, AREA_LABELS, type AreaKey } from '@/modules/operations/types';
import { completeWorkItem } from '@/modules/operations/work-items-service';
import { PackageShippingError } from '@/modules/packages/packages-shipping-service';

// ---------------------------------------------------------------------------
// Safety and cleanup
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_NAME = /(check|test|integration|scratch|ci)/i;

/** Refuses anything that is not a local, disposable database with the operations schema. */
async function assertDisposableDatabase(): Promise<void> {
  if (process.env.DATABASE_URL !== integrationUrl) {
    throw new Error(
      '[integration] DATABASE_URL no coincide con UNIK_INTEGRATION_DATABASE_URL; ejecuta con `npm run test:integration`'
    );
  }
  const url = new URL(integrationUrl);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `[integration] Sólo se permite una base local (host recibido: ${url.hostname})`
    );
  }
  const [{ name }] = await prisma.$queryRaw<
    Array<{ name: string }>
  >`SELECT current_database() AS name`;
  const allowed = process.env.UNIK_INTEGRATION_ALLOW_DATABASE?.trim();
  if (name === 'unik_system' || (!DISPOSABLE_NAME.test(name) && allowed !== name)) {
    throw new Error(
      `[integration] La base "${name}" no parece desechable. Usa una base de prueba (p. ej. unik_schema_check) ` +
        'o confírmala con UNIK_INTEGRATION_ALLOW_DATABASE=<nombre>.'
    );
  }
  const [{ ready }] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
    SELECT to_regclass('"OperationalCase"') IS NOT NULL
       AND to_regclass('"StockItem"') IS NOT NULL
       AND to_regclass('"DeliveryOrder"') IS NOT NULL AS ready`;
  if (!ready) {
    throw new Error(
      `[integration] La base "${name}" no tiene las migraciones de operaciones; aplica \`prisma migrate deploy\` a esa base desechable`
    );
  }
}

/** Tables owned by the operations program plus the side tables its commands write. */
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
  // Side effects of the commands (disposable database only)
  'BackgroundJob',
  'Notification',
  'AuditLog',
  'RealtimeEvent',
  'UsageMeter',
  'EntityChangeEvent',
  'UserNotificationSettings',
];

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${RESET_TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY`
  );
  await prisma.$executeRaw`DELETE FROM "StorageObject" WHERE left("objectKey", 12) = 'evidence/it-'`;
  await prisma.$executeRaw`DELETE FROM "Package" WHERE left("zohoPackageId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "SalesOrder" WHERE left("zohoSalesOrderId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "Product" WHERE left("zohoItemId", 3) = 'it-'`;
  await prisma.$executeRaw`DELETE FROM "Responsible" WHERE left("userId", 3) = 'it_'`;
  await prisma.$executeRaw`DELETE FROM "Role" WHERE left("key", 3) = 'it_'`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE left("id", 3) = 'it_'`;
  await prisma.$executeRaw`DELETE FROM "IntegrationConfig" WHERE "source" = 'operations'`;
  invalidateOperationsConfigCache();
  clearProcessBlueprintCache();
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

const CUTOVER = '2026-01-01T00:00:00.000Z';
const ZOHO_LOCATION = 'it-loc-1';
const OPEN_WORK = ['open', 'in_progress', 'waiting', 'escalated'];

const VIEW = ['operations.view'];
const INVENTORY = ['inventory.view', 'inventory.count', 'inventory.adjust', 'inventory.reserve'];
const LOGISTICS = [
  'logistics.view',
  'logistics.dispatch',
  'logistics.zoho_write',
  'logistics.manage_fleet',
];

interface Team {
  byArea: Record<AreaKey, CurrentUser>;
  inventoryBackup: CurrentUser;
  manager: CurrentUser;
  driver: CurrentUser;
}

interface Base {
  team: Team;
  warehouseId: string;
  generalLocationId: string;
  vehicleId: string;
  driverId: string;
}

let base: Base;
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

const AREA_PERMISSIONS: Record<AreaKey, string[]> = {
  ventas: [...VIEW, 'inventory.view', 'logistics.view'],
  compras: VIEW,
  inventario: [...VIEW, ...INVENTORY],
  manufactura: VIEW,
  logistica: [...VIEW, ...LOGISTICS],
  contabilidad: VIEW,
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
  const inventoryBackup = await seedUser('it_inventario_suplente', 'Suplente Inventario', [
    ...VIEW,
    ...INVENTORY,
  ]);
  const manager = await seedUser('it_gestora', 'Gestora de operaciones', [
    ...VIEW,
    'operations.manage',
    ...INVENTORY,
    ...LOGISTICS,
  ]);
  const driver = await seedUser('it_chofer', 'Chofer Pedro', ['logistics.view', 'logistics.drive']);
  for (const area of AREA_KEYS) {
    await prisma.responsible.create({
      data: {
        area,
        label: AREA_LABELS[area],
        userId: `it_${area}`,
        backupUserId: area === 'inventario' ? inventoryBackup.id : null,
      },
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
  clearProcessBlueprintCache();
  await ensureOperationsSeed();

  const warehouse = await prisma.warehouse.create({
    data: { key: 'it-principal', name: 'Bodega integración', zohoLocationId: ZOHO_LOCATION },
  });
  const general = await ensureGeneralLocation(prisma, warehouse.id);
  const vehicle = await prisma.vehicle.create({
    data: { code: 'IT-CAM-01', plate: 'IT-001', label: 'Camioneta 1', capacityPieces: 1000 },
  });
  const fleetDriver = await prisma.driver.create({
    data: { name: 'Pedro', userId: driver.id, phone: '8110000000' },
  });
  return {
    team: { byArea, inventoryBackup, manager, driver },
    warehouseId: warehouse.id,
    generalLocationId: general.id,
    vehicleId: vehicle.id,
    driverId: fleetDriver.id,
  };
}

async function seedProduct(zohoItemId: string): Promise<void> {
  await prisma.product.create({
    data: {
      zohoItemId,
      name: `Producto ${zohoItemId}`,
      sku: zohoItemId.toUpperCase(),
      unit: 'pz',
      status: 'active',
      sourceRemoteModifiedAt: new Date(),
      sourceSnapshotId: 'it-snapshot',
    },
  });
}

/** Product + CONTROLLED profile + GENERAL stock row with `quantity` counted today. */
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

/** Zoho package of the sales order (created by Ventas in Zoho, synchronized to UNIK). */
async function seedPackage(order: SeededOrder) {
  const zohoPackageId = nextId('it-pkg');
  return prisma.package.create({
    data: {
      zohoPackageId,
      packageNumber: zohoPackageId.toUpperCase(),
      status: 'not_shipped',
      zohoSalesOrderId: order.zohoSalesOrderId,
      date: new Date(),
      shippingAttention: 'Juan Pérez',
      shippingAddress: 'Av. Reforma 100',
      shippingCity: 'Monterrey',
      shippingState: 'NL',
      shippingZip: '64000',
      sourceRemoteModifiedAt: new Date(),
      sourceSnapshotId: `${zohoPackageId}-snapshot`,
    },
  });
}

/** A delivery photo already uploaded to the `delivery_evidence` target. */
async function uploadDeliveryEvidence(deliveryOrderId: string, userId: string): Promise<string> {
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
  await prisma.deliveryEvidence.create({
    data: { deliveryOrderId, kind: 'photo', storageObjectId: object.id, createdBy: userId },
  });
  return object.id;
}

// ---------------------------------------------------------------------------
// Jobs: drained with the semantics of the worker (job-queue.ts runJob)
// ---------------------------------------------------------------------------

type Handler = (job: JobContext<unknown>) => Promise<unknown>;

const JOB_HANDLERS: Record<string, Handler> = {
  [CASE_JOB_TYPES.start]: runCaseStartJob,
  [CASE_JOB_TYPES.replan]: runCaseReplanJob,
  [CASE_JOB_TYPES.advance]: runCaseAdvanceJob,
  'ops.zoho.ship_package': (job) => runShipPackageJob(job as never),
  'ops.zoho.mark_delivered': (job) => runMarkDeliveredJob(job as never),
  'ops.zoho.cancel_shipment': (job) => runCancelShipmentJob(job as never),
  [AREA_REQUEST_AUTO_ACK_JOB]: runAreaRequestAutoAckJob,
};

interface JobRun {
  type: string;
  attempt: number;
  outcome: 'completed' | 'retry' | 'failed';
  error?: string;
}

const toJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined || value === null
    ? Prisma.JsonNull
    : JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

/**
 * Claims pending jobs of the known types one by one (ignoring the retry
 * back-off, which only delays) and records the outcome exactly like the worker:
 * success completes and frees the dedupe key; a failure goes back to pending
 * until `maxAttempts`, then fails.
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
      runs.push({ type: job.type, attempt, outcome: 'completed' });
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

async function startCaseViaJob(order: SeededOrder) {
  await enqueueJob({
    type: CASE_JOB_TYPES.start,
    payload: { zohoSalesOrderId: order.zohoSalesOrderId },
    dedupeKey: caseStartDedupeKey(order.zohoSalesOrderId),
    priority: JOB_PRIORITY.interactive,
    maxAttempts: 3,
  });
  const runs = await drainJobs();
  expect(runs.filter((run) => run.outcome !== 'completed')).toEqual([]);
  return prisma.operationalCase.findFirstOrThrow({
    where: { sourceType: 'sales_order', sourceId: order.zohoSalesOrderId },
  });
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

async function stockOf(zohoItemId: string) {
  const rows = await prisma.stockItem.findMany({ where: { zohoItemId } });
  const sum = (key: 'knownQty' | 'reserved' | 'issued' | 'blocked') =>
    rows.reduce((total, row) => total + Number(row[key]), 0);
  const claims = await prisma.legacyCommitmentClaim.findMany({
    where: { zohoItemId, status: 'claimed' },
  });
  const claimed = claims.reduce((total, claim) => total + Number(claim.quantity), 0);
  const known = sum('knownQty');
  const reserved = sum('reserved');
  return {
    known,
    reserved,
    issued: sum('issued'),
    claimed,
    available: known - reserved - sum('blocked') - claimed,
  };
}

async function activeReservedQuantity(where: Prisma.StockReservationWhereInput): Promise<number> {
  const rows = await prisma.stockReservation.findMany({ where: { ...where, status: 'active' } });
  return rows.reduce((total, row) => total + Number(row.quantity), 0);
}

/** CONTROLLED stock never below zero and the reserved counter always equals the active reservations. */
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

const today = () => new Date().toISOString().slice(0, 10);

/** What Zoho keeps after the shipment write (a real re-read of the package). */
function zohoStoresShipment(values: { carrier?: string; trackingNumber?: string } = {}) {
  mocks.shipPackage.mockImplementation(
    async (
      _actor: { id: string },
      packageId: string,
      input: { carrier: string; date: string; trackingNumber?: string }
    ) => {
      await prisma.package.update({
        where: { id: packageId },
        data: {
          carrier: values.carrier ?? input.carrier,
          deliveryMethod: values.carrier ?? input.carrier,
          shipmentDate: new Date(`${input.date}T00:00:00.000Z`),
          trackingNumber: values.trackingNumber ?? (input.trackingNumber || null),
          zohoShipmentId: `it-zship-${packageId}`,
          shipmentNumber: 'NE-IT-0001',
          status: 'shipped',
          lastDetailFetchedAt: new Date(),
        },
      });
      return { id: packageId };
    }
  );
}

function zohoMarksDelivered() {
  mocks.markPackageDelivered.mockImplementation(
    async (_actor: { id: string }, packageId: string, date?: string | null) => {
      await prisma.package.update({
        where: { id: packageId },
        data: {
          status: 'delivered',
          deliveryDate: date ? new Date(`${date}T00:00:00.000Z`) : new Date(),
          lastDetailFetchedAt: new Date(),
        },
      });
      return { id: packageId };
    }
  );
}

/** Case with CONTROLLED stock, prepared by Inventario: returns the planned delivery order. */
async function preparedCase(zohoItemId: string, stock: number, quantity: number) {
  await seedControlledStock(zohoItemId, stock);
  const order = await seedSalesOrder([{ zohoItemId, quantity }]);
  const pkg = await seedPackage(order);
  const opCase = await startCaseViaJob(order);
  const prepareItem = await openWorkItemOfStep((await stepOf(opCase.id, 'preparar_pedido')).id);
  expectStatus(
    await completeWorkItem(base.team.byArea.inventario, prepareItem.id, {
      result: { issue_movements: 'Surtido completo en andén 1' },
    }),
    'completed'
  );
  await drainJobs();
  const deliveryOrder = await prisma.deliveryOrder.findFirstOrThrow({
    where: { caseId: opCase.id },
  });
  return { order, pkg, opCase, deliveryOrder };
}

function assignOwnFleet(deliveryOrderId: string, trackingNumber = 'IT-TRK-1') {
  return assignTransportCommand(base.team.byArea.logistica, {
    deliveryOrderId,
    carrier: 'Flotilla UNIK',
    date: today(),
    trackingNumber,
    vehicleId: base.vehicleId,
    driverId: base.driverId,
  });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describeDb('escenarios de operaciones contra PostgreSQL real', () => {
  beforeAll(async () => {
    if (!process.env.UNIK_INTEGRATION_VERBOSE)
      vi.spyOn(console, 'info').mockImplementation(() => {});
    await assertDisposableDatabase();
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
    vi.clearAllMocks();
    await resetDatabase();
    base = await seedBase();
  });

  it('flujo completo con stock controlado: de la venta al cierre financiero', async () => {
    const { team } = base;
    await seedControlledStock('it-item-piso', 25);
    const order = await seedSalesOrder([{ zohoItemId: 'it-item-piso', quantity: 10 }]);
    const pkg = await seedPackage(order);

    const opCase = await startCaseViaJob(order);
    expect(opCase).toMatchObject({
      status: 'open',
      phase: 'preparing',
      ownerUserId: team.byArea.ventas.id,
    });
    expect(opCase.caseNumber).toBe(`EXP-${String(opCase.caseSeq).padStart(6, '0')}`);
    const [demand] = await prisma.caseDemand.findMany({ where: { caseId: opCase.id } });
    expect(demand.status).toBe('allocated');
    const [reservation] = await prisma.stockReservation.findMany({ where: { caseId: opCase.id } });
    expect(reservation).toMatchObject({ status: 'active', confidenceAtReserve: 'CONTROLLED' });
    expect(Number(reservation.quantity)).toBe(10);
    expect(await stockOf('it-item-piso')).toMatchObject({ known: 25, reserved: 10, available: 15 });

    // 1. Inventario prepara el pedido → el motor planea la entrega con el paquete de Zoho.
    const prepareStep = await stepOf(opCase.id, 'preparar_pedido');
    const prepareItem = await openWorkItemOfStep(prepareStep.id);
    expect(prepareItem).toMatchObject({
      areaKey: 'inventario',
      ownerUserId: team.byArea.inventario.id,
    });
    expectStatus(
      await completeWorkItem(team.byArea.inventario, prepareItem.id, {
        result: { issue_movements: 'Surtido completo en andén 1' },
      }),
      'completed'
    );
    await drainJobs();
    const deliveryOrder = await prisma.deliveryOrder.findFirstOrThrow({
      where: { caseId: opCase.id },
    });
    expect(deliveryOrder).toMatchObject({
      status: 'planned',
      packageId: pkg.id,
      mode: 'own_fleet',
    });
    expect((await stepOf(opCase.id, 'asignar_transporte')).status).toBe('ready');

    // 2. Logística asigna flotilla → outbox → Zoho → relectura igual → paso cerrado.
    zohoStoresShipment();
    expectStatus(await assignOwnFleet(deliveryOrder.id), 'pending_external');
    await drainJobs();
    expect(mocks.shipPackage).toHaveBeenCalledTimes(1);
    expect(
      await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryOrder.id } })
    ).toMatchObject({
      status: 'assigned',
      zohoSyncState: 'readback_ok',
      driverId: base.driverId,
    });
    expect((await stepOf(opCase.id, 'asignar_transporte')).status).toBe('done');
    expect((await stepOf(opCase.id, 'entregar')).status).toBe('ready');

    // 3. El chofer entrega completo con foto → consume la reserva y marca entregado en Zoho.
    zohoMarksDelivered();
    const photo = await uploadDeliveryEvidence(deliveryOrder.id, team.driver.id);
    const delivered = await recordDeliveryCommand(team.driver, {
      deliveryOrderId: deliveryOrder.id,
      lines: [{ allocationId: deliveryOrder.allocationIds[0], deliveredQty: 10 }],
      receivedBy: 'Juan Pérez',
      evidenceObjectIds: [photo],
    });
    expectStatus(delivered, 'pending_external');
    await drainJobs();
    expect(mocks.markPackageDelivered).toHaveBeenCalledTimes(1);
    expect(
      await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryOrder.id } })
    ).toMatchObject({
      status: 'delivered',
      zohoSyncState: 'delivered_written',
    });
    expect(
      await prisma.stockReservation.findUniqueOrThrow({ where: { id: reservation.id } })
    ).toMatchObject({
      status: 'consumed',
    });
    expect(await stockOf('it-item-piso')).toMatchObject({ known: 15, reserved: 0, issued: 10 });
    expect(
      await prisma.stockMovement.count({
        where: { kind: 'issue', referenceType: 'delivery_order', referenceId: deliveryOrder.id },
      })
    ).toBe(1);
    expect(
      await prisma.operationalCase.findUniqueOrThrow({ where: { id: opCase.id } })
    ).toMatchObject({
      status: 'ready_to_close',
      phase: 'closing',
    });
    expect((await stepOf(opCase.id, 'cierre_financiero')).status).toBe('waiting');

    // 4. Zoho factura y cobra → el avance cierra el expediente sin trabajo pendiente.
    await prisma.salesOrder.update({
      where: { id: order.id },
      data: { invoicedStatus: 'invoiced', paidStatus: 'paid' },
    });
    await enqueueJob({ type: CASE_JOB_TYPES.advance, payload: { caseId: opCase.id } });
    await drainJobs();
    const closed = await prisma.operationalCase.findUniqueOrThrow({ where: { id: opCase.id } });
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(
      await prisma.workItem.count({ where: { caseId: opCase.id, status: { in: OPEN_WORK } } })
    ).toBe(0);
    expect(await eventTypes({ caseId: opCase.id })).toEqual(
      expect.arrayContaining([
        'case.created',
        'stock.reserved',
        'order.prepared',
        'delivery.planned',
        'zoho.shipment_confirmed',
        'delivery.confirmed',
        'case.operational_closed',
        'case.financial_closed',
      ])
    );
    expect(await prisma.operationalCommand.count({ where: { status: 'accepted' } })).toBe(0);
    await expectStockInvariants();

    // The relation projection is rebuilt from the source tables without duplicating edges.
    const relationsBefore = await prisma.objectRelation.count();
    const rebuilt = await rebuildObjectRelations();
    expect(rebuilt.aborted).toBe(false);
    const relationsAfter = await prisma.objectRelation.count();
    expect(relationsAfter).toBeGreaterThanOrEqual(relationsBefore);
    const rebuiltAgain = await rebuildObjectRelations();
    expect(
      Object.values(rebuiltAgain.sources).every((s) => s.created === 0 && s.reopened === 0)
    ).toBe(true);
    expect(await prisma.objectRelation.count()).toBe(relationsAfter);
  });

  it('stock desconocido: conteo → provisional → promesa sólo con decisión humana explícita', async () => {
    const { team } = base;
    await seedProduct('it-item-lamina');
    const order = await seedSalesOrder([{ zohoItemId: 'it-item-lamina', quantity: 10 }]);

    const opCase = await startCaseViaJob(order);
    const [demand] = await prisma.caseDemand.findMany({ where: { caseId: opCase.id } });
    expect(demand.status).toBe('verifying');
    expect(await prisma.stockReservation.count({ where: { caseId: opCase.id } })).toBe(0);
    const verifyItem = await openWorkItemOfStep(
      (await stepOf(opCase.id, 'verificar_disponibilidad', demand.id)).id
    );
    expect(verifyItem).toMatchObject({ kind: 'verification', areaKey: 'inventario' });

    // Conteo físico: la primera captura crea la línea base y deja la existencia PROVISIONAL.
    const started = await startStockCount(team.byArea.inventario, {
      warehouseId: base.warehouseId,
    });
    expectStatus(started, 'completed');
    const countId = started.data!.count.id;
    expectStatus(
      await recordStockCountLine(team.byArea.inventario, {
        countId,
        zohoItemId: 'it-item-lamina',
        countedQty: 30,
        unit: 'pz',
      }),
      'completed'
    );
    const closedCount = await closeStockCount(team.byArea.inventario, { countId });
    expectStatus(closedCount, 'completed');
    expect(closedCount.data!.baselines).toBe(1);
    expect(
      await prisma.productInventoryProfile.findUniqueOrThrow({
        where: { zohoItemId: 'it-item-lamina' },
      })
    ).toMatchObject({ confidence: 'PROVISIONAL' });
    expect(await stockOf('it-item-lamina')).toMatchObject({ known: 30, reserved: 0 });

    expectStatus(
      await completeWorkItem(team.byArea.inventario, verifyItem.id, {
        result: { availability_result: { counted: 30, countId } },
      }),
      'completed'
    );
    const planItem = await openWorkItemOfStep(
      (await stepOf(opCase.id, 'plan_abastecimiento', demand.id)).id
    );
    expect(planItem).toMatchObject({ kind: 'approval', ownerUserId: team.byArea.ventas.id });
    // PROVISIONAL nunca se promete sola.
    expect(await prisma.stockReservation.count({ where: { caseId: opCase.id } })).toBe(0);

    const refused = await completeWorkItem(team.byArea.ventas, planItem.id, {
      result: { allocation_plan: { lines: [{ source: 'stock', quantity: 10 }] } },
    });
    expect(refused).toMatchObject({ status: 'rejected', errorCode: 'provisional_not_allowed' });
    expect(await prisma.stockReservation.count({ where: { caseId: opCase.id } })).toBe(0);

    const promised = await completeWorkItem(team.byArea.ventas, planItem.id, {
      result: {
        allocation_plan: {
          acceptProposal: true,
          allowProvisional: true,
          note: 'Conteo de hoy: 30 pz',
        },
      },
    });
    expectStatus(promised, 'completed');
    await drainJobs();
    const [reservation] = await prisma.stockReservation.findMany({ where: { caseId: opCase.id } });
    expect(reservation).toMatchObject({ status: 'active', confidenceAtReserve: 'PROVISIONAL' });
    expect(Number(reservation.quantity)).toBe(10);
    expect(await eventTypes({ caseId: opCase.id })).toContain('stock.reserved_provisional');
    const [allocation] = await prisma.demandAllocation.findMany({ where: { demandId: demand.id } });
    expect(allocation).toMatchObject({
      source: 'stock',
      status: 'reserved',
      stockReservationId: reservation.id,
    });
    expect((await stepOf(opCase.id, 'preparar_pedido')).status).toBe('ready');
    expect(await stockOf('it-item-lamina')).toMatchObject({ known: 30, reserved: 10 });
  });

  it('división existencia + compra: reserva lo controlado y pide a Compras el faltante', async () => {
    const { team } = base;
    await seedControlledStock('it-item-zoclo', 6);
    const order = await seedSalesOrder([{ zohoItemId: 'it-item-zoclo', quantity: 10 }]);
    const opCase = await startCaseViaJob(order);
    const [demand] = await prisma.caseDemand.findMany({ where: { caseId: opCase.id } });

    const verifyItem = await openWorkItemOfStep(
      (await stepOf(opCase.id, 'verificar_disponibilidad', demand.id)).id
    );
    expectStatus(
      await completeWorkItem(team.byArea.inventario, verifyItem.id, {
        result: { availability_result: { counted: 6 } },
      }),
      'completed'
    );
    const planItem = await openWorkItemOfStep(
      (await stepOf(opCase.id, 'plan_abastecimiento', demand.id)).id
    );
    expect(planItem.description).toContain('6 pz de existencia + 4 pz de compra');
    expectStatus(
      await completeWorkItem(team.byArea.ventas, planItem.id, {
        result: { allocation_plan: { acceptProposal: true } },
      }),
      'completed'
    );
    await drainJobs();

    const allocations = await prisma.demandAllocation.findMany({ where: { demandId: demand.id } });
    const stock = allocations.find((a) => a.source === 'stock')!;
    const purchase = allocations.find((a) => a.source === 'purchase')!;
    expect(stock.status).toBe('reserved');
    expect(Number(stock.quantity)).toBe(6);
    expect(purchase).toMatchObject({ status: 'requested', linkedType: 'area_request' });
    expect(Number(purchase.quantity)).toBe(4);
    const request = await prisma.areaRequest.findUniqueOrThrow({
      where: { id: purchase.linkedId! },
    });
    expect(request).toMatchObject({
      kind: 'purchase_shortfall',
      toAreaKey: 'compras',
      ownerUserId: team.byArea.compras.id,
      blocksDelivery: true,
    });
    // The coordination acknowledges automatically after the commit.
    expect(request.status).toBe('acknowledged');
    expect((await stepOf(opCase.id, 'esperar_recepcion', purchase.id)).status).toBe('waiting');
    expect(
      (await prisma.operationalCase.findUniqueOrThrow({ where: { id: opCase.id } })).phase
    ).toBe('sourcing');
    expect(await stockOf('it-item-zoclo')).toMatchObject({ known: 6, reserved: 6, available: 0 });
    await expectStockInvariants();
  });

  it('orden modificada tras reservar: cantidad abajo, arriba y cambio de dirección', async () => {
    const { team } = base;
    await seedControlledStock('it-item-tubo', 20);
    const order = await seedSalesOrder([{ zohoItemId: 'it-item-tubo', quantity: 10 }]);
    const opCase = await startCaseViaJob(order);
    const [line] = await prisma.salesOrderItem.findMany({ where: { salesOrderId: order.id } });
    const [firstReservation] = await prisma.stockReservation.findMany({
      where: { caseId: opCase.id },
    });

    const replanFromZoho = async (fields: Record<string, { before: unknown; after: unknown }>) => {
      const change = await prisma.entityChangeEvent.create({
        data: {
          entityType: 'sales_order',
          entityId: order.id,
          sourceSnapshotId: nextId('it-change'),
          changes: { fields } as Prisma.InputJsonValue,
        },
      });
      await enqueueJob({
        type: CASE_JOB_TYPES.replan,
        payload: {
          caseId: opCase.id,
          zohoSalesOrderId: order.zohoSalesOrderId,
          changeEventId: change.id,
        },
      });
      const runs = await drainJobs();
      expect(runs.filter((run) => run.outcome !== 'completed')).toEqual([]);
    };

    // Cantidad a la baja: libera la reserva y reserva sólo lo nuevo.
    await prisma.salesOrderItem.update({ where: { id: line.id }, data: { quantity: 6 } });
    await replanFromZoho({ quantity: { before: 10, after: 6 } });
    expect(
      await prisma.stockReservation.findUniqueOrThrow({ where: { id: firstReservation.id } })
    ).toMatchObject({ status: 'released' });
    expect(await activeReservedQuantity({ caseId: opCase.id })).toBe(6);
    expect(await stockOf('it-item-tubo')).toMatchObject({ reserved: 6 });

    // Cantidad a la alza: reserva el aumento con existencia controlada.
    await prisma.salesOrderItem.update({ where: { id: line.id }, data: { quantity: 14 } });
    await replanFromZoho({ quantity: { before: 6, after: 14 } });
    expect(await activeReservedQuantity({ caseId: opCase.id })).toBe(14);
    expect(await stockOf('it-item-tubo')).toMatchObject({ known: 20, reserved: 14, available: 6 });
    const [demand] = await prisma.caseDemand.findMany({ where: { caseId: opCase.id } });
    expect(Number(demand.baseQuantity)).toBe(14);
    expect(await prisma.incident.count({ where: { caseId: opCase.id } })).toBe(0);

    // Preparado el pedido, un cambio de dirección parchea la entrega sin transporte.
    const prepareItem = await openWorkItemOfStep((await stepOf(opCase.id, 'preparar_pedido')).id);
    expectStatus(
      await completeWorkItem(team.byArea.inventario, prepareItem.id, {
        result: { issue_movements: 'Surtido' },
      }),
      'completed'
    );
    await drainJobs();
    const deliveryOrder = await prisma.deliveryOrder.findFirstOrThrow({
      where: { caseId: opCase.id },
    });
    expect(deliveryOrder.city).toBe('Monterrey');
    await prisma.salesOrder.update({ where: { id: order.id }, data: { shippingCity: 'Saltillo' } });
    await replanFromZoho({ shippingCity: { before: 'Monterrey', after: 'Saltillo' } });
    expect(
      (await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryOrder.id } })).city
    ).toBe('Saltillo');
    expect(await eventTypes({ caseId: opCase.id })).toEqual(
      expect.arrayContaining([
        'demand.changed',
        'allocation.reopened',
        'case.replanned',
        'delivery.address_updated',
      ])
    );
    await expectStockInvariants();
  });

  it('cancelada en Zoho tras comprar: libera, vence solicitudes y compensa lo que está en vuelo', async () => {
    const { team } = base;
    await seedControlledStock('it-item-piso', 20);
    await seedProduct('it-item-pegazulejo');
    const order = await seedSalesOrder([
      { zohoItemId: 'it-item-piso', quantity: 10 },
      { zohoItemId: 'it-item-pegazulejo', quantity: 3 },
    ]);
    const opCase = await startCaseViaJob(order);
    expect(await stockOf('it-item-piso')).toMatchObject({ reserved: 10 });

    // La segunda partida no existe en bodega: se compra y Compras acepta.
    const demand = await prisma.caseDemand.findFirstOrThrow({
      where: { caseId: opCase.id, zohoItemId: 'it-item-pegazulejo' },
    });
    const verifyItem = await openWorkItemOfStep(
      (await stepOf(opCase.id, 'verificar_disponibilidad', demand.id)).id
    );
    expectStatus(
      await completeWorkItem(team.byArea.inventario, verifyItem.id, {
        result: { availability_result: { counted: 0 } },
      }),
      'completed'
    );
    const planItem = await openWorkItemOfStep(
      (await stepOf(opCase.id, 'plan_abastecimiento', demand.id)).id
    );
    expectStatus(
      await completeWorkItem(team.byArea.ventas, planItem.id, {
        result: { allocation_plan: true },
      }),
      'completed'
    );
    await drainJobs();
    const purchase = await prisma.demandAllocation.findFirstOrThrow({
      where: { demandId: demand.id, source: 'purchase' },
    });
    expectStatus(await acceptAreaRequest(team.byArea.compras, purchase.linkedId!, {}), 'completed');

    // Zoho anula la orden → replaneación → cancelación con compensaciones.
    await prisma.salesOrder.update({ where: { id: order.id }, data: { status: 'void' } });
    const change = await prisma.entityChangeEvent.create({
      data: {
        entityType: 'sales_order',
        entityId: order.id,
        sourceSnapshotId: nextId('it-change'),
        changes: { fields: { status: { before: 'confirmed', after: 'void' } } },
      },
    });
    await enqueueJob({
      type: CASE_JOB_TYPES.replan,
      payload: {
        caseId: opCase.id,
        zohoSalesOrderId: order.zohoSalesOrderId,
        changeEventId: change.id,
      },
    });
    await drainJobs();

    const cancelled = await prisma.operationalCase.findUniqueOrThrow({ where: { id: opCase.id } });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.closeReason).toContain('se anuló en Zoho');
    expect(await stockOf('it-item-piso')).toMatchObject({ known: 20, reserved: 0, available: 20 });
    expect(
      await prisma.stockReservation.count({ where: { caseId: opCase.id, status: 'active' } })
    ).toBe(0);
    expect(
      (await prisma.areaRequest.findUniqueOrThrow({ where: { id: purchase.linkedId! } })).status
    ).toBe('expired');
    const cancelRequest = await prisma.areaRequest.findFirstOrThrow({
      where: { caseId: opCase.id, kind: 'cancel' },
    });
    expect(cancelRequest).toMatchObject({ toAreaKey: 'compras', objectId: purchase.id });
    expect(
      await prisma.incident.findFirstOrThrow({
        where: { caseId: opCase.id, kind: 'cancellation_compensation' },
      })
    ).toMatchObject({ areaKey: 'compras', status: 'open' });
    expect(
      await prisma.caseStep.count({
        where: { caseId: opCase.id, status: { in: ['pending', 'ready', 'active', 'waiting'] } },
      })
    ).toBe(0);
    const openItems = await prisma.workItem.findMany({
      where: { caseId: opCase.id, status: { in: OPEN_WORK } },
    });
    expect(openItems.map((item) => item.objectId)).toEqual([cancelRequest.id]);
    await expectStockInvariants();
  });

  it('reclamo legado: resta del disponible y se convierte en la reserva del expediente de esa venta', async () => {
    const { team } = base;
    await seedControlledStock('it-item-cemento', 10);

    // Una venta anterior al corte comprometió 4 pz de palabra.
    const legacyOrder = await seedSalesOrder([{ zohoItemId: 'it-item-cemento', quantity: 4 }], {
      createdTime: new Date('2025-12-01T10:00:00.000Z'),
      orderDate: new Date('2025-12-01'),
    });
    const claimed = await claimLegacyStock(team.byArea.inventario, {
      zohoItemId: 'it-item-cemento',
      warehouseId: base.warehouseId,
      quantity: 4,
      unit: 'pz',
      source: 'pre_cutover_order',
      reference: legacyOrder.salesOrderNumber,
    });
    expectStatus(claimed, 'completed');
    expect(claimed.data).toMatchObject({ availableBefore: '10', availableAfter: '6' });

    // Una venta nueva de 8 pz ya no se promete sola: sólo hay 6 libres.
    const newOrder = await seedSalesOrder([{ zohoItemId: 'it-item-cemento', quantity: 8 }]);
    const newCase = await startCaseViaJob(newOrder);
    expect(await prisma.stockReservation.count({ where: { caseId: newCase.id } })).toBe(0);
    const [newDemand] = await prisma.caseDemand.findMany({ where: { caseId: newCase.id } });
    const direct = await reserveStockForDemand(team.manager, {
      caseId: newCase.id,
      demandId: newDemand.id,
      zohoItemId: 'it-item-cemento',
      warehouseId: base.warehouseId,
      quantity: 8,
      unit: 'pz',
    });
    expect(direct).toMatchObject({ status: 'rejected', errorCode: 'insufficient_stock' });

    // Ventas acepta 6 de existencia + 2 de compra para la venta nueva.
    const verifyItem = await openWorkItemOfStep(
      (await stepOf(newCase.id, 'verificar_disponibilidad', newDemand.id)).id
    );
    expectStatus(
      await completeWorkItem(team.byArea.inventario, verifyItem.id, {
        result: { availability_result: { counted: 10, legacyClaim: 4 } },
      }),
      'completed'
    );
    const planItem = await openWorkItemOfStep(
      (await stepOf(newCase.id, 'plan_abastecimiento', newDemand.id)).id
    );
    expectStatus(
      await completeWorkItem(team.byArea.ventas, planItem.id, {
        result: { allocation_plan: true },
      }),
      'completed'
    );
    await drainJobs();
    expect(await activeReservedQuantity({ caseId: newCase.id })).toBe(6);
    expect(await stockOf('it-item-cemento')).toMatchObject({
      reserved: 6,
      claimed: 4,
      available: 0,
    });

    // El reclamo no puede financiar la venta nueva: su necesidad ya tiene reservada casi toda su existencia.
    const misplaced = await confirmLegacyStockClaim(team.byArea.inventario, {
      claimId: claimed.data!.claim.id,
      caseId: newCase.id,
      demandId: newDemand.id,
    });
    expect(misplaced).toMatchObject({ status: 'rejected', errorCode: 'demand_over_reserved' });
    expect(await stockOf('it-item-cemento')).toMatchObject({ reserved: 6, claimed: 4 });

    // La venta legada entra al seguimiento: no hay existencia libre, el reclamo se confirma como su reserva.
    const legacyStart = await startCaseManually(team.manager, legacyOrder.zohoSalesOrderId);
    expectStatus(legacyStart, 'completed');
    const legacyCaseId = legacyStart.data!.caseId;
    expect(await prisma.stockReservation.count({ where: { caseId: legacyCaseId } })).toBe(0);
    const [legacyDemand] = await prisma.caseDemand.findMany({ where: { caseId: legacyCaseId } });
    const confirmed = await confirmLegacyStockClaim(team.byArea.inventario, {
      claimId: claimed.data!.claim.id,
      caseId: legacyCaseId,
      demandId: legacyDemand.id,
    });
    expectStatus(confirmed, 'completed');
    expect(
      await prisma.legacyCommitmentClaim.findUniqueOrThrow({
        where: { id: claimed.data!.claim.id },
      })
    ).toMatchObject({ status: 'confirmed', caseId: legacyCaseId });
    expect(await activeReservedQuantity({ caseId: legacyCaseId })).toBe(4);
    expect(await stockOf('it-item-cemento')).toMatchObject({
      known: 10,
      reserved: 10,
      claimed: 0,
      available: 0,
    });

    // Nada más cabe: una reserva extra se rechaza bajo el mismo candado.
    const extra = await reserveStockForDemand(team.manager, {
      caseId: newCase.id,
      demandId: newDemand.id,
      zohoItemId: 'it-item-cemento',
      warehouseId: base.warehouseId,
      quantity: 1,
      unit: 'pz',
    });
    expect(extra).toMatchObject({ status: 'rejected', errorCode: 'insufficient_stock' });
    await expectStockInvariants();
  });

  it('dos órdenes compiten por la misma existencia en transacciones concurrentes: FOR UPDATE serializa y nunca queda negativa', async () => {
    const { team } = base;
    const item = 'it-item-varilla';
    // Ambas ventas entran mientras el artículo aún no está contado: nada se promete todavía.
    await seedProduct(item);
    const orderA = await seedSalesOrder([{ zohoItemId: item, quantity: 7 }]);
    const orderB = await seedSalesOrder([{ zohoItemId: item, quantity: 7 }]);
    const orderC = await seedSalesOrder([{ zohoItemId: item, quantity: 3 }]);
    const cases = [
      await startCaseViaJob(orderA),
      await startCaseViaJob(orderB),
      await startCaseViaJob(orderC),
    ];
    const demands = await Promise.all(
      cases.map((c) => prisma.caseDemand.findFirstOrThrow({ where: { caseId: c.id } }))
    );
    // Inventario confirma 10 pz controladas.
    await prisma.productInventoryProfile.upsert({
      where: { zohoItemId: item },
      create: {
        zohoItemId: item,
        baseUnit: 'pz',
        confidence: 'CONTROLLED',
        consecutiveGoodCounts: 2,
        lastCountAt: new Date(),
      },
      update: { confidence: 'CONTROLLED', consecutiveGoodCounts: 2, lastCountAt: new Date() },
    });
    const stockItem = await prisma.stockItem.create({
      data: {
        zohoItemId: item,
        warehouseId: base.warehouseId,
        locationId: base.generalLocationId,
        baseline: 10,
        knownQty: 10,
        lastCountedAt: new Date(),
      },
    });
    const reserve = (index: number, quantity: number) =>
      reserveStockForDemand(team.manager, {
        caseId: cases[index].id,
        demandId: demands[index].id,
        zohoItemId: item,
        warehouseId: base.warehouseId,
        quantity,
        unit: 'pz',
      });

    // 1. A y B piden 7 de 10 al mismo tiempo: exactamente una gana.
    const race = await Promise.all([reserve(0, 7), reserve(1, 7)]);
    expect(race.map((r) => r.status).sort()).toEqual(['completed', 'rejected']);
    expect(race.find((r) => r.status === 'rejected')).toMatchObject({
      errorCode: 'insufficient_stock',
    });
    expect(await stockOf(item)).toMatchObject({ known: 10, reserved: 7, available: 3 });

    // 2. Con el renglón bloqueado por otra transacción, la reserva de C espera al commit.
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
    let releasedAt = 0;
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "StockItem" WHERE "id" = ${stockItem.id} FOR UPDATE`;
        lockAcquired();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        releasedAt = Date.now();
      },
      { timeout: 15_000 }
    );
    await acquired;
    const requestedAt = Date.now();
    const waiting = reserve(2, 3).then((result) => ({ result, finishedAt: Date.now() }));
    await holder;
    const { result: third, finishedAt } = await waiting;
    expectStatus(third, 'completed');
    expect(finishedAt).toBeGreaterThanOrEqual(releasedAt);
    expect(finishedAt - requestedAt).toBeGreaterThanOrEqual(1000);
    expect(await stockOf(item)).toMatchObject({ known: 10, reserved: 10, available: 0 });

    // 3. Una ráfaga de reservas sobre existencia agotada: todas rechazadas, nada negativo.
    const burst = await Promise.all([reserve(1, 1), reserve(1, 1), reserve(1, 1), reserve(1, 1)]);
    // Every one is refused: no stock left, and a demand already reserved in full is never promised again.
    expect(
      burst.every(
        (r) =>
          r.status === 'rejected' &&
          ['insufficient_stock', 'demand_over_reserved'].includes(r.errorCode ?? '')
      )
    ).toBe(true);
    expect(await stockOf(item)).toMatchObject({ known: 10, reserved: 10 });
    await expectStockInvariants();

    // 4. Dos expedientes completos arrancan a la vez sobre 10 pz controladas de otro artículo.
    await seedControlledStock('it-item-malla', 10);
    const orderX = await seedSalesOrder([{ zohoItemId: 'it-item-malla', quantity: 7 }]);
    const orderY = await seedSalesOrder([{ zohoItemId: 'it-item-malla', quantity: 7 }]);
    const starts = await Promise.all(
      [orderX, orderY].map((o) =>
        startSalesFulfillment(o.zohoSalesOrderId, {
          commandId: `it:case.start:${o.zohoSalesOrderId}`,
          actor: { type: 'system', id: 'job:ops.case.start' },
        })
      )
    );
    starts.forEach((result) => expectStatus(result, 'completed'));
    const reservedByCase = await Promise.all(
      starts.map((result) => activeReservedQuantity({ caseId: result.data!.caseId }))
    );
    // Sorted copy: `reservedByCase[i]` must keep matching `starts[i]` to find the loser below.
    expect([...reservedByCase].sort()).toEqual([0, 7]);
    expect(await stockOf('it-item-malla')).toMatchObject({ known: 10, reserved: 7, available: 3 });
    const loser =
      starts[reservedByCase.indexOf(0)] ?? starts.find((r, i) => reservedByCase[i] === 0)!;
    expect(
      await prisma.workItem.count({
        where: { caseId: loser.data!.caseId, status: { in: OPEN_WORK } },
      })
    ).toBeGreaterThan(0);
    await expectStockInvariants();

    // 5. The loser is never stuck: Ventas decides another source for what the winner took.
    const loserCaseId = loser.data!.caseId;
    const [loserDemand] = await prisma.caseDemand.findMany({ where: { caseId: loserCaseId } });
    // Serialized, the loser saw 3 pz and waits for Inventario's verification; in the race its
    // reservation failed and the plan went back to Ventas. Both paths end in Ventas' plan.
    const loserVerify = await stepOf(loserCaseId, 'verificar_disponibilidad', loserDemand.id);
    if (loserVerify.status !== 'done') {
      expectStatus(
        await completeWorkItem(
          base.team.byArea.inventario,
          (await openWorkItemOfStep(loserVerify.id)).id,
          { result: { availability_result: { counted: 3 } } }
        ),
        'completed'
      );
      await drainJobs();
    }
    const loserPlan = await openWorkItemOfStep(
      (await stepOf(loserCaseId, 'plan_abastecimiento', loserDemand.id)).id
    );
    expectStatus(
      await completeWorkItem(base.team.byArea.ventas, loserPlan.id, {
        result: { allocation_plan: true },
      }),
      'completed'
    );
    await drainJobs();
    expect(await activeReservedQuantity({ caseId: loserCaseId })).toBe(3);
    const loserPurchase = await prisma.demandAllocation.findFirstOrThrow({
      where: { caseId: loserCaseId, source: 'purchase', status: { not: 'cancelled' } },
    });
    expect(Number(loserPurchase.quantity)).toBe(4);
    expect(loserPurchase.status).toBe('requested');
    expect(await stockOf('it-item-malla')).toMatchObject({ known: 10, reserved: 10, available: 0 });
    await expectStockInvariants();
  });

  it('avances concurrentes del mismo expediente: el candado del expediente evita reservas duplicadas', async () => {
    await seedControlledStock('it-item-cable', 10);
    const order = await seedSalesOrder([{ zohoItemId: 'it-item-cable', quantity: 5 }]);
    await updateOperationsConfig({ flags: { inventory: false } });
    const opCase = await startCaseViaJob(order);
    expect(await activeReservedQuantity({ caseId: opCase.id })).toBe(0);
    await updateOperationsConfig({ flags: { inventory: true } });

    registerCommand('it.advance_case', {
      schema: z.object({ caseId: z.string() }),
      aggregate: 'none',
      async handler(tx, cmd, ctx) {
        const outcome = await advanceCase(tx, cmd.payload.caseId, ctx);
        return { data: { changed: outcome.changed } };
      },
    });
    const stamp = Date.now();
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        executeCommand(
          {
            commandId: `it-advance-${n}-${stamp}`,
            type: 'it.advance_case',
            actor: { type: 'system', id: 'it.advancer' },
            aggregate: { type: 'test', id: `advance-${n}` },
            payload: { caseId: opCase.id },
          },
          null
        )
      )
    );
    results.forEach((result) => expectStatus(result, 'completed'));
    expect(
      await prisma.stockReservation.count({ where: { caseId: opCase.id, status: 'active' } })
    ).toBe(1);
    expect(await activeReservedQuantity({ caseId: opCase.id })).toBe(5);
    const prepare = await stepOf(opCase.id, 'preparar_pedido');
    expect(
      await prisma.workItem.count({ where: { stepId: prepare.id, status: { in: OPEN_WORK } } })
    ).toBe(1);
    await expectStockInvariants();
  });

  it('comando repetido: la cola offline y los reintentos simultáneos no duplican efectos', async () => {
    const { team } = base;
    await seedControlledStock('it-item-block', 25);
    const order = await seedSalesOrder([{ zohoItemId: 'it-item-block', quantity: 10 }]);
    await seedPackage(order);
    const opCase = await startCaseViaJob(order);
    const prepareItem = await openWorkItemOfStep((await stepOf(opCase.id, 'preparar_pedido')).id);

    // El teléfono envía el mismo comando dos veces (se perdió la respuesta).
    const offline = {
      commandId: randomUUID(),
      type: 'workitem.complete',
      aggregate: { type: 'work_item', id: prepareItem.id },
      payload: { result: { issue_movements: 'Surtido sin señal' } },
    };
    const first = await runClientCommand(
      toDomainCommand(offline, team.byArea.inventario, 'it-device-1'),
      team.byArea.inventario
    );
    expect(first).toMatchObject({ status: 'completed', httpStatus: 200 });
    const again = await runClientCommand(
      toDomainCommand(offline, team.byArea.inventario, 'it-device-1'),
      team.byArea.inventario
    );
    expect(again).toMatchObject({ status: 'completed', replayed: true, httpStatus: 200 });
    expect(again.emittedEventIds).toEqual(first.emittedEventIds);
    await drainJobs();
    expect(await prisma.deliveryOrder.count({ where: { caseId: opCase.id } })).toBe(1);
    expect(
      await prisma.operationalEvent.count({
        where: { type: 'workitem.completed', objectId: prepareItem.id },
      })
    ).toBe(1);
    const tampered = await runClientCommand(
      toDomainCommand(
        { ...offline, payload: { result: { issue_movements: 'Otro contenido' } } },
        team.byArea.inventario
      ),
      team.byArea.inventario
    );
    expect(tampered).toMatchObject({ status: 'rejected', errorCode: 'command_id_conflict' });

    // Una versión desactualizada del expediente se rechaza sin tocar nada.
    const current = await prisma.operationalCase.findUniqueOrThrow({ where: { id: opCase.id } });
    const stale = await advanceCaseCommand(opCase.id, {
      actor: team.manager,
      expectedVersion: current.version + 5,
    });
    expect(stale).toMatchObject({ status: 'rejected', errorCode: 'version_conflict' });
    expect(
      (await prisma.operationalCase.findUniqueOrThrow({ where: { id: opCase.id } })).version
    ).toBe(current.version);

    // El mismo comando llega cuatro veces a la vez (reintentos de red en paralelo).
    const commandId = randomUUID();
    const claim = () =>
      claimLegacyStock(
        team.byArea.inventario,
        {
          zohoItemId: 'it-item-block',
          warehouseId: base.warehouseId,
          quantity: 2,
          unit: 'pz',
          source: 'verbal',
          reference: 'Apartado por teléfono',
        },
        { commandId }
      );
    const parallel = await Promise.all([claim(), claim(), claim(), claim()]);
    expect(parallel.some((r) => r.status === 'completed')).toBe(true);
    expect(parallel.every((r) => ['completed', 'accepted'].includes(r.status))).toBe(true);
    const settled = await claim();
    expect(settled).toMatchObject({ status: 'completed', replayed: true });
    expect(
      await prisma.legacyCommitmentClaim.count({ where: { zohoItemId: 'it-item-block' } })
    ).toBe(1);
    expect(await prisma.operationalCommand.count({ where: { id: commandId } })).toBe(1);
    expect(await stockOf('it-item-block')).toMatchObject({
      reserved: 10,
      claimed: 2,
      available: 13,
    });
  });

  it('el chofer entrega una cantidad distinta: remanente reabierto, reserva parcial e incidencia', async () => {
    const { team } = base;
    const { opCase, deliveryOrder } = await preparedCase('it-item-teja', 25, 10);
    zohoStoresShipment();
    zohoMarksDelivered();
    expectStatus(await assignOwnFleet(deliveryOrder.id), 'pending_external');
    await drainJobs();

    const photo = await uploadDeliveryEvidence(deliveryOrder.id, team.driver.id);
    const allocationId = deliveryOrder.allocationIds[0];
    const withoutEvidence = await recordDeliveryCommand(team.driver, {
      deliveryOrderId: deliveryOrder.id,
      lines: [{ allocationId, deliveredQty: 7 }],
      receivedBy: 'Juan Pérez',
      evidenceObjectIds: ['it-no-existe'],
    });
    expect(withoutEvidence).toMatchObject({ status: 'rejected', errorCode: 'evidence_invalid' });

    const partial = await recordDeliveryCommand(team.driver, {
      deliveryOrderId: deliveryOrder.id,
      lines: [{ allocationId, deliveredQty: 7 }],
      receivedBy: 'Juan Pérez',
      evidenceObjectIds: [photo],
      partialReason: 'El cliente sólo recibió 7 piezas',
    });
    expectStatus(partial, ['completed', 'pending_external']);
    expect(partial.data).toMatchObject({ complete: false, totalDelivered: 7, totalShort: 3 });
    await drainJobs();

    expect(
      await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryOrder.id } })
    ).toMatchObject({
      status: 'partially_delivered',
      partialReason: 'El cliente sólo recibió 7 piezas',
    });
    const allocation = await prisma.demandAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    expect(allocation.status).toBe('reopened');
    expect(Number(allocation.deliveredQuantity)).toBe(7);
    const child = await prisma.deliveryOrder.findUniqueOrThrow({
      where: { id: partial.data!.childDeliveryOrderId! },
    });
    expect(child).toMatchObject({
      status: 'pending',
      parentDeliveryOrderId: deliveryOrder.id,
      allocationIds: [allocationId],
    });
    expect(
      await prisma.incident.findFirstOrThrow({
        where: { caseId: opCase.id, kind: 'partial_delivery' },
      })
    ).toMatchObject({ areaKey: 'logistica' });
    const remainder = await prisma.workItem.findFirstOrThrow({
      where: { areaKey: 'ventas', objectId: child.id, status: { in: OPEN_WORK } },
    });
    expect(remainder.title).toContain('Decidir remanente');
    // Sólo se descuenta lo entregado; lo demás sigue reservado para el remanente.
    expect(await stockOf('it-item-teja')).toMatchObject({ known: 18, issued: 7, reserved: 3 });
    expect(await activeReservedQuantity({ caseId: opCase.id })).toBe(3);
    expect(await eventTypes({ caseId: opCase.id })).toEqual(
      expect.arrayContaining(['delivery.partial', 'allocation.reopened'])
    );
    await expectStockInvariants();
  });

  it('Zoho falla al asignar transportista: reintentos agotados → failed, incidencia y trabajo a Logística', async () => {
    const { opCase, deliveryOrder } = await preparedCase('it-item-perfil', 25, 10);
    mocks.shipPackage.mockRejectedValue(
      new PackageShippingError(
        'No se pudo crear la orden de envío en Zoho: tiempo de espera agotado',
        502
      )
    );
    expectStatus(await assignOwnFleet(deliveryOrder.id), 'pending_external');
    const runs = await drainJobs();

    const shipRuns = runs.filter((run) => run.type === 'ops.zoho.ship_package');
    expect(shipRuns.map((run) => run.outcome)).toEqual([
      'retry',
      'retry',
      'retry',
      'retry',
      'failed',
    ]);
    expect(mocks.shipPackage).toHaveBeenCalledTimes(5);
    expect(
      await prisma.backgroundJob.findFirstOrThrow({ where: { type: 'ops.zoho.ship_package' } })
    ).toMatchObject({ status: 'failed', attempts: 5 });
    const failed = await prisma.deliveryOrder.findUniqueOrThrow({
      where: { id: deliveryOrder.id },
    });
    expect(failed).toMatchObject({ status: 'failed', zohoSyncState: 'failed' });
    expect(failed.zohoError).toContain('tiempo de espera');
    expect(
      await prisma.incident.findFirstOrThrow({ where: { caseId: opCase.id, kind: 'zoho_failure' } })
    ).toMatchObject({ areaKey: 'logistica', severity: 'high', status: 'open' });
    expect(
      await prisma.workItem.count({
        where: { kind: 'external_sync', objectId: deliveryOrder.id, status: { in: OPEN_WORK } },
      })
    ).toBe(1);
    expect(await eventTypes({ caseId: opCase.id })).toContain('zoho.shipment_failed');
    expect((await stepOf(opCase.id, 'asignar_transporte')).status).not.toBe('done');

    // A trip loading it writes the shipment again instead of confirming the failed write.
    const trip = await buildTripCommand(base.team.byArea.logistica, {
      date: today(),
      vehicleId: base.vehicleId,
      driverId: base.driverId,
      deliveryOrderIds: [deliveryOrder.id],
    });
    expectStatus(trip, 'completed');
    expectStatus(
      await startTripCommand(base.team.driver, { tripId: trip.data!.tripId }),
      'completed'
    );
    expect(
      await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryOrder.id } })
    ).toMatchObject({ status: 'pending_external', zohoSyncState: 'pending_write' });
    expect(
      await prisma.backgroundJob.count({
        where: { type: 'ops.zoho.ship_package', status: 'pending' },
      })
    ).toBe(1);
    expect((await stepOf(opCase.id, 'asignar_transporte')).status).not.toBe('done');
  });

  it('un viaje con una entrega sin transporte asignado escribe el embarque y el paso sólo cierra con la relectura', async () => {
    const { opCase, deliveryOrder } = await preparedCase('it-item-teja', 25, 10);
    const trip = await buildTripCommand(base.team.byArea.logistica, {
      date: today(),
      vehicleId: base.vehicleId,
      driverId: base.driverId,
      deliveryOrderIds: [deliveryOrder.id],
    });
    expectStatus(trip, 'completed');
    expectStatus(
      await startTripCommand(base.team.driver, { tripId: trip.data!.tripId }),
      'completed'
    );
    expect(
      await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryOrder.id } })
    ).toMatchObject({
      status: 'pending_external',
      zohoSyncState: 'pending_write',
      vehicleId: base.vehicleId,
      driverId: base.driverId,
    });
    expect((await stepOf(opCase.id, 'asignar_transporte')).status).not.toBe('done');

    zohoStoresShipment();
    await drainJobs();
    expect(mocks.shipPackage).toHaveBeenCalledTimes(1);
    expect(
      await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryOrder.id } })
    ).toMatchObject({ status: 'dispatched', zohoSyncState: 'readback_ok' });
    expect((await stepOf(opCase.id, 'asignar_transporte')).status).toBe('done');
  });

  it('Zoho devuelve un valor distinto: conflicto con los valores de Zoho, incidencia y decisión de Logística', async () => {
    const { opCase, deliveryOrder } = await preparedCase('it-item-canal', 25, 10);
    zohoStoresShipment({ carrier: 'DHL Express', trackingNumber: 'DHL999' });
    expectStatus(await assignOwnFleet(deliveryOrder.id, 'IT-TRK-9'), 'pending_external');
    await drainJobs();

    const conflicted = await prisma.deliveryOrder.findUniqueOrThrow({
      where: { id: deliveryOrder.id },
    });
    expect(conflicted).toMatchObject({
      status: 'conflict',
      zohoSyncState: 'readback_mismatch',
      carrier: 'DHL Express',
    });
    const differences = (conflicted.conflictDetail as { differences: Array<{ field: string }> })
      .differences;
    expect(differences.map((d) => d.field)).toEqual(
      expect.arrayContaining(['carrier', 'trackingNumber'])
    );
    expect(
      await prisma.incident.findFirstOrThrow({
        where: { caseId: opCase.id, kind: 'zoho_conflict' },
      })
    ).toMatchObject({ areaKey: 'logistica', status: 'open' });
    expect(
      await prisma.workItem.findFirstOrThrow({
        where: { kind: 'external_sync', objectId: deliveryOrder.id, status: { in: OPEN_WORK } },
      })
    ).toMatchObject({ areaKey: 'logistica', ownerUserId: base.team.byArea.logistica.id });
    expect(await eventTypes({ caseId: opCase.id })).toContain('zoho.shipment_conflict');
    expect((await stepOf(opCase.id, 'asignar_transporte')).status).not.toBe('done');
  });

  it('responsable ausente: el trabajo pasa al suplente y, sin nadie disponible, se abre una sola incidencia', async () => {
    const { team } = base;
    await seedControlledStock('it-item-arena', 50);
    const firstCase = await startCaseViaJob(
      await seedSalesOrder([{ zohoItemId: 'it-item-arena', quantity: 5 }])
    );
    const prepareItem = await openWorkItemOfStep(
      (await stepOf(firstCase.id, 'preparar_pedido')).id
    );
    expect(prepareItem).toMatchObject({
      ownerUserId: team.byArea.inventario.id,
      backupUserId: team.inventoryBackup.id,
    });

    await prisma.user.update({
      where: { id: team.byArea.inventario.id },
      data: { isActive: false },
    });
    const tick = await runSupervisorTick({ now: new Date() });
    expect(tick.skipped).toBeNull();
    expect(tick.counters.absentOwners.errors).toBe(0);
    expect(
      await prisma.workItem.findUniqueOrThrow({ where: { id: prepareItem.id } })
    ).toMatchObject({
      ownerUserId: team.inventoryBackup.id,
    });
    expect(
      await prisma.operationalEvent.count({
        where: { type: 'workitem.reassigned', objectId: prepareItem.id },
      })
    ).toBe(1);

    // El trabajo nuevo de Inventario nace con el suplente.
    const secondCase = await startCaseViaJob(
      await seedSalesOrder([{ zohoItemId: 'it-item-arena', quantity: 5 }])
    );
    expect(
      await openWorkItemOfStep((await stepOf(secondCase.id, 'preparar_pedido')).id)
    ).toMatchObject({ ownerUserId: team.inventoryBackup.id });

    // Compras sin suplente y Administración también ausente: nadie puede tomarlo.
    await prisma.user.updateMany({
      where: { id: { in: [team.byArea.compras.id, team.byArea.administracion.id] } },
      data: { isActive: false },
    });
    const orphanWork = await prisma.workItem.create({
      data: {
        areaKey: 'compras',
        kind: 'action',
        title: 'Cotizar lámina galvanizada',
        ownerUserId: team.byArea.compras.id,
        dueAt: new Date(Date.now() + 8 * 60 * 60_000),
      },
    });
    const noReplacement = await runSupervisorTick({ now: new Date() });
    expect(noReplacement.counters.absentOwners.errors).toBe(0);
    const incident = await prisma.incident.findUniqueOrThrow({
      where: { dedupeKey: `owner_absent:${team.byArea.compras.id}:compras` },
    });
    expect(incident).toMatchObject({ kind: 'owner_absent', areaKey: 'compras', status: 'open' });
    expect(
      (await prisma.workItem.findUniqueOrThrow({ where: { id: orphanWork.id } })).ownerUserId
    ).toBe(team.byArea.compras.id);
    await runSupervisorTick({ now: new Date() });
    expect(
      await prisma.incident.count({ where: { kind: 'owner_absent', areaKey: 'compras' } })
    ).toBe(1);
  });

  it('supervisor idempotente: el mismo hallazgo con el mismo reloj, en serie o desde dos instancias, actúa una vez', async () => {
    await seedControlledStock('it-item-grava', 50);
    const caseA = await startCaseViaJob(
      await seedSalesOrder([{ zohoItemId: 'it-item-grava', quantity: 5 }])
    );
    const caseB = await startCaseViaJob(
      await seedSalesOrder([{ zohoItemId: 'it-item-grava', quantity: 5 }])
    );
    const itemA = await openWorkItemOfStep((await stepOf(caseA.id, 'preparar_pedido')).id);
    const itemB = await openWorkItemOfStep((await stepOf(caseB.id, 'preparar_pedido')).id);
    await prisma.workItem.update({
      where: { id: itemA.id },
      data: { dueAt: new Date(Date.now() - 30 * 60_000) },
    });

    const snapshot = async () => ({
      events: await prisma.operationalEvent.count({ where: { type: { not: 'supervisor.tick' } } }),
      workItems: await prisma.workItem.count(),
      incidents: await prisma.incident.count(),
      jobs: await prisma.backgroundJob.count(),
      notifications: await prisma.notification.count(),
      versions: (
        await prisma.workItem.findMany({ orderBy: { id: 'asc' }, select: { version: true } })
      ).map((w) => w.version),
    });

    const now = new Date();
    const first = await runSupervisorTick({ now });
    expect(first.counters.overdueWorkItems).toMatchObject({ actions: 1, errors: 0 });
    expect(
      await prisma.operationalEvent.count({
        where: { type: 'workitem.overdue', objectId: itemA.id },
      })
    ).toBe(1);
    const before = await snapshot();
    const second = await runSupervisorTick({ now });
    expect(second.totals).toMatchObject({ actions: 0, incidents: 0, errors: 0 });
    expect(await snapshot()).toEqual(before);

    // Dos instancias ven el mismo vencimiento a la vez: el ledger deja pasar una sola ejecución.
    await prisma.workItem.update({
      where: { id: itemB.id },
      data: { dueAt: new Date(Date.now() - 30 * 60_000) },
    });
    const later = new Date(now.getTime() + 60_000);
    const versionBefore = (await prisma.workItem.findUniqueOrThrow({ where: { id: itemB.id } }))
      .version;
    const [left, right] = await Promise.all([
      runSupervisorTick({ now: later }),
      runSupervisorTick({ now: later }),
    ]);
    expect(left.totals.errors + right.totals.errors).toBe(0);
    expect(
      await prisma.operationalEvent.count({
        where: { type: 'workitem.overdue', objectId: itemB.id },
      })
    ).toBe(1);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: itemB.id } })).version).toBe(
      versionBefore + 1
    );
    expect(
      await prisma.operationalEvent.count({
        where: { type: 'workitem.overdue', objectId: itemA.id },
      })
    ).toBe(1);
    expect(await prisma.incident.count()).toBe(0);
  });
});

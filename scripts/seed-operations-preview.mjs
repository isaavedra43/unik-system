#!/usr/bin/env node
/**
 * Demo data for the operations experience, on a LOCAL, DISPOSABLE database.
 *
 * It grows the six areas out of the demo sales orders that already live in the
 * database, so every screen of `/app/areas/*`, the 360 case file, "Mi trabajo"
 * and the Control Tower open with coherent numbers instead of empty states:
 *
 *   · cases in every phase (planning → sourcing → preparing → delivering → closing);
 *   · demands whose stock is controlled, provisional and unknown;
 *   · purchasing with an RFQ, a supplier order and a PARTIAL goods receipt;
 *   · a transformation production order in progress;
 *   · deliveries with a trip, and one stuck in conflict with Zoho;
 *   · expenses, one of them a suspected duplicate;
 *   · opportunities and radar signals;
 *   · incidents, cross-area requests and OVERDUE work items;
 *   · operational events, so the Control Tower projections have something to chew.
 *
 * REFUSES to run against anything but `unik_preview` / `unik_schema_check`.
 *
 * Idempotent: every row carries a `seed-*` id, so running it twice leaves the
 * same database. `--reset` deletes what it planted before seeding again.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user@localhost:5432/unik_preview \
 *     node --experimental-strip-types scripts/seed-operations-preview.mjs [--reset]
 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  SALES_FULFILLMENT_BLUEPRINT,
  SALES_FULFILLMENT_PROCESS_KEY,
  SALES_FULFILLMENT_VERSION,
} from '../src/modules/operations/process-blueprints/sales-fulfillment.ts';

const ALLOWED_DATABASES = new Set(['unik_preview', 'unik_schema_check']);
const PREFIX = 'seed';
const id = (...parts) => [PREFIX, ...parts].join('-');

// ---------------------------------------------------------------------------
// Clock: everything is relative to "now" so the demo never looks stale.
// ---------------------------------------------------------------------------
const NOW = new Date();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms) => new Date(NOW.getTime() + ms);

/**
 * The CIVIL day in Mexico City, stored as UTC midnight — the same day the
 * operation works in (`operationDay` / `LOGISTICS_TIMEZONE`).
 *
 * Taking the UTC date instead is wrong for six hours every night: seeded late
 * in the evening, the trips and deliveries landed on tomorrow and the dispatch
 * board — which opens on today — looked empty for no visible reason.
 */
const OPERATION_TIMEZONE = 'America/Mexico_City';
const day = (ms) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATION_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
};

function databaseName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

/**
 * Same fingerprint the engine computes (`canonicalJson` + `toOperationalJson`
 * in registry.ts). Copied here on purpose: the seeded `ProcessVersion` must be
 * byte-identical to what `ensureProcessVersion` would publish, or the engine
 * refuses the version with `process_version_mismatch` the first time someone
 * starts a case.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const plainJson = (value) => JSON.parse(JSON.stringify(value ?? {}));

const log = (event, extra = {}) => console.log(JSON.stringify({ seed: event, ...extra }));

// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');
  const dbName = databaseName(url);
  if (!ALLOWED_DATABASES.has(dbName)) {
    throw new Error(
      `Este script sólo siembra bases desechables locales (${[...ALLOWED_DATABASES].join(', ')}); DATABASE_URL apunta a "${dbName}".`
    );
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (process.argv.includes('--reset')) await reset(prisma);
    const ctx = await baseline(prisma);
    await seedInventory(prisma, ctx);
    await seedCrm(prisma, ctx);
    await seedCases(prisma, ctx);
    await seedPurchases(prisma, ctx);
    await seedManufacturing(prisma, ctx);
    await seedLogistics(prisma, ctx);
    await seedFinance(prisma, ctx);
    await seedWorkAndRequests(prisma, ctx);
    await seedEvents(prisma, ctx);
    await seedChat(prisma, ctx);
    await summary(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/** Deletes only what this script plants (`seed-*`), newest dependency first. */
async function reset(prisma) {
  const like = { startsWith: `${PREFIX}-` };
  const byId = { where: { id: like } };
  const steps = [
    () => prisma.operationalEvent.deleteMany({ where: { commandId: like } }),
    () => prisma.internalChatMessage.deleteMany(byId),
    () => prisma.internalChatMember.deleteMany(byId),
    // El enlace se suelta ANTES de borrar el canal: `chatChannelId` no tiene FK.
    () => prisma.area.updateMany({ where: { chatChannelId: like }, data: { chatChannelId: null } }),
    () =>
      prisma.operationalCase.updateMany({
        where: { chatChannelId: like },
        data: { chatChannelId: null },
      }),
    () => prisma.internalChatChannel.deleteMany(byId),
    () => prisma.objectRelation.deleteMany(byId),
    () => prisma.evidenceLink.deleteMany(byId),
    () => prisma.radarSignal.deleteMany(byId),
    () => prisma.opportunityActivity.deleteMany(byId),
    () => prisma.opportunity.deleteMany(byId),
    () => prisma.expenseSplit.deleteMany(byId),
    () => prisma.expense.deleteMany(byId),
    () => prisma.tripStop.deleteMany(byId),
    () => prisma.trip.deleteMany(byId),
    () => prisma.deliveryOrder.deleteMany(byId),
    () => prisma.productionOperation.deleteMany(byId),
    () => prisma.productionOrder.deleteMany(byId),
    () => prisma.goodsReceiptLine.deleteMany(byId),
    () => prisma.goodsReceipt.deleteMany(byId),
    () => prisma.procurementOrderLine.deleteMany(byId),
    () => prisma.procurementOrder.deleteMany(byId),
    () => prisma.rfqResponseLine.deleteMany(byId),
    () => prisma.rfqResponse.deleteMany(byId),
    () => prisma.rfqInvitation.deleteMany(byId),
    () => prisma.rfqLine.deleteMany(byId),
    () => prisma.rfq.deleteMany(byId),
    () => prisma.purchaseRequestLine.deleteMany(byId),
    () => prisma.purchaseRequest.deleteMany(byId),
    () => prisma.supplier.deleteMany(byId),
    () => prisma.incident.deleteMany(byId),
    () => prisma.areaRequest.deleteMany(byId),
    () => prisma.workItem.deleteMany(byId),
    () => prisma.stockReservation.deleteMany(byId),
    () => prisma.stockMovement.deleteMany(byId),
    () => prisma.stockCountLine.deleteMany(byId),
    () => prisma.stockCount.deleteMany(byId),
    () => prisma.stockItem.deleteMany(byId),
    () => prisma.storageLocation.deleteMany(byId),
    () => prisma.demandAllocation.deleteMany(byId),
    () => prisma.caseStep.deleteMany(byId),
    () => prisma.caseDemand.deleteMany(byId),
    () => prisma.operationalCase.deleteMany(byId),
    () => prisma.productInventoryProfile.deleteMany(byId),
    () => prisma.workCenter.deleteMany(byId),
    () => prisma.vehicle.deleteMany(byId),
    () => prisma.driver.deleteMany(byId),
    () => prisma.warehouse.deleteMany(byId),
    () => prisma.cashAccount.deleteMany(byId),
    () => prisma.financeCategory.deleteMany(byId),
    () => prisma.pipelineStage.deleteMany(byId),
    () => prisma.responsible.deleteMany(byId),
    () => prisma.ctCaseVariant.deleteMany({ where: { caseId: like } }),
  ];
  let removed = 0;
  for (const step of steps) {
    try {
      const result = await step();
      removed += result.count ?? 0;
    } catch (err) {
      // A model that does not exist in this schema version is not a reason to stop.
      log('reset_skip', {
        message: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    }
  }
  log('reset_done', { removed });
}

// ---------------------------------------------------------------------------
// Baseline: areas, the process version, responsibles, warehouses, catalogues
// ---------------------------------------------------------------------------

const AREAS = [
  ['ventas', 'Ventas'],
  ['compras', 'Compras'],
  ['inventario', 'Inventario'],
  ['manufactura', 'Manufactura'],
  ['logistica', 'Logística'],
  ['contabilidad', 'Contabilidad'],
  ['administracion', 'Administración'],
];

async function baseline(prisma) {
  const admin = await prisma.userRole.findFirst({
    where: { role: { key: 'super_admin' }, user: { isActive: true, isBot: false } },
    include: { user: { select: { id: true, name: true, username: true } } },
    orderBy: { userId: 'asc' },
  });
  if (!admin)
    throw new Error(
      'La base no tiene ningún super admin activo: no hay a quién asignarle el trabajo.'
    );
  const userId = admin.user.id;

  // Areas (the app seeds these at boot too; `skipDuplicates` keeps both safe).
  await prisma.area.createMany({
    data: AREAS.map(([key, label], index) => ({
      key,
      label,
      responsibleArea: key,
      sortOrder: (index + 1) * 10,
      active: true,
    })),
    skipDuplicates: true,
  });

  // One responsible per area so the core has somebody to assign work to.
  for (const [key, label] of AREAS) {
    await prisma.responsible.upsert({
      where: { id: id('resp', key) },
      create: {
        id: id('resp', key),
        area: key,
        label: `Responsable de ${label}`,
        userId,
        active: true,
      },
      update: { userId, active: true },
    });
  }

  // The published blueprint, with the checksum the engine itself would compute.
  const definition = plainJson(SALES_FULFILLMENT_BLUEPRINT);
  const checksum = createHash('sha256').update(canonicalJson(definition), 'utf8').digest('hex');
  const process = await prisma.processVersion.upsert({
    where: {
      processKey_version: {
        processKey: SALES_FULFILLMENT_PROCESS_KEY,
        version: SALES_FULFILLMENT_VERSION,
      },
    },
    create: {
      processKey: SALES_FULFILLMENT_PROCESS_KEY,
      version: SALES_FULFILLMENT_VERSION,
      definition,
      checksum,
      active: true,
    },
    update: {},
  });

  const warehouse = await prisma.warehouse.upsert({
    where: { key: 'mty-central' },
    create: {
      id: id('wh', 'mty'),
      key: 'mty-central',
      name: 'Bodega Monterrey Centro',
      active: true,
    },
    update: {},
  });
  const warehouse2 = await prisma.warehouse.upsert({
    where: { key: 'saltillo' },
    create: { id: id('wh', 'saltillo'), key: 'saltillo', name: 'Bodega Saltillo', active: true },
    update: {},
  });

  const orders = await prisma.salesOrder.findMany({
    include: { items: true },
    orderBy: { orderDate: 'asc' },
  });
  log('baseline', { areas: AREAS.length, processVersionId: process.id, orders: orders.length });
  return {
    userId,
    userName: admin.user.name ?? admin.user.username,
    process,
    warehouse,
    warehouse2,
    orders,
  };
}

// ---------------------------------------------------------------------------
// Inventory: locations, item profiles with the three confidences, stock, a count
// ---------------------------------------------------------------------------

/**
 * Confidence of each demo product. These are the module's own levels
 * (`CONFIDENCE_LEVELS`, upper case): all four are represented so the map, the
 * dashboard tiles and the "SKUs en disputa" number all have something to show.
 */
const CONFIDENCE_BY_ITEM = {
  'demo-product-1': 'CONTROLLED',
  'demo-product-2': 'CONTROLLED',
  'demo-product-3': 'PROVISIONAL',
  'demo-product-4': 'CONTROLLED',
  'demo-product-5': 'UNCOUNTED',
  'demo-product-6': 'PROVISIONAL',
  'demo-product-7': 'CONTROLLED',
  'demo-product-8': 'DISPUTED',
  'demo-product-9': 'PROVISIONAL',
  'demo-product-10': 'UNCOUNTED',
};

async function seedInventory(prisma, ctx) {
  const products = await prisma.product.findMany({ orderBy: { zohoItemId: 'asc' } });

  const locations = [];
  const racks = ['A', 'B', 'C'];
  for (const rack of racks) {
    for (let level = 1; level <= 4; level += 1) {
      const code = `${rack}-0${level}`;
      locations.push(
        await prisma.storageLocation.upsert({
          where: { id: id('loc', rack, String(level)) },
          create: {
            id: id('loc', rack, String(level)),
            warehouseId: ctx.warehouse.id,
            code,
            label: `Pasillo ${rack}, nivel ${level}`,
            kind: 'rack',
            active: true,
          },
          update: {},
        })
      );
    }
  }
  // One receiving bay, so the map is not just racks.
  locations.push(
    await prisma.storageLocation.upsert({
      where: { id: id('loc', 'recibo') },
      create: {
        id: id('loc', 'recibo'),
        warehouseId: ctx.warehouse.id,
        code: 'RECIBO',
        label: 'Andén de recibo',
        kind: 'floor',
        active: true,
      },
      update: {},
    })
  );

  for (const [index, product] of products.entries()) {
    const confidence = CONFIDENCE_BY_ITEM[product.zohoItemId] ?? 'unknown';
    await prisma.productInventoryProfile.upsert({
      where: { zohoItemId: product.zohoItemId },
      create: {
        id: id('prof', product.zohoItemId),
        zohoItemId: product.zohoItemId,
        baseUnit: product.unit ?? 'pza',
        conversions: {},
        tolerancePct: confidence === 'CONTROLLED' ? 1 : 3,
        isBulk: false,
        trackingPolicy: 'none',
        variantAxes: [],
        defaultSource: index % 4 === 3 ? 'manufacture' : 'stock',
        confidence,
        consecutiveGoodCounts:
          confidence === 'CONTROLLED' ? 3 : confidence === 'PROVISIONAL' ? 1 : 0,
        lastCountAt: confidence === 'UNCOUNTED' ? null : at(-(index + 2) * DAY),
        controlledAt: confidence === 'CONTROLLED' ? at(-(index + 2) * DAY) : null,
      },
      update: { confidence },
    });

    const location = locations[index % locations.length];
    const baseline = 40 + index * 7;
    const issued = index * 2;
    await prisma.stockItem.upsert({
      where: { id: id('stock', product.zohoItemId) },
      create: {
        id: id('stock', product.zohoItemId),
        zohoItemId: product.zohoItemId,
        warehouseId: ctx.warehouse.id,
        locationId: location.id,
        variantKey: '',
        baseline,
        issued,
        knownQty: baseline - issued,
        lastCountedAt: confidence === 'UNCOUNTED' ? null : at(-(index + 2) * DAY),
      },
      update: {},
    });

    // A few movements today so "movimientos" and the dashboard tile are not empty.
    if (index < 5) {
      await prisma.stockMovement.upsert({
        where: { id: id('mov', product.zohoItemId) },
        create: {
          id: id('mov', product.zohoItemId),
          stockItemId: id('stock', product.zohoItemId),
          zohoItemId: product.zohoItemId,
          warehouseId: ctx.warehouse.id,
          kind: index % 2 === 0 ? 'issue' : 'receipt',
          quantity: 2 + index,
          originalQuantity: 2 + index,
          originalUnit: product.unit ?? 'pza',
          referenceType: 'seed',
          referenceId: id('mov', product.zohoItemId),
          actorId: ctx.userId,
          note: 'Movimiento de demostración',
          occurredAt: at(-(index + 1) * HOUR),
        },
        update: {},
      });
    }
  }

  // An open count in progress (the map shows it in its lane).
  await prisma.stockCount.upsert({
    where: { id: id('count', 'a') },
    create: {
      id: id('count', 'a'),
      warehouseId: ctx.warehouse.id,
      // Valores válidos del enum: spot | cycle | full (inventory-types.ts).
      scope: 'spot',
      status: 'in_progress',
      startedBy: ctx.userId,
      createdAt: at(-30 * HOUR),
    },
    update: {},
  });
  const countLines = products.slice(0, 3);
  for (const [index, product] of countLines.entries()) {
    const expected = 40 + index * 7;
    // The third line is already counted and four pieces short: a real difference to resolve.
    const counted = index === 2 ? expected - 4 : expected;
    await prisma.stockCountLine.upsert({
      where: { id: id('countline', String(index)) },
      create: {
        id: id('countline', String(index)),
        count: { connect: { id: id('count', 'a') } },
        stockItemId: id('stock', product.zohoItemId),
        expectedQty: expected,
        countedQty: counted,
        unit: product.unit ?? 'pza',
        diffQty: counted - expected,
        withinTolerance: counted === expected,
        resolution: index === 2 ? 'disputed' : 'accepted',
        countedBy: ctx.userId,
        countedAt: at(-2 * HOUR),
      },
      update: {},
    });
  }
  log('inventory', { locations: locations.length, profiles: products.length });
  return products;
}

// ---------------------------------------------------------------------------
// CRM: pipeline, opportunities and radar signals
// ---------------------------------------------------------------------------

const STAGES = [
  ['nuevo', 'Nuevo', 10, 0.1],
  ['calificado', 'Calificado', 20, 0.3],
  ['cotizado', 'Cotizado', 30, 0.5],
  ['negociacion', 'Negociación', 40, 0.7],
  ['ganado', 'Ganado', 50, 1],
  ['perdido', 'Perdido', 60, 0],
];

async function seedCrm(prisma, ctx) {
  for (const [key, name, order, probability] of STAGES) {
    await prisma.pipelineStage.upsert({
      where: { key },
      create: {
        id: id('stage', key),
        key,
        name,
        order,
        probabilityDefault: probability,
        kind: key === 'ganado' ? 'won' : key === 'perdido' ? 'lost' : 'open',
        slaHours: 72,
        active: true,
      },
      update: {},
    });
  }
  const stages = Object.fromEntries(
    (await prisma.pipelineStage.findMany()).map((stage) => [stage.key, stage.id])
  );

  const opportunities = [
    [
      'a',
      'Reposición de lámina para nave 3',
      'Comercializadora del Valle S.A. de C.V.',
      'calificado',
      48500,
      0.3,
      -6,
    ],
    ['b', 'Cableado eléctrico obra Apodaca', 'Ferretería La Unión', 'cotizado', 92300, 0.5, -3],
    [
      'c',
      'Estructura metálica bodega norte',
      'Grupo Industrial Pacífico',
      'negociacion',
      187400,
      0.7,
      -12,
    ],
    [
      'd',
      'Mantenimiento anual de herramienta',
      'Distribuidora Hermanos Torres',
      'nuevo',
      21750,
      0.1,
      -1,
    ],
    ['e', 'Suministro de concreto Q4', 'Constructora Nuevo León', 'ganado', 64900, 1, -20],
  ];
  for (const [key, title, contactName, stageKey, value, probability, daysAgo] of opportunities) {
    await prisma.opportunity.upsert({
      where: { id: id('opp', key) },
      create: {
        id: id('opp', key),
        number: `OPP-${String(opportunities.findIndex((o) => o[0] === key) + 1).padStart(6, '0')}`,
        title,
        contactName,
        salespersonUserId: ctx.userId,
        stageId: stages[stageKey],
        stageEnteredAt: at(daysAgo * DAY),
        estimatedValue: value,
        currency: 'MXN',
        probability,
        expectedCloseAt: at((10 + daysAgo) * DAY),
        nextActionAt: stageKey === 'ganado' ? null : at((daysAgo % 3) * DAY + 2 * DAY),
        nextActionText: stageKey === 'ganado' ? null : 'Confirmar alcance con el cliente',
        source: 'inbound',
        status: stageKey === 'ganado' ? 'won' : stageKey === 'perdido' ? 'lost' : 'open',
        wonAt: stageKey === 'ganado' ? at(daysAgo * DAY) : null,
        lastActivityAt: at(daysAgo * DAY + 4 * HOUR),
        createdAt: at(daysAgo * DAY - 2 * DAY),
      },
      update: {},
    });
    await prisma.opportunityActivity.upsert({
      where: { id: id('oppact', key) },
      create: {
        id: id('oppact', key),
        opportunityId: id('opp', key),
        kind: 'note',
        summary: 'El cliente pidió revisar tiempos de entrega antes de firmar.',
        userId: ctx.userId,
        at: at(daysAgo * DAY + 4 * HOUR),
      },
      update: {},
    });
  }

  // `kind` and `status` are the module's own vocabulary (RADAR_KINDS / RADAR_STATUSES):
  // an invented value is not rejected by the database, it just never matches the query
  // and the radar looks empty for no visible reason.
  const signals = [
    ['a', 'quote_expiring', 'La cotización vence en 2 días y no hay respuesta', 82, 'b'],
    ['b', 'next_action_overdue', 'La siguiente acción venció hace 3 días', 74, 'c'],
    ['c', 'no_followup', 'Sin seguimiento desde hace 6 días', 55, 'a'],
    ['d', 'repurchase_overdue', 'Cliente recurrente sin pedido este mes', 41, 'd'],
    ['e', 'no_first_reply', 'El cliente escribió y nadie ha contestado', 68, 'b'],
  ];
  for (const [key, kind, reason, score, oppKey] of signals) {
    await prisma.radarSignal.upsert({
      where: { id: id('signal', key) },
      create: {
        id: id('signal', key),
        kind,
        subjectKey: `${kind}:${id('opp', oppKey)}`,
        opportunityId: id('opp', oppKey),
        customerName: opportunities.find((o) => o[0] === oppKey)?.[2] ?? null,
        salespersonUserId: ctx.userId,
        score,
        reason,
        data: { origen: 'seed' },
        computedAt: at(-2 * HOUR),
        expiresAt: at(7 * DAY),
        status: 'active',
      },
      update: {},
    });
  }
  log('crm', {
    stages: STAGES.length,
    opportunities: opportunities.length,
    signals: signals.length,
  });
}

// ---------------------------------------------------------------------------
// Cases: one per phase, with demands, allocations and steps
// ---------------------------------------------------------------------------

/** The five open cases, one per phase of the blueprint, plus a closed one. */
const CASE_PLAN = [
  {
    key: 'a',
    order: 'demo-so-1',
    phase: 'planning',
    status: 'open',
    priority: 'normal',
    promisedInDays: 6,
  },
  {
    key: 'b',
    order: 'demo-so-2',
    phase: 'sourcing',
    status: 'waiting',
    priority: 'high',
    promisedInDays: 3,
  },
  {
    key: 'c',
    order: 'demo-so-3',
    phase: 'preparing',
    status: 'blocked',
    priority: 'urgent',
    promisedInDays: 1,
  },
  {
    key: 'd',
    order: 'demo-so-5',
    phase: 'delivering',
    status: 'open',
    priority: 'normal',
    promisedInDays: -1,
  },
  {
    key: 'e',
    order: 'demo-so-4',
    phase: 'closing',
    status: 'ready_to_close',
    priority: 'normal',
    promisedInDays: 2,
  },
];

/** How far the steps of a case are, by phase. */
const PHASE_ORDER = ['planning', 'sourcing', 'preparing', 'delivering', 'closing'];

async function seedCases(prisma, ctx) {
  const blueprint = SALES_FULFILLMENT_BLUEPRINT;
  const created = [];
  let seq = 1000;

  for (const plan of CASE_PLAN) {
    const order = ctx.orders.find((candidate) => candidate.zohoSalesOrderId === plan.order);
    if (!order) continue;
    seq += 1;
    const caseId = id('case', plan.key);
    const openedAt = at(-(8 - PHASE_ORDER.indexOf(plan.phase)) * DAY);

    await prisma.operationalCase.upsert({
      where: { id: caseId },
      create: {
        id: caseId,
        caseSeq: seq,
        caseNumber: `EXP-${seq}`,
        kind: 'sales_fulfillment',
        sourceType: 'sales_order',
        sourceId: order.zohoSalesOrderId,
        zohoSalesOrderId: order.zohoSalesOrderId,
        salesOrderNumber: order.salesOrderNumber,
        customerName: order.customerName,
        salespersonName: ctx.userName,
        locationId: ctx.warehouse.id,
        locationName: ctx.warehouse.name,
        deliveryMethod: 'entrega_propia',
        orderDate: order.orderDate,
        processVersionId: ctx.process.id,
        status: plan.status,
        phase: plan.phase,
        priority: plan.priority,
        ownerUserId: ctx.userId,
        promisedAt: at(plan.promisedInDays * DAY),
        openedAt,
        lastActivityAt: at(-2 * HOUR),
        closedAt: null,
      },
      update: {},
    });

    // Demands: one per order line, with the confidence of its product.
    const demands = [];
    for (const [index, item] of order.items.entries()) {
      const demandId = id('demand', plan.key, String(index));
      const confidence = CONFIDENCE_BY_ITEM[item.zohoItemId ?? ''] ?? 'unknown';
      const status =
        plan.phase === 'planning'
          ? index === 0
            ? 'verifying'
            : 'pending'
          : plan.phase === 'sourcing'
            ? 'planned'
            : plan.phase === 'closing'
              ? 'fulfilled'
              : 'allocated';
      await prisma.caseDemand.upsert({
        where: { id: demandId },
        create: {
          id: demandId,
          caseId,
          lineRef: `idx:${index}`,
          zohoItemId: item.zohoItemId,
          sku: null,
          name: item.name,
          quantity: item.quantity,
          unit: item.unit ?? 'pza',
          baseQuantity: item.quantity,
          baseUnit: item.unit ?? 'pza',
          locationId: ctx.warehouse.id,
          status,
          fulfilledQuantity: status === 'fulfilled' ? item.quantity : 0,
          sortOrder: index,
        },
        update: {},
      });
      demands.push({ id: demandId, item, confidence, status });

      // Allocation: stock when the item is controlled, purchase/manufacture otherwise.
      if (plan.phase !== 'planning') {
        const source =
          confidence === 'CONTROLLED' ? 'stock' : index === 1 ? 'manufacture' : 'purchase';
        const allocationId = id('alloc', plan.key, String(index));
        await prisma.demandAllocation.upsert({
          where: { id: allocationId },
          create: {
            id: allocationId,
            demandId,
            caseId,
            source,
            quantity: item.quantity,
            status:
              plan.phase === 'closing'
                ? 'delivered'
                : plan.phase === 'delivering'
                  ? 'released'
                  : source === 'stock'
                    ? 'reserved'
                    : 'requested',
            warehouseId: ctx.warehouse.id,
            expectedAt: at(2 * DAY),
            deliveredQuantity: plan.phase === 'closing' ? item.quantity : 0,
          },
          update: {},
        });

        // A real reservation for the controlled items, so Inventory shows them.
        if (source === 'stock') {
          await prisma.stockReservation.upsert({
            where: { id: id('resv', plan.key, String(index)) },
            create: {
              id: id('resv', plan.key, String(index)),
              stockItemId: id('stock', item.zohoItemId),
              zohoItemId: item.zohoItemId,
              warehouseId: ctx.warehouse.id,
              caseId,
              demandId,
              allocationId,
              quantity: item.quantity,
              status: plan.phase === 'closing' ? 'consumed' : 'active',
              confidenceAtReserve: confidence,
              expiresAt: at(5 * DAY),
            },
            update: {},
          });
        }
      }
    }

    // Steps: everything before the current phase is done, the current one is active.
    const phaseIndex = PHASE_ORDER.indexOf(plan.phase);
    for (const step of blueprint.steps) {
      const stepPhaseIndex = PHASE_ORDER.indexOf(step.phase);
      const scopes = step.scope === 'demand' ? demands.map((demand) => demand.id) : [''];
      for (const scopeKey of scopes) {
        const stepId = id('step', plan.key, step.key, scopeKey || 'case');
        const status =
          stepPhaseIndex < phaseIndex
            ? 'done'
            : stepPhaseIndex > phaseIndex
              ? 'pending'
              : plan.status === 'blocked'
                ? 'waiting'
                : 'active';
        const startedAt =
          status === 'pending' ? null : at(-(phaseIndex - stepPhaseIndex + 1) * DAY);
        await prisma.caseStep.upsert({
          where: { id: stepId },
          create: {
            id: stepId,
            caseId,
            processVersionId: ctx.process.id,
            stepKey: step.key,
            scope: step.scope ?? 'case',
            scopeKey,
            demandId: step.scope === 'demand' ? scopeKey : null,
            areaKey: step.areaKey,
            kind: step.kind,
            status,
            dependsOn: step.dependsOn ?? [],
            slaMinutes: step.slaMinutes ?? 0,
            dueAt:
              status === 'done'
                ? null
                : at(
                    (stepPhaseIndex - phaseIndex) * DAY + (plan.key === 'c' ? -6 * HOUR : 6 * HOUR)
                  ),
            startedAt,
            completedAt: status === 'done' ? at(-(phaseIndex - stepPhaseIndex) * DAY) : null,
          },
          update: {},
        });
      }
    }

    // The graph of the Control Tower: the case hangs off its sales order.
    await relate(
      prisma,
      id('rel', 'case', plan.key),
      'operational_case',
      caseId,
      'sales_order',
      order.zohoSalesOrderId,
      'originates_from'
    );
    created.push({ caseId, plan, order, demands });
  }

  ctx.cases = created;
  log('cases', { cases: created.length });
}

async function relate(prisma, rowId, fromType, fromId, toType, toId, relation) {
  await prisma.objectRelation.upsert({
    where: { fromType_fromId_toType_toId_relation: { fromType, fromId, toType, toId, relation } },
    create: { id: rowId, fromType, fromId, toType, toId, relation },
    update: {},
  });
}

// ---------------------------------------------------------------------------
// Purchases: supplier, request, RFQ with a response, order and PARTIAL receipt
// ---------------------------------------------------------------------------

async function seedPurchases(prisma, ctx) {
  const target = ctx.cases.find((entry) => entry.plan.key === 'b') ?? ctx.cases[0];
  if (!target) return;

  const suppliers = [
    ['acero', 'Aceros y Perfiles del Norte', 'ventas@acerosnorte.mx', '8112345678', 12],
    ['electro', 'Electro Insumos Monterrey', 'cotizaciones@electroinsumos.mx', '8187654321', 7],
    ['cemento', 'Materiales Pétreos Saltillo', 'contacto@petreossaltillo.mx', '8441122334', 20],
  ];
  for (const [key, name, email, phone, leadTime] of suppliers) {
    await prisma.supplier.upsert({
      where: { id: id('sup', key) },
      create: {
        id: id('sup', key),
        number: `PRV-${key.toUpperCase()}`,
        name,
        status: 'active',
        primaryEmail: email,
        primaryPhone: phone,
        paymentTermsDays: 30,
        paymentMode: 'credit',
        currency: 'MXN',
        leadTimeDaysDefault: leadTime,
        ratingOverall: 4.2,
        ratingOnTime: 4.0,
        ratingQuality: 4.5,
        createdByUserId: ctx.userId,
      },
      update: {},
    });
  }

  const item = target.demands[0]?.item;
  if (!item) return;

  await prisma.purchaseRequest.upsert({
    where: { id: id('preq', 'a') },
    create: {
      id: id('preq', 'a'),
      number: 'SC-000001',
      caseId: target.caseId,
      requestedByUserId: ctx.userId,
      areaKey: 'compras',
      status: 'sourcing',
      priority: 'high',
      neededBy: at(4 * DAY),
      reason: 'Faltante confirmado para el expediente',
    },
    update: {},
  });
  await prisma.purchaseRequestLine.upsert({
    where: { id: id('preqline', 'a') },
    create: {
      id: id('preqline', 'a'),
      requestId: id('preq', 'a'),
      demandId: target.demands[0].id,
      zohoItemId: item.zohoItemId,
      description: item.name,
      qty: item.quantity,
      unit: item.unit ?? 'pza',
      qtyOrdered: item.quantity,
      status: 'ordered',
      sortOrder: 0,
    },
    update: {},
  });

  await prisma.rfq.upsert({
    where: { id: id('rfq', 'a') },
    create: {
      id: id('rfq', 'a'),
      number: 'RFQ-000001',
      title: `Cotización de ${item.name}`,
      status: 'compared',
      dueAt: at(2 * DAY),
      createdByUserId: ctx.userId,
    },
    update: {},
  });
  await prisma.rfqLine.upsert({
    where: { id: id('rfqline', 'a') },
    create: {
      id: id('rfqline', 'a'),
      rfqId: id('rfq', 'a'),
      requestLineId: id('preqline', 'a'),
      zohoItemId: item.zohoItemId,
      description: item.name,
      qty: item.quantity,
      unit: item.unit ?? 'pza',
      sortOrder: 0,
    },
    update: {},
  });
  for (const [index, [key]] of suppliers.slice(0, 2).entries()) {
    await prisma.rfqInvitation.upsert({
      where: { id: id('rfqinv', key) },
      create: {
        id: id('rfqinv', key),
        rfqId: id('rfq', 'a'),
        supplierId: id('sup', key),
        channel: 'email',
        status: index === 0 ? 'replied' : 'sent',
        sentAt: at(-2 * DAY),
      },
      update: {},
    });
  }
  await prisma.rfqResponse.upsert({
    where: { id: id('rfqresp', 'a') },
    create: {
      id: id('rfqresp', 'a'),
      rfqId: id('rfq', 'a'),
      invitationId: id('rfqinv', 'acero'),
      supplierId: id('sup', 'acero'),
      receivedVia: 'email',
      currency: 'MXN',
      taxIncluded: false,
      taxRate: 0.16,
      freight: 450,
      leadTimeDays: 10,
      validUntil: at(12 * DAY),
      paymentTerms: '30 días',
      landedTotal: 18450,
      score: 0.82,
      specMatch: 0.9,
      confidence: 0.75,
      status: 'parsed',
      createdAt: at(-1 * DAY),
    },
    update: {},
  });

  const order = await prisma.procurementOrder.upsert({
    where: { id: id('poc', 'a') },
    create: {
      id: id('poc', 'a'),
      number: 'OC-000001',
      supplierId: id('sup', 'acero'),
      rfqResponseId: id('rfqresp', 'a'),
      status: 'partially_received',
      currency: 'MXN',
      subtotal: 16000,
      taxTotal: 2560,
      freight: 450,
      total: 19010,
      paymentMode: 'credit',
      paymentStatus: 'unpaid',
      expectedAt: at(1 * DAY),
      deliveryMode: 'warehouse',
      warehouseId: ctx.warehouse.id,
      sentToSupplierAt: at(-1 * DAY),
      sentVia: 'email',
      createdByUserId: ctx.userId,
    },
    update: {},
  });
  await prisma.procurementOrderLine.upsert({
    where: { id: id('pocline', 'a') },
    create: {
      id: id('pocline', 'a'),
      orderId: order.id,
      requestLineId: id('preqline', 'a'),
      zohoItemId: item.zohoItemId,
      description: item.name,
      qty: 10,
      unit: item.unit ?? 'pza',
      unitPrice: 1600,
      taxRate: 0.16,
      lineTotal: 16000,
      // Partial receipt: 6 of 10 arrived, one of them rejected.
      qtyReceived: 6,
      qtyAccepted: 5,
      qtyRejected: 1,
      status: 'partial',
      sortOrder: 0,
    },
    update: {},
  });
  await prisma.goodsReceipt.upsert({
    where: { id: id('rec', 'a') },
    create: {
      id: id('rec', 'a'),
      number: 'RC-000001',
      orderId: order.id,
      receivedByUserId: ctx.userId,
      receivedAt: at(-4 * HOUR),
      mode: 'warehouse',
      warehouseId: ctx.warehouse.id,
      locationId: id('loc', 'recibo'),
      status: 'posted',
      notes: 'Llegaron 6 de 10; una pieza con golpe se rechazó.',
    },
    update: {},
  });
  await prisma.goodsReceiptLine.upsert({
    where: { id: id('recline', 'a') },
    create: {
      id: id('recline', 'a'),
      receiptId: id('rec', 'a'),
      orderLineId: id('pocline', 'a'),
      qtyReceived: 6,
      qtyAccepted: 5,
      qtyRejected: 1,
      unit: item.unit ?? 'pza',
      differenceKind: 'damaged',
    },
    update: {},
  });

  await relate(
    prisma,
    id('rel', 'poc', 'a'),
    'operational_case',
    target.caseId,
    'procurement_order',
    order.id,
    'covered_by'
  );
  await relate(
    prisma,
    id('rel', 'sup', 'a'),
    'procurement_order',
    order.id,
    'supplier',
    id('sup', 'acero'),
    'ordered_to'
  );
  log('purchases', { suppliers: suppliers.length, order: order.number, receipt: 'parcial 6/10' });
}

// ---------------------------------------------------------------------------
// Manufacturing: work centres and a transformation order in progress
// ---------------------------------------------------------------------------

async function seedManufacturing(prisma, ctx) {
  const centres = [
    ['corte', 'Corte y habilitado', 120],
    ['soldadura', 'Soldadura', 80],
    ['pintura', 'Pintura y acabado', 60],
  ];
  for (const [key, name, capacity] of centres) {
    await prisma.workCenter.upsert({
      where: { key },
      create: {
        id: id('wc', key),
        key,
        name,
        warehouseId: ctx.warehouse.id,
        capacityPerShift: capacity,
        capacityUnit: 'pza',
        shifts: [{ name: 'Matutino', start: '07:00', end: '15:00' }],
        costPerHour: 320,
        currency: 'MXN',
        status: 'active',
      },
      update: {},
    });
  }

  const target = ctx.cases.find((entry) => entry.plan.key === 'c') ?? ctx.cases[0];
  const demand = target?.demands[1] ?? target?.demands[0];
  if (!demand) return;

  await prisma.productionOrder.upsert({
    where: { id: id('prod', 'a') },
    create: {
      id: id('prod', 'a'),
      number: 'OP-000001',
      kind: 'transformation',
      caseId: target.caseId,
      demandId: demand.id,
      outputZohoItemId: demand.item.zohoItemId ?? 'demo-product-2',
      outputName: `${demand.item.name} (habilitado a medida)`,
      plannedQty: demand.item.quantity,
      plannedUnit: demand.item.unit ?? 'pza',
      producedQty: 3,
      scrapQty: 1,
      status: 'in_progress',
      priority: 'high',
      plannedStartAt: at(-1 * DAY),
      plannedEndAt: at(1 * DAY),
      startedAt: at(-20 * HOUR),
      workCenterId: id('wc', 'corte'),
      releaseTarget: 'case',
      outputWarehouseId: ctx.warehouse.id,
      inputs: [{ zohoItemId: 'demo-product-2', qty: 8, unit: 'pza' }],
      createdByUserId: ctx.userId,
    },
    update: {},
  });
  const operations = [
    ['corte', 'Cortar a medida', 'done', -20],
    ['soldadura', 'Soldar refuerzos', 'running', -4],
    ['pintura', 'Pintura final', 'pending', 8],
  ];
  for (const [index, [centre, name, status, hours]] of operations.entries()) {
    await prisma.productionOperation.upsert({
      where: { id: id('prodop', String(index)) },
      create: {
        id: id('prodop', String(index)),
        productionOrderId: id('prod', 'a'),
        seq: index + 1,
        workCenterId: id('wc', centre),
        name,
        status,
        assignedUserId: ctx.userId,
        plannedStartAt: at(hours * HOUR),
        plannedMinutes: 180,
        startedAt: status === 'pending' ? null : at(hours * HOUR),
        finishedAt: status === 'done' ? at((hours + 3) * HOUR) : null,
        actualMinutes: status === 'done' ? 195 : null,
      },
      update: {},
    });
  }
  await relate(
    prisma,
    id('rel', 'prod', 'a'),
    'operational_case',
    target.caseId,
    'production_order',
    id('prod', 'a'),
    'covered_by'
  );
  log('manufacturing', { centres: centres.length, order: 'OP-000001' });
}

// ---------------------------------------------------------------------------
// Logistics: fleet, a trip with stops, and a delivery in conflict with Zoho
// ---------------------------------------------------------------------------

async function seedLogistics(prisma, ctx) {
  const vehicles = [
    ['t01', 'TON-01', 'ABC-12-34', 'Camioneta 3.5 t'],
    ['t02', 'TON-02', 'XYZ-98-76', 'Torton 8 t'],
  ];
  for (const [key, code, plate, label] of vehicles) {
    await prisma.vehicle.upsert({
      where: { id: id('veh', key) },
      create: { id: id('veh', key), code, plate, label, capacityKg: 3500, active: true },
      update: {},
    });
  }
  await prisma.driver.upsert({
    where: { id: id('drv', 'a') },
    create: {
      id: id('drv', 'a'),
      userId: ctx.userId,
      name: ctx.userName,
      phone: '8110002000',
      active: true,
    },
    update: {},
  });

  const trip = await prisma.trip.upsert({
    where: { id: id('trip', 'a') },
    create: {
      id: id('trip', 'a'),
      number: 'VJ-000001',
      date: day(0),
      vehicleId: id('veh', 't01'),
      driverId: id('drv', 'a'),
      status: 'en_route',
      startedAt: at(-3 * HOUR),
      notes: 'Ruta norte',
    },
    update: {},
  });

  const delivering = ctx.cases.find((entry) => entry.plan.key === 'd');
  const closing = ctx.cases.find((entry) => entry.plan.key === 'e');
  const planning = ctx.cases.find((entry) => entry.plan.key === 'a');

  const deliveries = [
    {
      key: 'a',
      entry: delivering,
      status: 'dispatched',
      zohoSyncState: 'readback_ok',
      stop: { sequence: 1, status: 'pending' },
    },
    {
      key: 'b',
      entry: closing,
      status: 'delivered',
      zohoSyncState: 'delivered_written',
      stop: { sequence: 2, status: 'done' },
    },
    {
      // The one that matters for the demo: Zoho disagreed and it is stuck. The
      // delivery carries the conflict in its own status too — that is what the
      // Control Tower counts as "entregas en conflicto".
      key: 'c',
      entry: planning,
      status: 'conflict',
      zohoSyncState: 'readback_mismatch',
      stop: null,
    },
  ];

  for (const delivery of deliveries) {
    if (!delivery.entry) continue;
    await prisma.deliveryOrder.upsert({
      where: { id: id('del', delivery.key) },
      create: {
        id: id('del', delivery.key),
        caseId: delivery.entry.caseId,
        allocationIds: [],
        mode: 'own_fleet',
        status: delivery.status,
        carrier: 'Flotilla UNIK',
        vehicleId: id('veh', 't01'),
        driverId: id('drv', 'a'),
        tripId: delivery.stop ? trip.id : null,
        plannedDate: day(delivery.key === 'c' ? 1 : 0),
        windowStart: at(delivery.key === 'c' ? 26 * HOUR : 2 * HOUR),
        windowEnd: at(delivery.key === 'c' ? 30 * HOUR : 6 * HOUR),
        addressLine: 'Av. Constitución 1200, Col. Centro',
        city: 'Monterrey',
        state: 'Nuevo León',
        postalCode: '64000',
        contactName: delivery.entry.order.customerName,
        contactPhone: '8112223344',
        lat: 25.6714 + Number(`0.0${delivery.key.charCodeAt(0) % 9}`),
        lng: -100.309 - Number(`0.0${delivery.key.charCodeAt(0) % 7}`),
        zohoSyncState: delivery.zohoSyncState,
        zohoLastAttemptAt: delivery.zohoSyncState === 'readback_mismatch' ? at(-2 * HOUR) : null,
        zohoError:
          delivery.zohoSyncState === 'readback_mismatch'
            ? 'Zoho devolvió otro transportista para este envío; hay que decidir cuál vale.'
            : null,
        conflictDetail:
          delivery.zohoSyncState === 'readback_mismatch'
            ? { campo: 'carrier', unik: 'Flotilla UNIK', zoho: 'Paquetería Express' }
            : undefined,
        deliveredAt: delivery.status === 'delivered' ? at(-5 * HOUR) : null,
        receivedBy: delivery.status === 'delivered' ? 'Ing. Ramírez' : null,
      },
      update: {},
    });
    if (delivery.stop) {
      await prisma.tripStop.upsert({
        where: { id: id('stop', delivery.key) },
        create: {
          id: id('stop', delivery.key),
          tripId: trip.id,
          deliveryOrderId: id('del', delivery.key),
          sequence: delivery.stop.sequence,
          status: delivery.stop.status,
          etaAt: at(delivery.stop.sequence * 2 * HOUR),
          arrivedAt: delivery.stop.status === 'done' ? at(-5 * HOUR) : null,
          lat: 25.6714,
          lng: -100.309,
        },
        update: {},
      });
    }
    await relate(
      prisma,
      id('rel', 'del', delivery.key),
      'operational_case',
      delivery.entry.caseId,
      'delivery_order',
      id('del', delivery.key),
      'delivered_by'
    );
  }
  log('logistics', { vehicles: vehicles.length, trip: trip.number, deliveries: deliveries.length });
}

// ---------------------------------------------------------------------------
// Finance: accounts, categories and expenses (one a suspected duplicate)
// ---------------------------------------------------------------------------

async function seedFinance(prisma, ctx) {
  const accounts = [
    ['caja-chica', 'Caja chica Monterrey', 'cash', 15000],
    ['banco-bbva', 'BBVA 1234', 'bank', 480000],
  ];
  for (const [key, name, kind, balance] of accounts) {
    await prisma.cashAccount.upsert({
      where: { key },
      create: {
        id: id('acct', key),
        key,
        name,
        kind,
        currency: 'MXN',
        openingBalance: balance,
        currentBalance: balance,
        status: 'active',
      },
      update: {},
    });
  }
  const categories = [
    ['combustible', 'Combustible', 'expense'],
    ['fletes', 'Fletes y maniobras', 'expense'],
    ['materiales', 'Materiales', 'expense'],
  ];
  for (const [key, name, kind] of categories) {
    await prisma.financeCategory.upsert({
      where: { key },
      create: { id: id('cat', key), key, name, kind, isDirect: true, status: 'active' },
      update: {},
    });
  }

  const expenses = [
    ['a', 'Diésel ruta norte', 2450, 'combustible', 'posted', 'none'],
    ['b', 'Maniobras de descarga', 1800, 'fletes', 'pending_approval', 'none'],
    // Same amount, same day, same supplier as (a): the duplicate detector must flag it.
    ['c', 'Diésel ruta norte', 2450, 'combustible', 'draft', 'suspect'],
    ['d', 'Consumibles de soldadura', 960, 'materiales', 'approved', 'none'],
  ];
  for (const [key, description, amount, category, status, duplicateStatus] of expenses) {
    await prisma.expense.upsert({
      where: { id: id('exp', key) },
      create: {
        id: id('exp', key),
        number: `GX-${String(expenses.findIndex((e) => e[0] === key) + 1).padStart(6, '0')}`,
        status,
        captureMode: key === 'c' ? 'photo' : 'form',
        amount,
        currency: 'MXN',
        date: day(-1 * DAY),
        supplierNameFree: 'Gasolinera del Valle',
        categoryId: id('cat', category),
        cashAccountId: id('acct', 'caja-chica'),
        paymentMethod: 'cash',
        isPaid: status === 'posted',
        description,
        duplicateKey: `${amount}:${description}`,
        duplicateOfId: duplicateStatus === 'suspect' ? id('exp', 'a') : null,
        duplicateStatus,
        createdByUserId: ctx.userId,
        postedAt: status === 'posted' ? at(-20 * HOUR) : null,
      },
      update: {},
    });
  }
  log('finance', { accounts: accounts.length, expenses: expenses.length, duplicates: 1 });
}

// ---------------------------------------------------------------------------
// Work items, cross-area requests and incidents
// ---------------------------------------------------------------------------

async function seedWorkAndRequests(prisma, ctx) {
  const byKey = Object.fromEntries(ctx.cases.map((entry) => [entry.plan.key, entry]));

  const workItems = [
    // Overdue on purpose: "Mi trabajo" and every dashboard must show the red number.
    [
      'a',
      'inventario',
      'verification',
      'Contar lámina galvanizada en A-02',
      'open',
      -6 * HOUR,
      'a',
    ],
    [
      'b',
      'compras',
      'action',
      'Comparar respuestas de la RFQ-000001',
      'in_progress',
      4 * HOUR,
      'b',
    ],
    [
      'c',
      'logistica',
      'external_sync',
      'Resolver conflicto con Zoho del envío',
      'escalated',
      -26 * HOUR,
      'a',
    ],
    ['d', 'manufactura', 'action', 'Cerrar operación de soldadura', 'open', 8 * HOUR, 'c'],
    ['e', 'contabilidad', 'approval', 'Autorizar gasto de maniobras', 'open', 20 * HOUR, 'd'],
    ['f', 'ventas', 'action', 'Confirmar promesa con el cliente', 'open', -2 * HOUR, 'c'],
  ];
  ctx.workItems = [];
  for (const [key, areaKey, kind, title, status, dueOffset, caseKey] of workItems) {
    const entry = byKey[caseKey];
    ctx.workItems.push({
      id: id('wi', key),
      areaKey,
      kind,
      title,
      caseId: entry?.caseId ?? null,
    });
    await prisma.workItem.upsert({
      where: { id: id('wi', key) },
      create: {
        id: id('wi', key),
        caseId: entry?.caseId ?? null,
        areaKey,
        kind,
        title,
        description: 'Pendiente de demostración generado por el seed.',
        status,
        ownerUserId: ctx.userId,
        dueAt: at(dueOffset),
        escalationLevel: status === 'escalated' ? 1 : 0,
        escalatedAt: status === 'escalated' ? at(-2 * HOUR) : null,
        createdAt: at(dueOffset - 2 * DAY),
      },
      update: {},
    });
  }

  const requests = [
    [
      'a',
      'ventas',
      'compras',
      'purchase_shortfall',
      'Faltan 4 piezas para completar el pedido',
      'sent',
      true,
      -3 * HOUR,
      'b',
    ],
    [
      'b',
      'inventario',
      'ventas',
      'availability_check',
      'Confirmar si el cliente acepta sustituto',
      'acknowledged',
      false,
      12 * HOUR,
      'a',
    ],
    [
      'c',
      'logistica',
      'contabilidad',
      'payment_authorization',
      'Autorizar pago de flete externo',
      'sent',
      false,
      30 * HOUR,
      'd',
    ],
    [
      'd',
      'compras',
      'inventario',
      'resolve_difference',
      'Diferencia en recepción: 1 pieza rechazada',
      'accepted',
      false,
      -10 * HOUR,
      'b',
    ],
  ];
  for (const [key, from, to, kind, title, status, blocks, dueOffset, caseKey] of requests) {
    const entry = byKey[caseKey];
    if (!entry) continue;
    await prisma.areaRequest.upsert({
      where: { id: id('req', key) },
      create: {
        id: id('req', key),
        caseId: entry.caseId,
        fromAreaKey: from,
        toAreaKey: to,
        kind,
        objectType: 'operational_case',
        objectId: entry.caseId,
        title,
        payload: {},
        freeText: 'El cliente insiste en que no puede recibir después del viernes.',
        priority: blocks ? 'urgent' : 'normal',
        status,
        blocksDelivery: blocks,
        dueAt: at(dueOffset),
        ownerUserId: ctx.userId,
        createdByType: 'user',
        createdById: ctx.userId,
        createdAt: at(dueOffset - 1 * DAY),
      },
      update: {},
    });
  }

  const incidents = [
    ['a', 'logistica', 'zoho_conflict', 'high', 'Zoho devolvió otro transportista', 'open', 'a'],
    [
      'b',
      'compras',
      'purchase_difference',
      'medium',
      'Recepción parcial con 1 pieza rechazada',
      'acknowledged',
      'b',
    ],
    ['c', 'inventario', 'count_dispute', 'medium', 'Conteo en disputa en A-03', 'open', 'c'],
    [
      'd',
      'manufactura',
      'excess_scrap',
      'low',
      'Merma por encima del 5% en corte',
      'resolved',
      'c',
    ],
  ];
  for (const [key, areaKey, kind, severity, title, status, caseKey] of incidents) {
    const entry = byKey[caseKey];
    await prisma.incident.upsert({
      where: { id: id('inc', key) },
      create: {
        id: id('inc', key),
        caseId: entry?.caseId ?? null,
        areaKey,
        kind,
        severity,
        status,
        title,
        detail: { origen: 'seed' },
        ownerUserId: ctx.userId,
        dedupeKey: id('inc', key),
        openedAt: at(-(2 + (key.charCodeAt(0) % 5)) * HOUR),
        resolvedAt: status === 'resolved' ? at(-1 * HOUR) : null,
        resolvedBy: status === 'resolved' ? ctx.userId : null,
        resolution: status === 'resolved' ? 'Se ajustó el programa de corte.' : null,
      },
      update: {},
    });
  }
  log('work', {
    workItems: workItems.length,
    requests: requests.length,
    incidents: incidents.length,
  });
}

// ---------------------------------------------------------------------------
// Internal chat: the area channel and the case room with a real conversation
// ---------------------------------------------------------------------------

/**
 * Without this, every area channel and every case room was captured as "Sin
 * mensajes", so nobody ever saw how a conversation is painted inside
 * Comunicaciones. The channels are the same rows `ensureAreaChannel` /
 * `ensureCaseRoom` create (`type: 'area' | 'case'`, linked from
 * `Area.chatChannelId` / `OperationalCase.chatChannelId`), so the bridge simply
 * adopts them on the first visit.
 */
async function seedChat(prisma, ctx) {
  /**
   * Devuelve el canal donde escribir: el que ya esté ENLAZADO (el arranque del
   * servidor crea los canales de área la primera vez) o uno propio del seed
   * cuando todavía no hay ninguno. Escribir siempre en uno nuevo dejaba los
   * mensajes en un canal que la pantalla no muestra.
   */
  const ensureChannel = async (key, type, name, readLink, link) => {
    const existing = await readLink();
    if (existing) {
      const row = await prisma.internalChatChannel.findUnique({
        where: { id: existing },
        select: { id: true },
      });
      if (row) {
        await prisma.internalChatMember.upsert({
          where: { channelId_userId: { channelId: row.id, userId: ctx.userId } },
          create: {
            id: id('member', key),
            channelId: row.id,
            userId: ctx.userId,
            role: 'member',
            joinedAt: at(-3 * DAY),
            lastReadAt: at(-3 * DAY),
          },
          update: {},
        });
        return row.id;
      }
    }
    const channelId = id('chan', key);
    await prisma.internalChatChannel.upsert({
      where: { id: channelId },
      create: {
        id: channelId,
        type,
        name,
        createdBy: ctx.userId,
        createdAt: at(-3 * DAY),
        lastMessageAt: at(-2 * HOUR),
      },
      update: { name },
    });
    await prisma.internalChatMember.upsert({
      where: { channelId_userId: { channelId, userId: ctx.userId } },
      create: {
        id: id('member', key),
        channelId,
        userId: ctx.userId,
        role: 'owner',
        joinedAt: at(-3 * DAY),
        lastReadAt: at(-3 * DAY),
      },
      update: {},
    });
    await link(channelId);
    return channelId;
  };

  const messages = async (key, channelId, lines) => {
    let newest = null;
    for (const [index, [text, hoursAgo]] of lines.entries()) {
      const createdAt = at(-hoursAgo * HOUR);
      if (!newest || createdAt > newest) newest = createdAt;
      await prisma.internalChatMessage.upsert({
        where: { id: id('msg', key, String(index)) },
        create: {
          id: id('msg', key, String(index)),
          channelId,
          senderId: ctx.userId,
          content: text,
          createdAt,
        },
        // `channelId` también se actualiza: el canal enlazado puede cambiar.
        update: { content: text, channelId, createdAt },
      });
    }
    if (newest) {
      await prisma.internalChatChannel.update({
        where: { id: channelId },
        data: { lastMessageAt: newest },
      });
    }
  };

  const ventasChannel = await ensureChannel(
    'area-ventas',
    'area',
    'Ventas',
    async () =>
      (await prisma.area.findUnique({ where: { key: 'ventas' }, select: { chatChannelId: true } }))
        ?.chatChannelId ?? null,
    (channelId) =>
      prisma.area.updateMany({
        where: { key: 'ventas', chatChannelId: null },
        data: { chatChannelId: channelId },
      })
  );
  await messages('area-ventas', ventasChannel, [
    ['Buen día. Hoy salen las entregas de la ruta norte; avisen si algo no sale a tiempo.', 26],
    [
      'La orden SO-00003 ya tiene su material apartado, falta confirmar la promesa con el cliente.',
      6,
    ],
    ['Confirmado con el cliente: recibe mañana entre 9 y 11.', 2],
  ]);

  const caseEntry = ctx.cases.find((entry) => entry.plan.key === 'c') ?? ctx.cases[0];
  if (caseEntry) {
    const roomChannel = await ensureChannel(
      'case-room',
      'case',
      `Venta ${caseEntry.order.salesOrderNumber ?? caseEntry.plan.key}`.slice(0, 100),
      async () =>
        (
          await prisma.operationalCase.findUnique({
            where: { id: caseEntry.caseId },
            select: { chatChannelId: true },
          })
        )?.chatChannelId ?? null,
      (channelId) =>
        prisma.operationalCase.updateMany({
          where: { id: caseEntry.caseId, chatChannelId: null },
          data: { chatChannelId: channelId },
        })
    );
    await messages('case-room', roomChannel, [
      ['Abrimos la sala de esta venta para que todo quede aquí.', 30],
      ['Inventario: faltan 4 piezas, ya se pidió a Compras.', 20],
      ['Compras: el proveedor confirma entrega el jueves.', 4],
    ]);
  }

  log('chat', { canales: caseEntry ? 2 : 1 });
}

// ---------------------------------------------------------------------------
// Operational events: what the Control Tower projections read
// ---------------------------------------------------------------------------

async function seedEvents(prisma, ctx) {
  // Deleted and rewritten on every run: events have a composite id and no natural key here.
  await prisma.operationalEvent.deleteMany({ where: { commandId: { startsWith: `${PREFIX}-` } } });

  const rows = [];
  let counter = 0;
  const workItems = ctx.workItems ?? [];
  /**
   * The Replay folds the state out of these events, so a `workitem.*` event
   * must carry the work item it talks about: without `workItemId` and `title`
   * the timeline showed "Trabajo sin título" and kept the case id as the work
   * item id.
   */
  const workItemFor = (areaKey, caseId) =>
    workItems.find((item) => item.areaKey === areaKey && item.caseId === caseId) ??
    workItems.find((item) => item.areaKey === areaKey) ??
    workItems[0] ??
    null;

  const pushEvent = (type, areaKey, when, entry) => {
    counter += 1;
    const item = type.startsWith('workitem.') ? workItemFor(areaKey, entry.caseId) : null;
    rows.push({
      occurredAt: when,
      recordedAt: when,
      caseId: entry.caseId,
      areaKey,
      type,
      actorType: 'system',
      actorId: 'seed',
      commandId: id('cmd', String(counter)),
      objectType: item ? 'work_item' : 'operational_case',
      objectId: item ? item.id : entry.caseId,
      payload: item
        ? {
            workItemId: item.id,
            title: item.title,
            kind: item.kind,
            phase: entry.plan?.phase,
            seed: true,
          }
        : { phase: entry.plan?.phase, seed: true },
    });
  };

  for (const entry of ctx.cases) {
    const phaseIndex = PHASE_ORDER.indexOf(entry.plan.phase);
    const base = -(8 - phaseIndex) * DAY;
    const timeline = [
      ['case.started', 'ventas', 0],
      ['demand.verified', 'inventario', 3 * HOUR],
      ['demand.allocated', 'ventas', 8 * HOUR],
      ['request.created', 'compras', 12 * HOUR],
      ['workitem.created', 'inventario', 14 * HOUR],
      ['workitem.completed', 'inventario', 20 * HOUR],
      ['case.phase_changed', 'ventas', 26 * HOUR],
    ];
    for (const [type, areaKey, offset] of timeline.slice(0, 3 + phaseIndex)) {
      pushEvent(type, areaKey, at(base + offset), entry);
    }
  }
  // Movement in the last 24 h, spread over the hours, so the Control Tower's
  // "actividad de las últimas 24 horas" is a curve and not an empty state.
  const recent = [
    ['workitem.created', 'inventario', 22],
    ['request.created', 'compras', 19],
    ['workitem.completed', 'compras', 16],
    ['demand.verified', 'inventario', 13],
    ['request.acknowledged', 'contabilidad', 10],
    ['workitem.escalated', 'logistica', 7],
    ['incident.opened', 'logistica', 5],
    ['workitem.created', 'manufactura', 3],
    ['demand.allocated', 'ventas', 2],
    ['case.phase_changed', 'ventas', 1],
  ];
  for (const [type, areaKey, hoursAgo] of recent) {
    const entry = ctx.cases[counter % ctx.cases.length];
    if (!entry) break;
    pushEvent(type, areaKey, at(-hoursAgo * HOUR), entry);
  }

  if (rows.length > 0) await prisma.operationalEvent.createMany({ data: rows });
  log('events', { events: rows.length, last24h: recent.length });
}

// ---------------------------------------------------------------------------

async function summary(prisma) {
  const counts = {
    expedientes: await prisma.operationalCase.count(),
    necesidades: await prisma.caseDemand.count(),
    pasos: await prisma.caseStep.count(),
    pendientes: await prisma.workItem.count(),
    solicitudes: await prisma.areaRequest.count(),
    incidencias: await prisma.incident.count(),
    ordenesCompra: await prisma.procurementOrder.count(),
    ordenesProduccion: await prisma.productionOrder.count(),
    entregas: await prisma.deliveryOrder.count(),
    gastos: await prisma.expense.count(),
    oportunidades: await prisma.opportunity.count(),
    senales: await prisma.radarSignal.count(),
    eventos: await prisma.operationalEvent.count(),
  };
  log('done', counts);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});

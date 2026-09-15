import { Prisma } from '@prisma/client';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { FakePrisma, Relation, Row } from '@/modules/comms/testing/fake-prisma';
import { createCaseFake } from '@/modules/operations/testing/case-fixtures';
import { seedUser } from '@/modules/operations/testing/fixtures';

/**
 * Test fixtures of Compras: the case engine fake (operations + inventory +
 * logistics models) extended with the purchases, finance-obligation and comms
 * models as they are in prisma/schema.prisma (defaults, unique keys and the
 * relations the services query through), plus seed helpers.
 *
 * Pure test helper (no `@/lib/prisma`): import it from `vi.hoisted`.
 */

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
const zero = () => D(0);

interface UniqueRule {
  fields: string[];
  applies: (row: Row) => boolean;
  same: (a: unknown, b: unknown) => boolean;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Prisma.Decimal.isDecimal(a) || Prisma.Decimal.isDecimal(b)) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return D(a as Prisma.Decimal.Value).equals(b as Prisma.Decimal.Value);
  }
  return a === b;
}

const PURCHASES_DEFAULTS: Record<string, () => Row> = {
  supplier: () => ({
    legalName: null,
    taxRegNo: null,
    zohoContactId: null,
    status: 'active',
    channels: [],
    primaryPhone: null,
    primaryEmail: null,
    website: null,
    commContactId: null,
    paymentTermsDays: null,
    paymentMode: 'prepaid',
    currency: 'MXN',
    leadTimeDaysDefault: null,
    freightTerms: null,
    ratingOverall: null,
    ratingOnTime: null,
    ratingQuality: null,
    ratingPrice: null,
    evaluationsCount: 0,
    lastEvaluatedAt: null,
    sourceCandidateId: null,
    tags: [],
    notes: null,
    version: 1,
  }),
  supplierProduct: () => ({
    zohoItemId: '',
    supplierSku: '',
    unitFactorToBase: D(1),
    lastPrice: null,
    currency: 'MXN',
    lastQuotedAt: null,
    leadTimeDays: null,
    minOrderQty: null,
    source: 'manual',
  }),
  supplierEvaluation: () => ({ orderId: null, receiptId: null, comment: null }),
  purchaseRequest: () => ({ caseId: null, status: 'draft', priority: 'normal', neededBy: null, reason: null, version: 1 }),
  purchaseRequestLine: () => ({
    demandId: null,
    allocationId: null,
    zohoItemId: null,
    consolidationKey: null,
    qtyOrdered: zero(),
    qtyReceived: zero(),
    status: 'open',
    sortOrder: 0,
  }),
  rfq: () => ({ status: 'draft', dueAt: null, sourcingSearchId: null, version: 1 }),
  rfqLine: () => ({ requestLineId: null, zohoItemId: null, specs: null, sortOrder: 0 }),
  rfqInvitation: () => ({
    supplierId: null,
    candidateId: null,
    accountId: null,
    conversationId: null,
    messageId: null,
    status: 'pending',
    sentAt: null,
    repliedAt: null,
    error: null,
  }),
  rfqResponse: () => ({
    invitationId: null,
    supplierId: null,
    candidateId: null,
    sourceMessageIds: [],
    currency: 'MXN',
    exchangeRate: null,
    taxIncluded: false,
    taxRate: null,
    freight: zero(),
    otherCosts: zero(),
    leadTimeDays: null,
    validUntil: null,
    paymentTerms: null,
    landedTotal: null,
    score: null,
    specMatch: null,
    riskScore: null,
    confidence: null,
    interpretation: null,
    status: 'parsed',
    reviewedByUserId: null,
    version: 1,
  }),
  rfqResponseLine: () => ({ unitFactorToBase: D(1), landedUnitCost: null }),
  procurementOrder: () => ({
    rfqResponseId: null,
    status: 'draft',
    currency: 'MXN',
    subtotal: zero(),
    taxTotal: zero(),
    freight: zero(),
    total: zero(),
    paymentStatus: 'unpaid',
    obligationId: null,
    approvalRequestId: null,
    expectedAt: null,
    deliveryMode: 'warehouse',
    warehouseId: null,
    directDeliveryCaseId: null,
    sentToSupplierAt: null,
    sentVia: null,
    conversationId: null,
    zohoPurchaseOrderId: null,
    evidenceObjectIds: [],
    notes: null,
    version: 1,
  }),
  procurementOrderLine: () => ({
    requestLineId: null,
    zohoItemId: null,
    supplierProductId: null,
    taxRate: null,
    qtyReceived: zero(),
    qtyAccepted: zero(),
    qtyRejected: zero(),
    status: 'open',
    sortOrder: 0,
  }),
  procurementAllocation: () => ({ requestLineId: null, demandAllocationId: null }),
  goodsReceipt: () => ({
    receivedAt: new Date(),
    mode: 'warehouse',
    warehouseId: null,
    locationId: null,
    directConfirmedByUserId: null,
    evidenceObjectIds: [],
    status: 'draft',
    notes: null,
    version: 1,
  }),
  goodsReceiptLine: () => ({ qtyRejected: zero(), lotCode: null, stockMovementId: null, differenceKind: 'none', incidentId: null }),
  sourcingSearch: () => ({
    filters: null,
    status: 'pending',
    resultCount: 0,
    rawResultObjectId: null,
    costUnits: 0,
    error: null,
    executedAt: null,
    expiresAt: null,
  }),
  sourcingCandidate: () => ({
    searchId: null,
    domain: null,
    url: null,
    phone: null,
    email: null,
    location: null,
    productsSummary: null,
    priceSnippets: [],
    confidence: null,
    evidence: [],
    status: 'new',
    supplierId: null,
    commContactId: null,
    lastFetchedAt: null,
    version: 1,
  }),
  obligation: () => ({
    counterpartyName: null,
    supplierId: null,
    zohoContactId: null,
    employeeId: null,
    caseId: null,
    procurementOrderId: null,
    payrollRunId: null,
    expenseId: null,
    zohoSalesOrderId: null,
    zohoInvoiceId: null,
    currency: 'MXN',
    settledAmount: zero(),
    dueAt: null,
    expectedCashAt: null,
    status: 'expected',
    costCenterId: null,
    ledgerEntryId: null,
    version: 1,
  }),
  deliveryEvidence: () => ({ storageObjectId: null, deliveredLines: null, note: null, lat: null, lng: null, commandId: null }),
  usageMeter: () => ({ count: 0, amount: zero() }),
  contact: () => ({ contactType: 'vendor', contactName: null, companyName: null, website: null, primaryPhone: null, mobile: null, primaryEmail: null }),
  storageObject: () => ({
    provider: 'disk',
    bucketAlias: 'files',
    versionId: 'v1',
    parentObjectId: null,
    detectedMimeType: null,
    sizeBytes: BigInt(1),
    sha256: null,
    status: 'ready',
    rejectionReason: null,
    retentionPolicy: 'default',
    metadata: null,
    legacyPath: null,
    expiresAt: null,
    deletedAt: null,
  }),
};

const PURCHASES_UNIQUES: Record<string, string[][]> = {
  supplier: [['number'], ['zohoContactId'], ['sourceCandidateId']],
  supplierProduct: [['supplierId', 'zohoItemId', 'supplierSku']],
  purchaseRequest: [['number']],
  rfq: [['number']],
  procurementOrder: [['number']],
  procurementAllocation: [['orderLineId', 'demandId']],
  goodsReceipt: [['number']],
  sourcingSearch: [['queryHash']],
  sourcingCandidate: [['dedupeKey']],
  obligation: [['number']],
  usageMeter: [['dimension', 'key', 'period', 'unit']],
  contact: [['zohoContactId']],
};

const PURCHASES_RELATIONS: Record<string, Record<string, Relation>> = {
  supplier: {
    products: { model: 'supplierProduct', childFk: 'supplierId' },
    evaluations: { model: 'supplierEvaluation', childFk: 'supplierId' },
  },
  supplierProduct: { supplier: { model: 'supplier', fk: 'supplierId' } },
  purchaseRequest: { lines: { model: 'purchaseRequestLine', childFk: 'requestId' } },
  purchaseRequestLine: { request: { model: 'purchaseRequest', fk: 'requestId' } },
  rfq: {
    lines: { model: 'rfqLine', childFk: 'rfqId' },
    invitations: { model: 'rfqInvitation', childFk: 'rfqId' },
    responses: { model: 'rfqResponse', childFk: 'rfqId' },
  },
  rfqResponse: { lines: { model: 'rfqResponseLine', childFk: 'responseId' } },
  procurementOrder: {
    lines: { model: 'procurementOrderLine', childFk: 'orderId' },
    receipts: { model: 'goodsReceipt', childFk: 'orderId' },
  },
  procurementOrderLine: {
    order: { model: 'procurementOrder', fk: 'orderId' },
    allocations: { model: 'procurementAllocation', childFk: 'orderLineId' },
  },
  procurementAllocation: { orderLine: { model: 'procurementOrderLine', fk: 'orderLineId' } },
  goodsReceipt: {
    lines: { model: 'goodsReceiptLine', childFk: 'receiptId' },
    order: { model: 'procurementOrder', fk: 'orderId' },
  },
  goodsReceiptLine: { receipt: { model: 'goodsReceipt', fk: 'receiptId' } },
};

interface FakeInternals {
  defaults: Record<string, () => Row>;
  relations: Record<string, Record<string, Relation>>;
  uniques: Record<string, UniqueRule[]>;
  compoundKeys: Record<string, string[]>;
}

/** Adds purchases models to a FakePrisma created by another fixture (defaults, uniques, relations). */
export function extendFakeWithPurchases(fake: FakePrisma): FakePrisma {
  const internals = fake as unknown as FakeInternals;
  Object.assign(internals.defaults, PURCHASES_DEFAULTS);
  for (const [model, relations] of Object.entries(PURCHASES_RELATIONS)) {
    internals.relations[model] = { ...(internals.relations[model] ?? {}), ...relations };
  }
  for (const [model, sets] of Object.entries(PURCHASES_UNIQUES)) {
    const rules = (internals.uniques[model] ??= []);
    for (const fields of sets) {
      rules.push({ fields, applies: (row) => fields.every((f) => row[f] !== null && row[f] !== undefined), same });
      if (fields.length > 1) internals.compoundKeys[fields.join('_')] = fields;
    }
  }
  return fake;
}

export function createPurchasesFake(): FakePrisma {
  return extendFakeWithPurchases(createCaseFake());
}

export const PURCHASES_TEST_PERMISSIONS = [
  'purchases.view',
  'purchases.manage_suppliers',
  'purchases.request',
  'purchases.manage_orders',
  'purchases.receive',
  'purchases.sourcing',
  'purchases.export',
] as const;

export interface PurchasesTeam {
  buyer: CurrentUser;
  approver: CurrentUser;
  secondApprover: CurrentUser;
  receiver: CurrentUser;
  outsider: CurrentUser;
}

/** Buyer (every purchases action), two approvers (`purchases.approve`), a receiver and a user without permissions. */
export function seedPurchasesTeam(fake: FakePrisma): PurchasesTeam {
  const buyer = seedUser(fake, { id: 'u_buyer', name: 'Compradora', permissions: [...PURCHASES_TEST_PERMISSIONS, 'inbox.use'] }).currentUser;
  const approver = seedUser(fake, { id: 'u_approver', name: 'Aprobador', permissions: ['purchases.view', 'purchases.approve'] }).currentUser;
  const secondApprover = seedUser(fake, { id: 'u_approver2', name: 'Director', permissions: ['purchases.view', 'purchases.approve'] }).currentUser;
  const receiver = seedUser(fake, { id: 'u_receiver', name: 'Almacenista', permissions: ['purchases.view', 'purchases.receive', 'inventory.view'] }).currentUser;
  const outsider = seedUser(fake, { id: 'u_outsider', name: 'Sin permisos' }).currentUser;
  return { buyer, approver, secondApprover, receiver, outsider };
}

export function seedSupplier(fake: FakePrisma, overrides: Row = {}): Row {
  const index = fake.rows('supplier').length + 1;
  return fake.seed('supplier', {
    id: `sup_${index}`,
    // Seeds never take folios of the sequence (PRV-000001…) used by the commands.
    number: `PRV-T${String(index).padStart(5, '0')}`,
    name: `Proveedor ${index}`,
    createdByUserId: 'u_buyer',
    ...overrides,
  });
}

export function seedCommAccount(fake: FakePrisma, overrides: Row = {}): Row {
  return fake.seed('commAccount', {
    id: 'acc_wa',
    provider: 'twilio_whatsapp',
    label: 'WhatsApp Compras',
    identifier: '+528100000000',
    connectionId: null,
    teamKeys: [],
    status: 'active',
    webhookSecret: null,
    config: null,
    ...overrides,
  });
}

export function seedStorageObject(fake: FakePrisma, overrides: Row = {}): Row {
  const id = (overrides.id as string | undefined) ?? `obj_${fake.rows('storageObject').length + 1}`;
  return fake.seed('storageObject', {
    id,
    objectKey: `evidence/${id}/v1`,
    originalName: 'evidencia.jpg',
    declaredMimeType: 'image/jpeg',
    purpose: 'evidence',
    createdBy: 'u_buyer',
    ...overrides,
  });
}

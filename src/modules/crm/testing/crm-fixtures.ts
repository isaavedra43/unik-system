import { Prisma } from '@prisma/client';
import type { FakePrisma, Row } from '@/modules/comms/testing/fake-prisma';
import { addRawHandler, createOpsFake, RAW_NOT_HANDLED } from '@/modules/operations/testing/fixtures';

/**
 * FakePrisma for the CRM unit tests: the operations core schema plus the CRM,
 * quote, sales order and integration snapshot models (defaults, relations and
 * unique keys as in prisma/schema.prisma), and the SAVEPOINT statements the
 * sales order normalizer runs around the operations hooks.
 *
 * Only pure modules are imported, so it is safe inside `vi.hoisted`.
 */

const dec = (value: number | null | undefined) =>
  value === null || value === undefined ? null : new Prisma.Decimal(value);

export function createCrmFake(): FakePrisma {
  const fake = createOpsFake({
    defaults: {
      pipelineStage: () => ({ probabilityDefault: new Prisma.Decimal(0), kind: 'open', slaHours: null, active: true }),
      opportunity: () => ({
        commContactId: null,
        zohoContactId: null,
        stageEnteredAt: new Date(),
        estimatedValue: null,
        currency: 'MXN',
        probability: null,
        expectedCloseAt: null,
        nextActionAt: null,
        nextActionText: null,
        source: 'manual',
        conversationIds: [],
        voiceCallIds: [],
        zohoEstimateIds: [],
        zohoSalesOrderIds: [],
        caseIds: [],
        status: 'open',
        lostReason: null,
        wonAt: null,
        lostAt: null,
        lastActivityAt: new Date(),
        lastInboundAt: null,
        lastOutboundAt: null,
        tags: [],
        version: 1,
      }),
      opportunityActivity: () => ({ refType: null, refId: null, payload: null, userId: null, at: new Date() }),
      salesOrderWriteRequest: () => ({
        opportunityId: null,
        quoteId: null,
        zohoEstimateId: null,
        salesOrderId: null,
        zohoSalesOrderId: null,
        status: 'pending',
        errorMessage: null,
        completedAt: null,
      }),
      radarSignal: () => ({
        opportunityId: null,
        conversationId: null,
        quoteId: null,
        zohoContactId: null,
        commContactId: null,
        customerName: null,
        salespersonUserId: null,
        data: null,
        computedAt: new Date(),
        status: 'active',
        snoozedUntil: null,
        aiExplanation: null,
        aiSuggestedMessage: null,
        aiGeneratedAt: null,
        version: 1,
      }),
      integrationSnapshot: () => ({ normalizedAt: null, normalizationVersion: 0, normalizationErrorCode: null }),
      integrationEntityState: () => ({ lastSyncedRemoteModifiedAt: null, needsSync: true, lastDetailFetchedAt: null }),
      entityChangeEvent: () => ({ sourceRemoteModifiedAt: null }),
      voiceCall: () => ({
        provider: 'livekit',
        status: 'ended',
        contactId: null,
        initiatedByUserId: null,
        summary: null,
        durationSec: null,
      }),
    },
    relations: {
      opportunity: { activities: { model: 'opportunityActivity', childFk: 'opportunityId' } },
      opportunityActivity: { opportunity: { model: 'opportunity', fk: 'opportunityId' } },
      quote: { items: { model: 'quoteItem', childFk: 'quoteId' } },
      quoteItem: { quote: { model: 'quote', fk: 'quoteId' } },
      salesOrder: { items: { model: 'salesOrderItem', childFk: 'salesOrderId' } },
    },
    uniques: {
      pipelineStage: [['key']],
      opportunity: [['number']],
      salesOrderWriteRequest: [['requestKey']],
      radarSignal: [['kind', 'subjectKey']],
      quote: [['zohoEstimateId']],
      salesOrder: [['zohoSalesOrderId']],
      contact: [['zohoContactId']],
      integrationSnapshot: [['source', 'entityType', 'externalId', 'remoteModifiedAt']],
      integrationEntityState: [['source', 'entityType', 'externalId']],
    },
  });
  // The sales order normalizer wraps the operations hooks in a SAVEPOINT (no-op in memory).
  addRawHandler(fake, (query) =>
    /^\s*(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/i.test(query.sql) ? 0 : RAW_NOT_HANDLED
  );
  return fake;
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

export function seedInboxConversation(
  fake: FakePrisma,
  input: {
    id: string;
    teamKey?: string;
    assignedToUserId?: string | null;
    displayName?: string;
    zohoContactId?: string | null;
    lastInboundAt?: Date | null;
    status?: string;
    tags?: string[];
  }
): { account: Row; contact: Row; conversation: Row } {
  const account = fake.seed('commAccount', {
    id: `acc-${input.id}`,
    provider: 'twilio_whatsapp',
    label: 'WhatsApp Ventas',
    identifier: `+52155${input.id}`,
    teamKeys: [input.teamKey ?? 'team_ventas'],
  });
  const contact = fake.seed('commContact', {
    id: `ct-${input.id}`,
    displayName: input.displayName ?? 'Constructora Norte',
    phone: '+5215512345678',
    zohoContactId: input.zohoContactId ?? null,
  });
  const conversation = fake.seed('commConversation', {
    id: input.id,
    accountId: account.id,
    contactId: contact.id,
    assignedToUserId: input.assignedToUserId ?? null,
    lastInboundAt: input.lastInboundAt ?? null,
    status: input.status ?? 'open',
    tags: input.tags ?? [],
    lastMessageAt: new Date(),
  });
  return { account, contact, conversation };
}

export function seedMessage(
  fake: FakePrisma,
  conversation: Row,
  input: {
    id?: string;
    direction: 'inbound' | 'outbound';
    body?: string | null;
    createdAt: Date;
    status?: string;
    sentByUserId?: string | null;
  }
): Row {
  return fake.seed('commMessage', {
    id: input.id ?? nextId('msg'),
    accountId: conversation.accountId,
    conversationId: conversation.id,
    direction: input.direction,
    body: input.body ?? null,
    status: input.status ?? (input.direction === 'inbound' ? 'received' : 'sent'),
    sentByUserId: input.sentByUserId ?? null,
    createdAt: input.createdAt,
  });
}

export interface SeedQuoteInput {
  id: string;
  zohoEstimateId: string;
  estimateNumber: string;
  status?: string;
  zohoCustomerId?: string | null;
  customerName?: string | null;
  total?: number | null;
  subTotal?: number | null;
  taxTotal?: number | null;
  expiryDate?: Date | null;
  isViewedByClient?: boolean | null;
  createdByUserId?: string | null;
  items?: Row[];
}

/** An accepted quote of Constructora Norte for 15 m² × $320 + IVA by default. */
export function seedQuote(fake: FakePrisma, input: SeedQuoteInput): Row {
  const quote = fake.seed('quote', {
    id: input.id,
    zohoEstimateId: input.zohoEstimateId,
    estimateNumber: input.estimateNumber,
    referenceNumber: null,
    status: input.status ?? 'accepted',
    date: new Date('2026-09-10T00:00:00.000Z'),
    expiryDate: input.expiryDate ?? null,
    zohoCustomerId: input.zohoCustomerId === undefined ? 'zc-1' : input.zohoCustomerId,
    customerName: input.customerName === undefined ? 'Constructora Norte' : input.customerName,
    currencyId: null,
    currencyCode: 'MXN',
    exchangeRate: null,
    subTotal: dec(input.subTotal === undefined ? 4800 : input.subTotal),
    taxTotal: dec(input.taxTotal === undefined ? 768 : input.taxTotal),
    discountTotal: dec(0),
    discount: null,
    discountType: 'entity_level',
    isDiscountBeforeTax: true,
    isInclusiveTax: false,
    shippingCharge: dec(0),
    adjustment: null,
    adjustmentDescription: null,
    total: dec(input.total === undefined ? 5568 : input.total),
    salespersonId: '4600000777',
    salespersonName: 'Ana López',
    templateId: null,
    templateName: null,
    notes: null,
    terms: null,
    customFields: null,
    isViewedByClient: input.isViewedByClient ?? false,
    acceptedDate: null,
    declinedDate: null,
    zohoCreatedTime: null,
    zohoLastModifiedTime: null,
    createdInUnik: true,
    createdByUserId: input.createdByUserId ?? null,
    lastEditedByUserId: null,
    lastEditedInUnikAt: null,
    sourceRemoteModifiedAt: new Date(),
    sourceSnapshotId: `snap-${input.id}`,
    normalizedAt: new Date(),
  });
  const items = input.items ?? [{}];
  items.forEach((item, index) =>
    fake.seed('quoteItem', {
      id: `${input.id}-item-${index}`,
      quoteId: quote.id,
      zohoLineItemId: null,
      zohoItemId: '4600000400',
      sku: 'POR-6060',
      name: 'Porcelanato 60x60',
      description: null,
      quantity: dec(15),
      rate: dec(320),
      unit: 'm2',
      discount: null,
      discountAmount: null,
      taxId: 'tax-iva',
      taxName: 'IVA',
      taxPercentage: dec(16),
      taxAmount: dec(768),
      lineTotal: dec(4800),
      sortOrder: index,
      ...item,
    })
  );
  return quote;
}

/** An open opportunity in the given stage (seed the pipeline first). */
export function seedOpportunity(fake: FakePrisma, input: Row & { id: string; stageId: string }): Row {
  return fake.seed('opportunity', {
    number: `OPP-9${String(++sequence).padStart(5, '0')}`,
    title: 'Oportunidad de prueba',
    contactName: 'Constructora Norte',
    salespersonUserId: 'u-seller',
    ...input,
  });
}

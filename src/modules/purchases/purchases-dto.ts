import type {
  GoodsReceipt,
  GoodsReceiptLine,
  ProcurementAllocation,
  ProcurementOrder,
  ProcurementOrderLine,
  PurchaseRequest,
  PurchaseRequestLine,
  Rfq,
  RfqInvitation,
  RfqLine,
  RfqResponse,
  RfqResponseLine,
  SourcingCandidate,
  SourcingSearch,
  Supplier,
  SupplierEvaluation,
  SupplierProduct,
} from '@prisma/client';
import { orderStatusLabel } from './orders-state';
import { asRecord, decText, decTextOrNull, iso, parseChannels, type SupplierChannel } from './purchases-helpers';
import {
  CANDIDATE_STATUS_LABELS,
  DIFFERENCE_KIND_LABELS,
  ORDER_DELIVERY_MODE_LABELS,
  PAYMENT_MODE_LABELS,
  PAYMENT_STATUS_LABELS,
  PURCHASE_REQUEST_LINE_STATUS_LABELS,
  PURCHASE_REQUEST_STATUS_LABELS,
  RECEIPT_STATUS_LABELS,
  RFQ_INVITATION_STATUS_LABELS,
  RFQ_RESPONSE_STATUS_LABELS,
  RFQ_STATUS_LABELS,
  SOURCING_PROVIDER_LABELS,
  SUPPLIER_STATUS_LABELS,
  labelOf,
} from './purchases-types';
import type { EvidenceEntry, PriceSnippet } from './sourcing-dedupe';

/**
 * JSON-safe DTOs of Compras for the UI (next phase), the AI tools and the
 * command results: decimals as strings, dates as ISO strings, Spanish labels
 * next to every state.
 */

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export interface SupplierDTO {
  id: string;
  number: string;
  name: string;
  legalName: string | null;
  taxRegNo: string | null;
  zohoContactId: string | null;
  status: string;
  statusLabel: string;
  channels: SupplierChannel[];
  primaryPhone: string | null;
  primaryEmail: string | null;
  website: string | null;
  commContactId: string | null;
  paymentMode: string;
  paymentModeLabel: string;
  paymentTermsDays: number | null;
  currency: string;
  leadTimeDaysDefault: number | null;
  freightTerms: string | null;
  rating: {
    overall: string | null;
    onTime: string | null;
    quality: string | null;
    price: string | null;
  };
  evaluationsCount: number;
  lastEvaluatedAt: string | null;
  sourceCandidateId: string | null;
  tags: string[];
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function toSupplierDTO(row: Supplier): SupplierDTO {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    legalName: row.legalName,
    taxRegNo: row.taxRegNo,
    zohoContactId: row.zohoContactId,
    status: row.status,
    statusLabel: labelOf(SUPPLIER_STATUS_LABELS, row.status),
    channels: parseChannels(row.channels),
    primaryPhone: row.primaryPhone,
    primaryEmail: row.primaryEmail,
    website: row.website,
    commContactId: row.commContactId,
    paymentMode: row.paymentMode,
    paymentModeLabel: labelOf(PAYMENT_MODE_LABELS, row.paymentMode),
    paymentTermsDays: row.paymentTermsDays,
    currency: row.currency,
    leadTimeDaysDefault: row.leadTimeDaysDefault,
    freightTerms: row.freightTerms,
    rating: {
      overall: decTextOrNull(row.ratingOverall),
      onTime: decTextOrNull(row.ratingOnTime),
      quality: decTextOrNull(row.ratingQuality),
      price: decTextOrNull(row.ratingPrice),
    },
    evaluationsCount: row.evaluationsCount,
    lastEvaluatedAt: iso(row.lastEvaluatedAt),
    sourceCandidateId: row.sourceCandidateId,
    tags: row.tags,
    notes: row.notes,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface SupplierProductDTO {
  id: string;
  supplierId: string;
  zohoItemId: string | null;
  supplierSku: string | null;
  description: string;
  unit: string;
  unitFactorToBase: string;
  lastPrice: string | null;
  currency: string;
  lastQuotedAt: string | null;
  leadTimeDays: number | null;
  minOrderQty: string | null;
  source: string;
  updatedAt: string;
}

export function toSupplierProductDTO(row: SupplierProduct): SupplierProductDTO {
  return {
    id: row.id,
    supplierId: row.supplierId,
    zohoItemId: row.zohoItemId || null,
    supplierSku: row.supplierSku || null,
    description: row.description,
    unit: row.unit,
    unitFactorToBase: decText(row.unitFactorToBase),
    lastPrice: decTextOrNull(row.lastPrice),
    currency: row.currency,
    lastQuotedAt: iso(row.lastQuotedAt),
    leadTimeDays: row.leadTimeDays,
    minOrderQty: decTextOrNull(row.minOrderQty),
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface SupplierEvaluationDTO {
  id: string;
  supplierId: string;
  orderId: string | null;
  receiptId: string | null;
  onTime: number;
  quality: number;
  price: number;
  communication: number;
  comment: string | null;
  evaluatedByUserId: string;
  createdAt: string;
}

export function toSupplierEvaluationDTO(row: SupplierEvaluation): SupplierEvaluationDTO {
  return {
    id: row.id,
    supplierId: row.supplierId,
    orderId: row.orderId,
    receiptId: row.receiptId,
    onTime: row.onTime,
    quality: row.quality,
    price: row.price,
    communication: row.communication,
    comment: row.comment,
    evaluatedByUserId: row.evaluatedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------------

export interface PurchaseRequestLineDTO {
  id: string;
  requestId: string;
  demandId: string | null;
  allocationId: string | null;
  zohoItemId: string | null;
  consolidationKey: string | null;
  description: string;
  qty: string;
  unit: string;
  qtyOrdered: string;
  qtyReceived: string;
  status: string;
  statusLabel: string;
  sortOrder: number;
}

export function toRequestLineDTO(row: PurchaseRequestLine): PurchaseRequestLineDTO {
  return {
    id: row.id,
    requestId: row.requestId,
    demandId: row.demandId,
    allocationId: row.allocationId,
    zohoItemId: row.zohoItemId,
    consolidationKey: row.consolidationKey,
    description: row.description,
    qty: decText(row.qty),
    unit: row.unit,
    qtyOrdered: decText(row.qtyOrdered),
    qtyReceived: decText(row.qtyReceived),
    status: row.status,
    statusLabel: labelOf(PURCHASE_REQUEST_LINE_STATUS_LABELS, row.status),
    sortOrder: row.sortOrder,
  };
}

export interface PurchaseRequestDTO {
  id: string;
  number: string;
  caseId: string | null;
  caseNumber: string | null;
  requestedByUserId: string;
  requestedByName: string | null;
  areaKey: string;
  status: string;
  statusLabel: string;
  priority: string;
  neededBy: string | null;
  reason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines: PurchaseRequestLineDTO[];
}

export function toPurchaseRequestDTO(
  row: PurchaseRequest,
  lines: readonly PurchaseRequestLine[],
  extras: { caseNumber?: string | null; requestedByName?: string | null } = {}
): PurchaseRequestDTO {
  return {
    id: row.id,
    number: row.number,
    caseId: row.caseId,
    caseNumber: extras.caseNumber ?? null,
    requestedByUserId: row.requestedByUserId,
    requestedByName: extras.requestedByName ?? null,
    areaKey: row.areaKey,
    status: row.status,
    statusLabel: labelOf(PURCHASE_REQUEST_STATUS_LABELS, row.status),
    priority: row.priority,
    neededBy: iso(row.neededBy),
    reason: row.reason,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: [...lines].sort((a, b) => a.sortOrder - b.sortOrder).map(toRequestLineDTO),
  };
}

// ---------------------------------------------------------------------------
// RFQ
// ---------------------------------------------------------------------------

export interface RfqLineDTO {
  id: string;
  ref: string;
  requestLineId: string | null;
  zohoItemId: string | null;
  description: string;
  qty: string;
  unit: string;
  specs: Record<string, unknown> | null;
  sortOrder: number;
}

export function toRfqLineDTO(row: RfqLine, index: number): RfqLineDTO {
  return {
    id: row.id,
    ref: `L${index + 1}`,
    requestLineId: row.requestLineId,
    zohoItemId: row.zohoItemId,
    description: row.description,
    qty: decText(row.qty),
    unit: row.unit,
    specs: row.specs ? asRecord(row.specs) : null,
    sortOrder: row.sortOrder,
  };
}

export interface RfqInvitationDTO {
  id: string;
  rfqId: string;
  supplierId: string | null;
  candidateId: string | null;
  name: string | null;
  channel: string;
  accountId: string | null;
  conversationId: string | null;
  messageId: string | null;
  status: string;
  statusLabel: string;
  sentAt: string | null;
  repliedAt: string | null;
  error: string | null;
}

export function toRfqInvitationDTO(row: RfqInvitation, name: string | null = null): RfqInvitationDTO {
  return {
    id: row.id,
    rfqId: row.rfqId,
    supplierId: row.supplierId,
    candidateId: row.candidateId,
    name,
    channel: row.channel,
    accountId: row.accountId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    status: row.status,
    statusLabel: labelOf(RFQ_INVITATION_STATUS_LABELS, row.status),
    sentAt: iso(row.sentAt),
    repliedAt: iso(row.repliedAt),
    error: row.error,
  };
}

export interface RfqResponseLineDTO {
  id: string;
  rfqLineId: string;
  unitPrice: string;
  qty: string;
  unit: string;
  unitFactorToBase: string;
  landedUnitCost: string | null;
}

export interface RfqResponseDTO {
  id: string;
  rfqId: string;
  invitationId: string | null;
  supplierId: string | null;
  candidateId: string | null;
  name: string | null;
  receivedVia: string;
  sourceMessageIds: string[];
  currency: string;
  exchangeRate: string | null;
  taxIncluded: boolean;
  taxRate: string | null;
  freight: string;
  otherCosts: string;
  leadTimeDays: number | null;
  validUntil: string | null;
  paymentTerms: string | null;
  landedTotal: string | null;
  score: string | null;
  specMatch: string | null;
  riskScore: string | null;
  confidence: string | null;
  interpretation: Record<string, unknown> | null;
  reviewReasons: string[];
  status: string;
  statusLabel: string;
  reviewedByUserId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines: RfqResponseLineDTO[];
}

export function toRfqResponseDTO(
  row: RfqResponse,
  lines: readonly RfqResponseLine[],
  name: string | null = null
): RfqResponseDTO {
  const interpretation = row.interpretation ? asRecord(row.interpretation) : null;
  const reasons = interpretation && Array.isArray(interpretation.reviewReasons) ? interpretation.reviewReasons : [];
  return {
    id: row.id,
    rfqId: row.rfqId,
    invitationId: row.invitationId,
    supplierId: row.supplierId,
    candidateId: row.candidateId,
    name,
    receivedVia: row.receivedVia,
    sourceMessageIds: row.sourceMessageIds,
    currency: row.currency,
    exchangeRate: decTextOrNull(row.exchangeRate),
    taxIncluded: row.taxIncluded,
    taxRate: decTextOrNull(row.taxRate),
    freight: decText(row.freight),
    otherCosts: decText(row.otherCosts),
    leadTimeDays: row.leadTimeDays,
    validUntil: iso(row.validUntil),
    paymentTerms: row.paymentTerms,
    landedTotal: decTextOrNull(row.landedTotal),
    score: decTextOrNull(row.score),
    specMatch: decTextOrNull(row.specMatch),
    riskScore: decTextOrNull(row.riskScore),
    confidence: decTextOrNull(row.confidence),
    interpretation,
    reviewReasons: reasons.filter((reason): reason is string => typeof reason === 'string'),
    status: row.status,
    statusLabel: labelOf(RFQ_RESPONSE_STATUS_LABELS, row.status),
    reviewedByUserId: row.reviewedByUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: lines.map((line) => ({
      id: line.id,
      rfqLineId: line.rfqLineId,
      unitPrice: decText(line.unitPrice),
      qty: decText(line.qty),
      unit: line.unit,
      unitFactorToBase: decText(line.unitFactorToBase),
      landedUnitCost: decTextOrNull(line.landedUnitCost),
    })),
  };
}

export interface RfqDTO {
  id: string;
  number: string;
  title: string;
  status: string;
  statusLabel: string;
  dueAt: string | null;
  sourcingSearchId: string | null;
  createdByUserId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines: RfqLineDTO[];
  invitations: RfqInvitationDTO[];
  responses: RfqResponseDTO[];
}

export function toRfqDTO(
  row: Rfq,
  parts: {
    lines: readonly RfqLine[];
    invitations?: readonly RfqInvitationDTO[];
    responses?: readonly RfqResponseDTO[];
  }
): RfqDTO {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    statusLabel: labelOf(RFQ_STATUS_LABELS, row.status),
    dueAt: iso(row.dueAt),
    sourcingSearchId: row.sourcingSearchId,
    createdByUserId: row.createdByUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: [...parts.lines].sort((a, b) => a.sortOrder - b.sortOrder).map(toRfqLineDTO),
    invitations: [...(parts.invitations ?? [])],
    responses: [...(parts.responses ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Procurement orders
// ---------------------------------------------------------------------------

export interface ProcurementAllocationDTO {
  id: string;
  orderLineId: string;
  demandId: string;
  requestLineId: string | null;
  demandAllocationId: string | null;
  qty: string;
  caseId: string | null;
  caseNumber: string | null;
  demandName: string | null;
  allocationStatus: string | null;
}

export function toAllocationDTO(
  row: ProcurementAllocation,
  extras: { caseId?: string | null; caseNumber?: string | null; demandName?: string | null; allocationStatus?: string | null } = {}
): ProcurementAllocationDTO {
  return {
    id: row.id,
    orderLineId: row.orderLineId,
    demandId: row.demandId,
    requestLineId: row.requestLineId,
    demandAllocationId: row.demandAllocationId,
    qty: decText(row.qty),
    caseId: extras.caseId ?? null,
    caseNumber: extras.caseNumber ?? null,
    demandName: extras.demandName ?? null,
    allocationStatus: extras.allocationStatus ?? null,
  };
}

export interface ProcurementOrderLineDTO {
  id: string;
  orderId: string;
  requestLineId: string | null;
  zohoItemId: string | null;
  supplierProductId: string | null;
  description: string;
  qty: string;
  unit: string;
  unitPrice: string;
  taxRate: string | null;
  lineTotal: string;
  qtyReceived: string;
  qtyAccepted: string;
  qtyRejected: string;
  /** Still expected from the supplier (never available stock). */
  qtyPending: string;
  status: string;
  sortOrder: number;
  allocations: ProcurementAllocationDTO[];
}

export function toOrderLineDTO(
  row: ProcurementOrderLine,
  allocations: readonly ProcurementAllocationDTO[] = []
): ProcurementOrderLineDTO {
  const pending = row.status === 'cancelled' || row.status === 'closed' ? 0 : Math.max(0, Number(row.qty) - Number(row.qtyAccepted));
  return {
    id: row.id,
    orderId: row.orderId,
    requestLineId: row.requestLineId,
    zohoItemId: row.zohoItemId,
    supplierProductId: row.supplierProductId,
    description: row.description,
    qty: decText(row.qty),
    unit: row.unit,
    unitPrice: decText(row.unitPrice),
    taxRate: decTextOrNull(row.taxRate),
    lineTotal: decText(row.lineTotal),
    qtyReceived: decText(row.qtyReceived),
    qtyAccepted: decText(row.qtyAccepted),
    qtyRejected: decText(row.qtyRejected),
    qtyPending: decText(pending),
    status: row.status,
    sortOrder: row.sortOrder,
    allocations: [...allocations],
  };
}

export interface ProcurementOrderDTO {
  id: string;
  number: string;
  supplierId: string;
  supplierName: string | null;
  rfqResponseId: string | null;
  status: string;
  statusLabel: string;
  currency: string;
  subtotal: string;
  taxTotal: string;
  freight: string;
  total: string;
  paymentMode: string;
  paymentModeLabel: string;
  paymentStatus: string;
  paymentStatusLabel: string;
  obligationId: string | null;
  approvalRequestId: string | null;
  expectedAt: string | null;
  deliveryMode: string;
  deliveryModeLabel: string;
  warehouseId: string | null;
  directDeliveryCaseId: string | null;
  sentToSupplierAt: string | null;
  sentVia: string | null;
  conversationId: string | null;
  zohoPurchaseOrderId: string | null;
  evidenceObjectIds: string[];
  notes: string | null;
  createdByUserId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines: ProcurementOrderLineDTO[];
}

export function toOrderDTO(
  row: ProcurementOrder,
  lines: readonly ProcurementOrderLineDTO[] = [],
  extras: { supplierName?: string | null } = {}
): ProcurementOrderDTO {
  return {
    id: row.id,
    number: row.number,
    supplierId: row.supplierId,
    supplierName: extras.supplierName ?? null,
    rfqResponseId: row.rfqResponseId,
    status: row.status,
    statusLabel: orderStatusLabel(row.status),
    currency: row.currency,
    subtotal: decText(row.subtotal),
    taxTotal: decText(row.taxTotal),
    freight: decText(row.freight),
    total: decText(row.total),
    paymentMode: row.paymentMode,
    paymentModeLabel: labelOf(PAYMENT_MODE_LABELS, row.paymentMode),
    paymentStatus: row.paymentStatus,
    paymentStatusLabel: labelOf(PAYMENT_STATUS_LABELS, row.paymentStatus),
    obligationId: row.obligationId,
    approvalRequestId: row.approvalRequestId,
    expectedAt: iso(row.expectedAt),
    deliveryMode: row.deliveryMode,
    deliveryModeLabel: labelOf(ORDER_DELIVERY_MODE_LABELS, row.deliveryMode),
    warehouseId: row.warehouseId,
    directDeliveryCaseId: row.directDeliveryCaseId,
    sentToSupplierAt: iso(row.sentToSupplierAt),
    sentVia: row.sentVia,
    conversationId: row.conversationId,
    zohoPurchaseOrderId: row.zohoPurchaseOrderId,
    evidenceObjectIds: row.evidenceObjectIds,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: [...lines].sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface GoodsReceiptLineDTO {
  id: string;
  orderLineId: string;
  qtyReceived: string;
  qtyAccepted: string;
  qtyRejected: string;
  unit: string;
  lotCode: string | null;
  stockMovementId: string | null;
  differenceKind: string;
  differenceLabel: string;
  incidentId: string | null;
}

export interface GoodsReceiptDTO {
  id: string;
  number: string;
  orderId: string;
  receivedByUserId: string;
  receivedAt: string;
  mode: string;
  warehouseId: string | null;
  locationId: string | null;
  directConfirmedByUserId: string | null;
  evidenceObjectIds: string[];
  status: string;
  statusLabel: string;
  notes: string | null;
  version: number;
  lines: GoodsReceiptLineDTO[];
}

export function toReceiptDTO(row: GoodsReceipt, lines: readonly GoodsReceiptLine[]): GoodsReceiptDTO {
  return {
    id: row.id,
    number: row.number,
    orderId: row.orderId,
    receivedByUserId: row.receivedByUserId,
    receivedAt: row.receivedAt.toISOString(),
    mode: row.mode,
    warehouseId: row.warehouseId,
    locationId: row.locationId,
    directConfirmedByUserId: row.directConfirmedByUserId,
    evidenceObjectIds: row.evidenceObjectIds,
    status: row.status,
    statusLabel: labelOf(RECEIPT_STATUS_LABELS, row.status),
    notes: row.notes,
    version: row.version,
    lines: lines.map((line) => ({
      id: line.id,
      orderLineId: line.orderLineId,
      qtyReceived: decText(line.qtyReceived),
      qtyAccepted: decText(line.qtyAccepted),
      qtyRejected: decText(line.qtyRejected),
      unit: line.unit,
      lotCode: line.lotCode,
      stockMovementId: line.stockMovementId,
      differenceKind: line.differenceKind,
      differenceLabel: labelOf(DIFFERENCE_KIND_LABELS, line.differenceKind),
      incidentId: line.incidentId,
    })),
  };
}

// ---------------------------------------------------------------------------
// Sourcing Lab
// ---------------------------------------------------------------------------

export interface SourcingSearchDTO {
  id: string;
  queryText: string;
  providerKey: string;
  providerLabel: string;
  filters: Record<string, unknown> | null;
  status: string;
  resultCount: number;
  rawResultObjectId: string | null;
  costUnits: number;
  error: string | null;
  createdByUserId: string;
  executedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export function toSearchDTO(row: SourcingSearch): SourcingSearchDTO {
  return {
    id: row.id,
    queryText: row.queryText,
    providerKey: row.providerKey,
    providerLabel: labelOf(SOURCING_PROVIDER_LABELS, row.providerKey),
    filters: row.filters ? asRecord(row.filters) : null,
    status: row.status,
    resultCount: row.resultCount,
    rawResultObjectId: row.rawResultObjectId,
    costUnits: row.costUnits,
    error: row.error,
    createdByUserId: row.createdByUserId,
    executedAt: iso(row.executedAt),
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function parseSnippets(value: unknown): PriceSnippet[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    if (typeof row.text !== 'string') return [];
    return [
      {
        text: row.text,
        price: typeof row.price === 'number' ? row.price : null,
        currency: typeof row.currency === 'string' ? row.currency : null,
        unit: typeof row.unit === 'string' ? row.unit : null,
        url: typeof row.url === 'string' ? row.url : null,
      },
    ];
  });
}

export function parseEvidence(value: unknown): EvidenceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    if (typeof row.url !== 'string') return [];
    return [
      {
        url: row.url,
        fetchedAt: typeof row.fetchedAt === 'string' ? row.fetchedAt : '',
        objectId: typeof row.objectId === 'string' ? row.objectId : null,
        sha256: typeof row.sha256 === 'string' ? row.sha256 : null,
      },
    ];
  });
}

export function parsePriceSnippets(value: unknown): PriceSnippet[] {
  return parseSnippets(value);
}

export interface SourcingCandidateDTO {
  id: string;
  searchId: string | null;
  dedupeKey: string;
  name: string;
  domain: string | null;
  url: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  productsSummary: string | null;
  priceSnippets: PriceSnippet[];
  confidence: string | null;
  evidence: EvidenceEntry[];
  status: string;
  statusLabel: string;
  supplierId: string | null;
  commContactId: string | null;
  /** True when it already is a Supplier of UNIK (found by domain, phone or name). */
  isKnownSupplier: boolean;
  lastFetchedAt: string | null;
  version: number;
  updatedAt: string;
}

export function toCandidateDTO(row: SourcingCandidate): SourcingCandidateDTO {
  return {
    id: row.id,
    searchId: row.searchId,
    dedupeKey: row.dedupeKey,
    name: row.name,
    domain: row.domain,
    url: row.url,
    phone: row.phone,
    email: row.email,
    location: row.location,
    productsSummary: row.productsSummary,
    priceSnippets: parseSnippets(row.priceSnippets),
    confidence: decTextOrNull(row.confidence),
    evidence: parseEvidence(row.evidence),
    status: row.status,
    statusLabel: labelOf(CANDIDATE_STATUS_LABELS, row.status),
    supplierId: row.supplierId,
    commContactId: row.commContactId,
    isKnownSupplier: Boolean(row.supplierId),
    lastFetchedAt: iso(row.lastFetchedAt),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

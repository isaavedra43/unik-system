import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Prisma } from '@prisma/client';
import { z, type ZodTypeAny } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import { sendOutboundMessage, startConversation, updateConversation } from '@/modules/comms/comms-service';
import { JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { onApprovalDecided, registerApprovalScopePermission } from '@/modules/operations/approvals-service';
import {
  executeCommand,
  registerCommand,
  versionedAggregate,
  type AggregateAdapter,
  type CommandAuditMode,
  type CommandContext,
  type CommandResult,
  type DomainCommand,
} from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import {
  onOperationalEventsInTransaction,
  type OperationalEventRecord,
  type OperationalOutboxJob,
} from '@/modules/operations/events-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import { OPS_EVENTS, type ActorType } from '@/modules/operations/types';
import { saveGeneratedFile } from '@/modules/storage/storage-service';
import { registerProcurementSettlementHandler, registerProcurementSettlementReversedHandler } from './finance-bridge';
import { checkSendOrder, orderStatusLabel } from './orders-state';
import {
  allocateLineInTx,
  allocateLineSchema,
  applyOrderApprovalDecision,
  cancelOrderInTx,
  cancelOrderSchema,
  closeOrderInTx,
  closeOrderSchema,
  createOrderInTx,
  createOrderSchema,
  followupFailedSchema,
  markOrderPaid,
  markOrderSentInTx,
  markSentSchema,
  recordFollowupFailureInTx,
  requestPaymentInTx,
  requestPaymentSchema,
  submitOrderInTx,
  submitOrderSchema,
  updateOrderDraftInTx,
  updateOrderSchema,
  type RequestPaymentData,
  type SubmitOrderData,
} from './orders-service';
import { toOrderDTO, toPurchaseRequestDTO, toRfqResponseDTO, toSupplierDTO, type ProcurementOrderDTO } from './purchases-dto';
import {
  MODULE_DISABLED_MESSAGE,
  assertActorHasAny,
  assertPurchasesEnabled,
  emitPurchases,
  isoDay,
  num,
  parseChannels,
  truncate,
  type Db,
} from './purchases-helpers';
import { idText, isoDateText, optionalText } from './purchases-schemas';
import {
  CHANNEL_PROVIDER,
  ORDER_CONVERSATION_TAG_PREFIX,
  ORDER_DELIVERY_MODE_LABELS,
  PAYMENT_MODE_LABELS,
  PURCHASES_COMMANDS as PC,
  PURCHASES_EVENTS,
  PURCHASES_JOB_TYPES,
  PURCHASES_OBJECT_TYPES as OBJ,
  SHORTFALL_REQUEST_KINDS,
  labelOf,
  type MessagingChannelType,
  type PurchasesCommandType,
} from './purchases-types';
import {
  confirmDirectDeliveryInTx,
  confirmDirectDeliverySchema,
  directDeliveryPlanSchema,
  directSyncFailedSchema,
  postReceiptInTx,
  postReceiptSchema,
  recordDirectSyncFailureInTx,
  recordReceiptInTx,
  recordReceiptSchema,
  resolveDifferenceSchema,
  resolveReceiptDifferenceInTx,
  syncDirectDeliveryInTx,
  type ConfirmDirectDeliveryData,
  type DirectDeliveryPlan,
  type PostReceiptResult,
} from './receipts-service';
import { groupRequestLines, remainingToOrder } from './request-rules';
import {
  cancelPurchaseRequestInTx,
  cancelPurchaseRequestSchema,
  createPurchaseRequestInTx,
  createPurchaseRequestSchema,
  loadOrderableRequestLines,
  markRequestsStage,
  suggestConsolidationInTx,
  syncShortfallRequestInTx,
  syncShortfallSchema,
  type ShortfallSyncResult,
} from './requests-service';
import {
  cancelRfqInTx,
  cancelRfqSchema,
  compareRfqInTx,
  confirmResponseInTx,
  confirmResponseSchema,
  createRfqInTx,
  createRfqSchema,
  expireRfqInTx,
  inviteSuppliersInTx,
  inviteSuppliersSchema,
  manualResponseSchema,
  recordInterpretationInTx,
  recordInterpretationSchema,
  recordManualResponseInTx,
  recordSendsInTx,
  recordSendsSchema,
  rejectResponseInTx,
  rejectResponseSchema,
  rfqIdSchema,
  reconcileSendsSchema,
  reconcileStaleInvitationsInTx,
  selectResponseInTx,
  selectResponseSchema,
  sendRfqInvitations,
  type InviteSuppliersData,
  type RecordInterpretationData,
  type RfqRankingEntry,
} from './rfq-service';
import { getSourcingConfig } from './sourcing-config';
import {
  candidateStatusSchema,
  recordSourcingResultsInTx,
  recordSourcingResultsSchema,
  requestSourcingSearchInTx,
  setCandidateStatusInTx,
  sourcingSearchSchema,
  type RecordSourcingResultsData,
  type SourcingSearchData,
} from './sourcing-service';
import { whatsappWindowOpen } from './messaging-eligibility';
import { orderTemplateVariables, renderOrderMessage } from './rfq-rules';
import {
  createSupplierInTx,
  createSupplierSchema,
  evaluateSupplierSchema,
  linkSupplierToZohoContactInTx,
  linkZohoContactSchema,
  promoteCandidateSchema,
  promoteCandidateToSupplierInTx,
  recordSupplierEvaluationInTx,
  updateSupplierInTx,
  updateSupplierSchema,
  upsertSupplierProductInTx,
  upsertSupplierProductSchema,
} from './suppliers-service';

/**
 * Operational commands of Compras y Sourcing (registered on import; the barrel
 * `operations/register-commands.ts` imports this file) and their service
 * wrappers `fn(actor, input, options?) → CommandResult` for server actions,
 * routes and AI tools.
 *
 * | command                                  | permission (any of)                        | aggregate            |
 * |------------------------------------------|--------------------------------------------|----------------------|
 * | purchases.supplier.create                | manage_suppliers                           | none                 |
 * | purchases.supplier.update / link_zoho    | manage_suppliers                           | supplier             |
 * | purchases.supplier.product_upsert        | manage_suppliers, manage_orders            | none                 |
 * | purchases.supplier.evaluate              | manage_suppliers, manage_orders, receive   | none                 |
 * | purchases.candidate.promote              | manage_suppliers                           | sourcing_candidate   |
 * | purchases.candidate.set_status           | sourcing, manage_orders                    | sourcing_candidate   |
 * | purchases.request.create / cancel        | request                                    | none / request       |
 * | purchases.request.consolidate            | manage_orders                              | none                 |
 * | purchases.rfq.create / invite / record_sends / compare | manage_orders, sourcing          | none / rfq           |
 * | purchases.rfq.manual_response / confirm / reject / select / cancel | manage_orders        | none / rfq_response / rfq |
 * | purchases.order.*                        | manage_orders                              | none / order         |
 * | purchases.receipt.record / post / confirm_direct | receive                            | order                |
 * | purchases.receipt.resolve_difference     | receive, manage_orders                     | order                |
 * | purchases.sourcing.search                | sourcing                                   | none                 |
 * | system: request.sync_shortfall, request.suggest_consolidation, rfq.record_interpretation, rfq.expire, order.request_payment (follow-up), order.followup_failed, receipt.sync_direct, receipt.direct_sync_failed, sourcing.record_results |
 *
 * Permissions are checked inside the handlers (system actors are trusted), so
 * loading this file never depends on the permission registry. Every handler
 * checks the `purchases` flag.
 *
 * Reactions registered here (they must exist wherever commands run):
 * - `onOperationalEventsInTransaction`: shortfall area requests to Compras (and
 *   cancelled purchase allocations) plan `purchases.shortfall_sync` in the same
 *   transaction;
 * - `onApprovalDecided('procurement_order')` → `applyOrderApprovalDecision`;
 * - finance `onObligationSettled('procurement_order')` → `markOrderPaid`;
 * - `registerApprovalScopePermission('procurement', 'purchases.approve')`.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'purchases-commands', event, ...extra }));

const P = {
  view: 'purchases.view',
  manageSuppliers: 'purchases.manage_suppliers',
  request: 'purchases.request',
  manageOrders: 'purchases.manage_orders',
  receive: 'purchases.receive',
  sourcing: 'purchases.sourcing',
} as const;

const HUMAN_OR_AI: readonly ActorType[] = ['user', 'ai'];
const HUMAN_ONLY: readonly ActorType[] = ['user'];
const SYSTEM_ONLY: readonly ActorType[] = ['system'];
const ANY_ACTOR: readonly ActorType[] = ['user', 'ai', 'system'];

const orderAggregate = versionedAggregate(OBJ.order, 'procurementOrder');
const requestAggregate = versionedAggregate(OBJ.request, 'purchaseRequest');
const rfqAggregate = versionedAggregate(OBJ.rfq, 'rfq');
const responseAggregate = versionedAggregate(OBJ.rfqResponse, 'rfqResponse');
const supplierAggregate = versionedAggregate(OBJ.supplier, 'supplier');
const candidateAggregate = versionedAggregate(OBJ.candidate, 'sourcingCandidate');

function invalid(message: string): never {
  throw new OperationsError('invalid_payload', message);
}

function parseOrThrow<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    invalid(
      `Datos inválidos: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
        .join('; ')}`
    );
  }
  return parsed.data;
}

interface PurchasesCommandDefinition<S extends ZodTypeAny, D> {
  schema: S;
  permissions?: readonly string[];
  aggregate: AggregateAdapter | 'none';
  actorTypes: readonly ActorType[];
  audit?: CommandAuditMode;
  /** Id the aggregate must have for this payload (never bump another record's version). */
  aggregateIdOf?: (payload: z.output<S>, tx: Db) => string | Promise<string | null> | null;
  handler(tx: Db, payload: z.output<S>, ctx: CommandContext, cmd: DomainCommand<z.output<S>>): Promise<{ data: D; aggregateVersion?: number }>;
}

function define<S extends ZodTypeAny, D>(type: PurchasesCommandType, def: PurchasesCommandDefinition<S, D>): void {
  registerCommand<z.output<S>, D>(type, {
    schema: def.schema,
    aggregate: def.aggregate,
    actorTypes: def.actorTypes,
    audit: def.audit,
    async handler(tx, cmd, ctx) {
      await assertPurchasesEnabled();
      if (def.permissions) assertActorHasAny(ctx, def.permissions);
      if (def.aggregateIdOf) {
        const expected = await def.aggregateIdOf(cmd.payload, tx);
        if (!expected) throw new OperationsError('not_found', 'No se encontró el registro sobre el que se quiere actuar');
        if (expected !== cmd.aggregate.id) invalid('El registro del comando no corresponde a los datos');
      }
      return def.handler(tx, cmd.payload, ctx, cmd);
    },
  });
}

// ---------------------------------------------------------------------------
// Suppliers and candidates
// ---------------------------------------------------------------------------

define(PC.supplierCreate, {
  schema: createSupplierSchema,
  permissions: [P.manageSuppliers],
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, payload, ctx) {
    const supplier = await createSupplierInTx(tx, payload, ctx);
    return { data: { supplier: toSupplierDTO(supplier) }, aggregateVersion: supplier.version };
  },
});

define(PC.supplierUpdate, {
  schema: updateSupplierSchema,
  permissions: [P.manageSuppliers],
  aggregate: supplierAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.supplierId,
  async handler(tx, payload, ctx) {
    return { data: { supplier: toSupplierDTO(await updateSupplierInTx(tx, payload, ctx)) } };
  },
});

define(PC.supplierLinkZoho, {
  schema: linkZohoContactSchema,
  permissions: [P.manageSuppliers],
  aggregate: supplierAggregate,
  actorTypes: HUMAN_ONLY,
  aggregateIdOf: (payload) => payload.supplierId,
  async handler(tx, payload, ctx) {
    return { data: { supplier: toSupplierDTO(await linkSupplierToZohoContactInTx(tx, payload, ctx)) } };
  },
});

define(PC.supplierProductUpsert, {
  schema: upsertSupplierProductSchema,
  permissions: [P.manageSuppliers, P.manageOrders],
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, payload, ctx) {
    const product = await upsertSupplierProductInTx(tx, payload, ctx);
    return { data: { supplierProductId: product.id, supplierId: product.supplierId } };
  },
});

define(PC.supplierEvaluate, {
  schema: evaluateSupplierSchema,
  permissions: [P.manageSuppliers, P.manageOrders, P.receive],
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, payload, ctx) {
    const { evaluation, supplier } = await recordSupplierEvaluationInTx(tx, payload, ctx);
    return { data: { evaluationId: evaluation.id, supplier: toSupplierDTO(supplier) } };
  },
});

define(PC.candidatePromote, {
  schema: promoteCandidateSchema,
  permissions: [P.manageSuppliers],
  aggregate: candidateAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.candidateId,
  async handler(tx, payload, ctx) {
    const { supplier, created } = await promoteCandidateToSupplierInTx(tx, payload, ctx);
    return { data: { supplier: toSupplierDTO(supplier), created } };
  },
});

define(PC.candidateStatus, {
  schema: candidateStatusSchema,
  permissions: [P.sourcing, P.manageOrders],
  aggregate: candidateAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.candidateId,
  async handler(tx, payload, ctx) {
    const candidate = await setCandidateStatusInTx(tx, payload, ctx);
    return { data: { candidateId: candidate.id, status: candidate.status } };
  },
});

// ---------------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------------

define(PC.requestCreate, {
  schema: createPurchaseRequestSchema,
  permissions: [P.request],
  aggregate: 'none',
  actorTypes: ANY_ACTOR,
  async handler(tx, payload, ctx) {
    const created = await createPurchaseRequestInTx(tx, payload, ctx);
    return {
      data: { request: toPurchaseRequestDTO(created.request, created.lines), areaRequestIds: created.areaRequestIds },
      aggregateVersion: created.request.version,
    };
  },
});

define(PC.requestCancel, {
  schema: cancelPurchaseRequestSchema,
  permissions: [P.request],
  aggregate: requestAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.requestId,
  async handler(tx, payload, ctx) {
    const request = await cancelPurchaseRequestInTx(tx, payload, ctx);
    return { data: { requestId: request.id, status: request.status } };
  },
});

export const consolidateRequestsSchema = z.object({
  lineIds: z.array(idText).min(2, 'Elige al menos dos partidas').max(200),
  into: z.enum(['rfq', 'order']),
  supplierId: idText.nullish(),
  title: optionalText(200),
  dueAt: isoDateText.nullish(),
  expectedAt: isoDateText.nullish(),
});

export interface ConsolidateRequestsData {
  into: 'rfq' | 'order';
  rfqId: string | null;
  orderId: string | null;
  number: string;
  lines: number;
}

define(PC.requestConsolidate, {
  schema: consolidateRequestsSchema,
  permissions: [P.manageOrders],
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, payload, ctx): Promise<{ data: ConsolidateRequestsData }> {
    const lines = await loadOrderableRequestLines(tx, payload.lineIds);
    const quantities = (line: (typeof lines)[number]) =>
      remainingToOrder({ qty: num(line.qty), qtyOrdered: num(line.qtyOrdered), status: line.status });
    const groups = groupRequestLines(
      lines
        .filter((line) => line.demandId)
        .map((line) => ({
          id: line.id,
          zohoItemId: line.zohoItemId,
          description: line.description,
          unit: line.unit,
          remaining: quantities(line),
          demandId: line.demandId,
          allocationId: line.allocationId,
        }))
    );
    const loose = lines.filter((line) => !line.demandId);
    const requestIds = new Set(lines.map((line) => line.requestId));
    if (payload.into === 'rfq') {
      const input = parseOrThrow(createRfqSchema, {
        title: payload.title ?? `Compra consolidada (${lines.length} partidas)`,
        dueAt: payload.dueAt ?? null,
        lines: [
          ...groups.map((group) =>
            group.sources.length === 1
              ? { requestLineId: group.sources[0].requestLineId, qty: group.qty }
              : {
                  sources: group.sources.map((source) => ({ requestLineId: source.requestLineId, qty: source.qty })),
                  zohoItemId: group.zohoItemId,
                  description: group.description,
                  qty: group.qty,
                  unit: group.unit,
                }
          ),
          ...loose.map((line) => ({ requestLineId: line.id })),
        ],
      });
      const { rfq, lines: rfqLines } = await createRfqInTx(tx, input, ctx);
      await markRequestsStage(tx, requestIds, 'consolidated', ctx);
      emitPurchases(
        ctx,
        PURCHASES_EVENTS.request.consolidated,
        { lineIds: payload.lineIds, into: 'rfq', rfqId: rfq.id, number: rfq.number, requestIds: [...requestIds] },
        { objectType: OBJ.rfq, objectId: rfq.id }
      );
      return { data: { into: 'rfq', rfqId: rfq.id, orderId: null, number: rfq.number, lines: rfqLines.length } };
    }
    if (!payload.supplierId) invalid('Indica el proveedor de la orden consolidada');
    const products = await tx.supplierProduct.findMany({
      where: { supplierId: payload.supplierId, zohoItemId: { in: lines.map((l) => l.zohoItemId ?? '').filter(Boolean) } },
      select: { zohoItemId: true, lastPrice: true },
    });
    const priceOf = (zohoItemId: string | null) => {
      const product = products.find((p) => zohoItemId && p.zohoItemId === zohoItemId);
      return product?.lastPrice ? num(product.lastPrice) : 0;
    };
    const input = parseOrThrow(createOrderSchema, {
      supplierId: payload.supplierId,
      expectedAt: payload.expectedAt ?? null,
      freight: 0,
      notes: payload.title ?? `Compra consolidada de ${requestIds.size} solicitudes`,
      lines: [
        ...groups.map((group) => ({
          ...(group.sources.length === 1
            ? { requestLineId: group.sources[0].requestLineId }
            : { sources: group.sources.map((source) => ({ requestLineId: source.requestLineId, qty: source.qty })) }),
          zohoItemId: group.zohoItemId,
          description: group.description,
          qty: group.qty,
          unit: group.unit,
          unitPrice: priceOf(group.zohoItemId),
          taxRate: 0.16,
        })),
        ...loose.map((line) => ({ requestLineId: line.id, qty: quantities(line), unitPrice: priceOf(line.zohoItemId), taxRate: 0.16 })),
      ],
    });
    const { order, lines: orderLines } = await createOrderInTx(tx, input, ctx);
    emitPurchases(
      ctx,
      PURCHASES_EVENTS.request.consolidated,
      { lineIds: payload.lineIds, into: 'order', orderId: order.id, number: order.number, requestIds: [...requestIds] },
      { objectType: OBJ.order, objectId: order.id }
    );
    return { data: { into: 'order', rfqId: null, orderId: order.id, number: order.number, lines: orderLines.length } };
  },
});

define(PC.requestSyncShortfall, {
  schema: syncShortfallSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, payload, ctx): Promise<{ data: ShortfallSyncResult }> {
    return { data: await syncShortfallRequestInTx(tx, payload, ctx) };
  },
});

define(PC.requestSuggestConsolidation, {
  schema: z.object({}).strict(),
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, _payload, ctx) {
    const result = await suggestConsolidationInTx(tx, ctx);
    return { data: { groups: result.groups.length, workItemId: result.workItemId } };
  },
});

// ---------------------------------------------------------------------------
// RFQ
// ---------------------------------------------------------------------------

define(PC.rfqCreate, {
  schema: createRfqSchema,
  permissions: [P.manageOrders, P.sourcing],
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, payload, ctx) {
    const { rfq, lines } = await createRfqInTx(tx, payload, ctx);
    return { data: { rfqId: rfq.id, number: rfq.number, status: rfq.status, lines: lines.length }, aggregateVersion: rfq.version };
  },
});

define(PC.rfqInvite, {
  schema: inviteSuppliersSchema,
  permissions: [P.manageOrders, P.sourcing],
  aggregate: rfqAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.rfqId,
  async handler(tx, payload, ctx): Promise<{ data: InviteSuppliersData }> {
    return { data: await inviteSuppliersInTx(tx, payload, ctx) };
  },
});

define(PC.rfqRecordSends, {
  schema: recordSendsSchema,
  permissions: [P.manageOrders, P.sourcing],
  aggregate: rfqAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.rfqId,
  async handler(tx, payload, ctx) {
    return { data: await recordSendsInTx(tx, payload, ctx) };
  },
});

define(PC.rfqReconcileSends, {
  schema: reconcileSendsSchema,
  aggregate: rfqAggregate,
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  aggregateIdOf: (payload) => payload.rfqId,
  async handler(tx, payload, ctx) {
    return { data: await reconcileStaleInvitationsInTx(tx, payload, ctx) };
  },
});

define(PC.rfqRecordInterpretation, {
  schema: recordInterpretationSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, payload, ctx): Promise<{ data: RecordInterpretationData }> {
    return { data: await recordInterpretationInTx(tx, payload, ctx) };
  },
});

define(PC.rfqManualResponse, {
  schema: manualResponseSchema,
  permissions: [P.manageOrders],
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, payload, ctx) {
    const response = await recordManualResponseInTx(tx, payload, ctx);
    const lines = await tx.rfqResponseLine.findMany({ where: { responseId: response.id } });
    return { data: { response: toRfqResponseDTO(response, lines) }, aggregateVersion: response.version };
  },
});

define(PC.rfqConfirmResponse, {
  schema: confirmResponseSchema,
  permissions: [P.manageOrders],
  aggregate: responseAggregate,
  actorTypes: HUMAN_ONLY,
  aggregateIdOf: (payload) => payload.responseId,
  async handler(tx, payload, ctx) {
    const response = await confirmResponseInTx(tx, payload, ctx);
    const lines = await tx.rfqResponseLine.findMany({ where: { responseId: response.id } });
    return { data: { response: toRfqResponseDTO(response, lines) } };
  },
});

define(PC.rfqRejectResponse, {
  schema: rejectResponseSchema,
  permissions: [P.manageOrders],
  aggregate: responseAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.responseId,
  async handler(tx, payload, ctx) {
    const response = await rejectResponseInTx(tx, payload, ctx);
    return { data: { responseId: response.id, status: response.status } };
  },
});

define(PC.rfqCompare, {
  schema: rfqIdSchema,
  permissions: [P.manageOrders, P.sourcing],
  aggregate: rfqAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.rfqId,
  async handler(tx, payload, ctx): Promise<{ data: { rfqId: string; ranking: RfqRankingEntry[] } }> {
    return { data: await compareRfqInTx(tx, payload, ctx) };
  },
});

define(PC.rfqSelectResponse, {
  schema: selectResponseSchema,
  permissions: [P.manageOrders],
  aggregate: responseAggregate,
  actorTypes: HUMAN_ONLY,
  aggregateIdOf: (payload) => payload.responseId,
  async handler(tx, payload, ctx) {
    return { data: await selectResponseInTx(tx, payload, ctx) };
  },
});

define(PC.rfqCancel, {
  schema: cancelRfqSchema,
  permissions: [P.manageOrders],
  aggregate: rfqAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.rfqId,
  async handler(tx, payload, ctx) {
    const rfq = await cancelRfqInTx(tx, payload, ctx);
    return { data: { rfqId: rfq.id, status: rfq.status } };
  },
});

define(PC.rfqExpire, {
  schema: rfqIdSchema,
  aggregate: rfqAggregate,
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  aggregateIdOf: (payload) => payload.rfqId,
  async handler(tx, payload, ctx) {
    return { data: await expireRfqInTx(tx, payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Procurement orders
// ---------------------------------------------------------------------------

async function orderDto(tx: Db, orderId: string): Promise<ProcurementOrderDTO> {
  const order = await tx.procurementOrder.findUniqueOrThrow({ where: { id: orderId } });
  const supplier = await tx.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } });
  return toOrderDTO(order, [], { supplierName: supplier?.name ?? null });
}

define(PC.orderCreate, {
  schema: createOrderSchema,
  permissions: [P.manageOrders],
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, payload, ctx) {
    const { order, lines } = await createOrderInTx(tx, payload, ctx);
    return { data: { order: await orderDto(tx, order.id), lineIds: lines.map((l) => l.id) }, aggregateVersion: order.version };
  },
});

define(PC.orderUpdate, {
  schema: updateOrderSchema,
  permissions: [P.manageOrders],
  aggregate: orderAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.orderId,
  async handler(tx, payload, ctx) {
    const { order, lines } = await updateOrderDraftInTx(tx, payload, ctx);
    return { data: { order: await orderDto(tx, order.id), lineIds: lines.map((l) => l.id) } };
  },
});

define(PC.orderSubmit, {
  schema: submitOrderSchema,
  permissions: [P.manageOrders],
  aggregate: orderAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.orderId,
  async handler(tx, payload, ctx): Promise<{ data: SubmitOrderData }> {
    const data = await submitOrderInTx(tx, payload, ctx);
    const order = await tx.procurementOrder.findUniqueOrThrow({ where: { id: payload.orderId }, select: { status: true } });
    return { data: { ...data, status: order.status } };
  },
});

define(PC.orderRequestPayment, {
  schema: requestPaymentSchema,
  permissions: [P.manageOrders],
  aggregate: orderAggregate,
  actorTypes: ANY_ACTOR,
  aggregateIdOf: (payload) => payload.orderId,
  async handler(tx, payload, ctx): Promise<{ data: RequestPaymentData }> {
    return { data: await requestPaymentInTx(tx, payload, ctx) };
  },
});

define(PC.orderMarkSent, {
  schema: markSentSchema,
  permissions: [P.manageOrders],
  aggregate: orderAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.orderId,
  async handler(tx, payload, ctx) {
    const order = await markOrderSentInTx(tx, payload, ctx);
    return { data: { orderId: order.id, status: order.status, sentVia: order.sentVia } };
  },
});

define(PC.orderAllocateLine, {
  schema: allocateLineSchema,
  permissions: [P.manageOrders],
  aggregate: orderAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: async (payload, tx) =>
    (await tx.procurementOrderLine.findUnique({ where: { id: payload.orderLineId }, select: { orderId: true } }))?.orderId ?? null,
  async handler(tx, payload, ctx) {
    return { data: await allocateLineInTx(tx, payload, ctx) };
  },
});

define(PC.orderCancel, {
  schema: cancelOrderSchema,
  permissions: [P.manageOrders],
  aggregate: orderAggregate,
  actorTypes: HUMAN_ONLY,
  aggregateIdOf: (payload) => payload.orderId,
  async handler(tx, payload, ctx) {
    const { order, compensations } = await cancelOrderInTx(tx, payload, ctx);
    return { data: { orderId: order.id, status: order.status, compensations } };
  },
});

define(PC.orderClose, {
  schema: closeOrderSchema,
  permissions: [P.manageOrders],
  aggregate: orderAggregate,
  actorTypes: HUMAN_ONLY,
  aggregateIdOf: (payload) => payload.orderId,
  async handler(tx, payload, ctx) {
    const order = await closeOrderInTx(tx, payload, ctx);
    return { data: { orderId: order.id, status: order.status } };
  },
});

define(PC.orderFollowupFailed, {
  schema: followupFailedSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, payload, ctx) {
    return { data: await recordFollowupFailureInTx(tx, payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

define(PC.receiptRecord, {
  schema: recordReceiptSchema,
  permissions: [P.receive],
  aggregate: orderAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.orderId,
  async handler(tx, payload, ctx) {
    const { receipt, lines, posted } = await recordReceiptInTx(tx, payload, ctx);
    return { data: { receiptId: receipt.id, number: receipt.number, status: receipt.status, lineIds: lines.map((l) => l.id), posted } };
  },
});

define(PC.receiptPost, {
  schema: postReceiptSchema,
  permissions: [P.receive],
  aggregate: orderAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: async (payload, tx) =>
    (await tx.goodsReceipt.findUnique({ where: { id: payload.receiptId }, select: { orderId: true } }))?.orderId ?? null,
  async handler(tx, payload, ctx): Promise<{ data: PostReceiptResult }> {
    return { data: await postReceiptInTx(tx, payload.receiptId, ctx) };
  },
});

define(PC.receiptResolveDifference, {
  schema: resolveDifferenceSchema,
  permissions: [P.receive, P.manageOrders],
  aggregate: orderAggregate,
  actorTypes: HUMAN_ONLY,
  aggregateIdOf: async (payload, tx) => {
    const line = await tx.goodsReceiptLine.findUnique({ where: { id: payload.receiptLineId }, select: { receiptId: true } });
    if (!line) return null;
    return (await tx.goodsReceipt.findUnique({ where: { id: line.receiptId }, select: { orderId: true } }))?.orderId ?? null;
  },
  async handler(tx, payload, ctx) {
    return { data: await resolveReceiptDifferenceInTx(tx, payload, ctx) };
  },
});

define(PC.receiptConfirmDirect, {
  schema: confirmDirectDeliverySchema,
  permissions: [P.receive],
  aggregate: orderAggregate,
  actorTypes: HUMAN_OR_AI,
  aggregateIdOf: (payload) => payload.orderId,
  async handler(tx, payload, ctx): Promise<{ data: ConfirmDirectDeliveryData }> {
    return { data: await confirmDirectDeliveryInTx(tx, payload, ctx) };
  },
});

define(PC.receiptSyncDirect, {
  schema: directDeliveryPlanSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, payload, ctx) {
    return { data: await syncDirectDeliveryInTx(tx, payload, ctx) };
  },
});

define(PC.receiptDirectSyncFailed, {
  schema: directSyncFailedSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, payload, ctx) {
    return { data: await recordDirectSyncFailureInTx(tx, payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Sourcing Lab
// ---------------------------------------------------------------------------

define(PC.sourcingSearch, {
  schema: sourcingSearchSchema,
  permissions: [P.sourcing],
  aggregate: 'none',
  actorTypes: HUMAN_OR_AI,
  async handler(tx, payload, ctx): Promise<{ data: SourcingSearchData }> {
    return { data: await requestSourcingSearchInTx(tx, payload, ctx) };
  },
});

define(PC.sourcingRecordResults, {
  schema: recordSourcingResultsSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, payload, ctx): Promise<{ data: RecordSourcingResultsData }> {
    return { data: await recordSourcingResultsInTx(tx, payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

const SHORTFALL_EVENT_TYPES = new Set<string>([
  OPS_EVENTS.request.created,
  OPS_EVENTS.request.rejected,
  OPS_EVENTS.request.cancelled,
  OPS_EVENTS.request.expired,
]);

function shortfallJob(areaRequestId: string, reason: string, caseId: string | null): OperationalOutboxJob {
  return {
    type: PURCHASES_JOB_TYPES.shortfallSync,
    payload: { areaRequestId },
    dedupeKey: `${PURCHASES_JOB_TYPES.shortfallSync}:${areaRequestId}:${reason}`.slice(0, 190),
    groupKey: caseId ? `case:${caseId}` : undefined,
    priority: JOB_PRIORITY.interactive,
    maxAttempts: 5,
    createdBy: 'purchases',
  };
}

/** Pure part of the in-transaction reaction: shortfall requests to Compras created or closed. */
export function planShortfallJobs(events: readonly OperationalEventRecord[]): OperationalOutboxJob[] {
  const jobs: OperationalOutboxJob[] = [];
  for (const event of events) {
    if (!SHORTFALL_EVENT_TYPES.has(event.type)) continue;
    const { requestId, kind, toAreaKey } = event.payload as { requestId?: unknown; kind?: unknown; toAreaKey?: unknown };
    if (typeof requestId !== 'string' || toAreaKey !== 'compras') continue;
    if (!(SHORTFALL_REQUEST_KINDS as readonly string[]).includes(String(kind))) continue;
    jobs.push(shortfallJob(requestId, event.type, event.caseId));
  }
  return jobs;
}

/** In-transaction reaction (never lost): plans `purchases.shortfall_sync` jobs. */
export async function planPurchasesJobsInTransaction(
  tx: Prisma.TransactionClient,
  events: readonly OperationalEventRecord[]
): Promise<OperationalOutboxJob[]> {
  const jobs = planShortfallJobs(events);
  const cancelledAllocationIds = events
    .filter((event) => event.type === OPS_EVENTS.allocation.cancelled && typeof event.payload.allocationId === 'string')
    .map((event) => event.payload.allocationId as string);
  if (cancelledAllocationIds.length > 0) {
    const allocations = await tx.demandAllocation.findMany({
      where: { id: { in: cancelledAllocationIds }, linkedType: 'area_request', linkedId: { not: null }, source: { in: ['purchase', 'direct_supplier'] } },
      select: { id: true, linkedId: true, caseId: true },
    });
    for (const allocation of allocations) {
      jobs.push(shortfallJob(allocation.linkedId!, `allocation_cancelled:${allocation.id}`, allocation.caseId));
    }
  }
  return jobs;
}

type GlobalWithPurchasesReactions = typeof globalThis & {
  __unikPurchasesTxUnsubscribe?: () => void;
  __unikPurchasesApprovalUnsubscribe?: () => void;
  __unikPurchasesSettlementUnsubscribe?: () => void;
  __unikPurchasesSettlementReversedUnsubscribe?: () => void;
};

function registerPurchasesReactions(): void {
  const scope = globalThis as GlobalWithPurchasesReactions;
  scope.__unikPurchasesTxUnsubscribe?.();
  scope.__unikPurchasesTxUnsubscribe = onOperationalEventsInTransaction(async (tx, events, sink) => {
    if (!(await isOpsFlagEnabled('purchases'))) return;
    for (const job of await planPurchasesJobsInTransaction(tx, events)) sink.outbox(job);
  });
  scope.__unikPurchasesApprovalUnsubscribe?.();
  scope.__unikPurchasesApprovalUnsubscribe = onApprovalDecided(OBJ.order, applyOrderApprovalDecision);
  scope.__unikPurchasesSettlementUnsubscribe?.();
  scope.__unikPurchasesSettlementUnsubscribe = registerProcurementSettlementHandler(async (tx, obligation, _settlement, ctx) => {
    if (obligation.procurementOrderId) await markOrderPaid(tx, obligation.procurementOrderId, ctx);
  });
  scope.__unikPurchasesSettlementReversedUnsubscribe?.();
  scope.__unikPurchasesSettlementReversedUnsubscribe = registerProcurementSettlementReversedHandler(async (tx, obligation, _settlement, ctx) => {
    if (obligation.procurementOrderId) await markOrderPaid(tx, obligation.procurementOrderId, ctx);
  });
  if (isKnownPermission('purchases.approve')) {
    registerApprovalScopePermission('procurement', 'purchases.approve');
  } else {
    log('approve_permission_not_registered', { scope: 'procurement' });
  }
}

registerPurchasesReactions();

// ---------------------------------------------------------------------------
// Service wrappers: fn(actor, input, options?) → CommandResult
// ---------------------------------------------------------------------------

export interface PurchasesCommandOptions {
  /** Client UUID (offline queue) or deterministic id (tools); a new one by default. */
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  occurredAt?: string;
  /** Server clock (tests). */
  now?: Date;
  /** `ai` for AI identities (default: from `actor.isBot`). */
  actorType?: 'user' | 'ai';
}

type Input<S extends ZodTypeAny> = z.input<S>;

function runAs<D>(
  actor: CurrentUser,
  type: PurchasesCommandType,
  aggregate: { type: string; id: string | null | undefined },
  payload: unknown,
  options: PurchasesCommandOptions = {}
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    {
      commandId: options.commandId ?? randomUUID(),
      type,
      actor: { type: options.actorType ?? (actor.isBot ? 'ai' : 'user'), id: actor.id },
      aggregate: { type: aggregate.type, id: String(aggregate.id || 'missing').slice(0, 200) },
      expectedVersion: options.expectedVersion,
      payload,
      deviceId: options.deviceId,
      occurredAt: options.occurredAt,
    },
    actor,
    { now: options.now }
  );
}

function runSystem<D>(
  type: PurchasesCommandType,
  aggregate: { type: string; id: string },
  payload: unknown,
  commandId: string,
  actorId: string,
  now?: Date
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    { commandId: commandId.slice(0, 160), type, actor: { type: 'system', id: actorId }, aggregate, payload },
    null,
    { now }
  );
}

function rejected<D>(type: string, code: string, message: string): CommandResult<D> {
  return {
    commandId: '',
    type,
    status: 'rejected',
    errorCode: code,
    message,
    aggregateVersion: 0,
    emittedEventIds: [],
    createdWorkItemIds: [],
  };
}

export const createSupplier = (actor: CurrentUser, input: Input<typeof createSupplierSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ supplier: ReturnType<typeof toSupplierDTO> }>(actor, PC.supplierCreate, { type: OBJ.supplier, id: 'new' }, input, options);

export const updateSupplier = (actor: CurrentUser, input: Input<typeof updateSupplierSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ supplier: ReturnType<typeof toSupplierDTO> }>(actor, PC.supplierUpdate, { type: OBJ.supplier, id: input.supplierId }, input, options);

export const linkSupplierToZohoContact = (actor: CurrentUser, input: Input<typeof linkZohoContactSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ supplier: ReturnType<typeof toSupplierDTO> }>(actor, PC.supplierLinkZoho, { type: OBJ.supplier, id: input.supplierId }, input, options);

export const upsertSupplierProduct = (actor: CurrentUser, input: Input<typeof upsertSupplierProductSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ supplierProductId: string; supplierId: string }>(actor, PC.supplierProductUpsert, { type: OBJ.supplierProduct, id: input.supplierId }, input, options);

export const recordSupplierEvaluation = (actor: CurrentUser, input: Input<typeof evaluateSupplierSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ evaluationId: string; supplier: ReturnType<typeof toSupplierDTO> }>(actor, PC.supplierEvaluate, { type: OBJ.supplier, id: input.supplierId }, input, options);

export const promoteCandidateToSupplier = (actor: CurrentUser, input: Input<typeof promoteCandidateSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ supplier: ReturnType<typeof toSupplierDTO>; created: boolean }>(actor, PC.candidatePromote, { type: OBJ.candidate, id: input.candidateId }, input, options);

export const setCandidateStatus = (actor: CurrentUser, input: Input<typeof candidateStatusSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ candidateId: string; status: string }>(actor, PC.candidateStatus, { type: OBJ.candidate, id: input.candidateId }, input, options);

export const createPurchaseRequest = (actor: CurrentUser, input: Input<typeof createPurchaseRequestSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ request: ReturnType<typeof toPurchaseRequestDTO>; areaRequestIds: string[] }>(
    actor,
    PC.requestCreate,
    { type: OBJ.request, id: input.caseId ? `case:${input.caseId}` : 'new' },
    input,
    options
  );

export const cancelPurchaseRequest = (actor: CurrentUser, input: Input<typeof cancelPurchaseRequestSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ requestId: string; status: string }>(actor, PC.requestCancel, { type: OBJ.request, id: input.requestId }, input, options);

export const consolidateRequests = (actor: CurrentUser, input: Input<typeof consolidateRequestsSchema>, options?: PurchasesCommandOptions) =>
  runAs<ConsolidateRequestsData>(actor, PC.requestConsolidate, { type: OBJ.request, id: 'consolidation' }, input, options);

export const createRfq = (actor: CurrentUser, input: Input<typeof createRfqSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ rfqId: string; number: string; status: string; lines: number }>(actor, PC.rfqCreate, { type: OBJ.rfq, id: 'new' }, input, options);

/** Creates the invitations (command) and sends them through the inbox; repeating the command id never sends twice. */
export async function inviteSuppliers(
  actor: CurrentUser,
  input: Input<typeof inviteSuppliersSchema>,
  options: PurchasesCommandOptions = {}
): Promise<{ command: CommandResult<InviteSuppliersData>; sent: number; failed: number }> {
  const command = await runAs<InviteSuppliersData>(actor, PC.rfqInvite, { type: OBJ.rfq, id: input.rfqId }, input, options);
  if (command.status !== 'completed' || !command.data) return { command, sent: 0, failed: 0 };
  const sends = await sendRfqInvitations(actor, command.data.rfqId, command.data.toSend, {
    actorType: options.actorType ?? (actor.isBot ? 'ai' : 'user'),
    commandId: `${command.commandId}:sends`,
    now: options.now,
  });
  return { command, sent: sends.sent, failed: sends.failed + command.data.failed.length };
}

export const recordManualRfqResponse = (actor: CurrentUser, input: Input<typeof manualResponseSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ response: ReturnType<typeof toRfqResponseDTO> }>(actor, PC.rfqManualResponse, { type: OBJ.rfqResponse, id: input.rfqId }, input, options);

export const confirmRfqResponse = (actor: CurrentUser, input: Input<typeof confirmResponseSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ response: ReturnType<typeof toRfqResponseDTO> }>(actor, PC.rfqConfirmResponse, { type: OBJ.rfqResponse, id: input.responseId }, input, options);

export const rejectRfqResponse = (actor: CurrentUser, input: Input<typeof rejectResponseSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ responseId: string; status: string }>(actor, PC.rfqRejectResponse, { type: OBJ.rfqResponse, id: input.responseId }, input, options);

export const compareRfq = (actor: CurrentUser, input: Input<typeof rfqIdSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ rfqId: string; ranking: RfqRankingEntry[] }>(actor, PC.rfqCompare, { type: OBJ.rfq, id: input.rfqId }, input, options);

export const selectRfqResponse = (actor: CurrentUser, input: Input<typeof selectResponseSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ responseId: string; rfqId: string; orderId: string; orderNumber: string; supplierId: string }>(
    actor,
    PC.rfqSelectResponse,
    { type: OBJ.rfqResponse, id: input.responseId },
    input,
    options
  );

export const cancelRfq = (actor: CurrentUser, input: Input<typeof cancelRfqSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ rfqId: string; status: string }>(actor, PC.rfqCancel, { type: OBJ.rfq, id: input.rfqId }, input, options);

export const createProcurementOrder = (actor: CurrentUser, input: Input<typeof createOrderSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ order: ProcurementOrderDTO; lineIds: string[] }>(actor, PC.orderCreate, { type: OBJ.order, id: `supplier:${input.supplierId}` }, input, options);

export const updateProcurementOrderDraft = (actor: CurrentUser, input: Input<typeof updateOrderSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ order: ProcurementOrderDTO; lineIds: string[] }>(actor, PC.orderUpdate, { type: OBJ.order, id: input.orderId }, input, options);

export const submitProcurementOrder = (actor: CurrentUser, input: Input<typeof submitOrderSchema>, options?: PurchasesCommandOptions) =>
  runAs<SubmitOrderData>(actor, PC.orderSubmit, { type: OBJ.order, id: input.orderId }, input, options);

export const requestProcurementPayment = (actor: CurrentUser, input: Input<typeof requestPaymentSchema>, options?: PurchasesCommandOptions) =>
  runAs<RequestPaymentData>(actor, PC.orderRequestPayment, { type: OBJ.order, id: input.orderId }, input, options);

export async function allocateProcurementLine(actor: CurrentUser, input: Input<typeof allocateLineSchema>, options?: PurchasesCommandOptions) {
  const line = await prisma.procurementOrderLine.findUnique({ where: { id: String(input.orderLineId ?? '') }, select: { orderId: true } });
  return runAs<{ orderId: string; allocationIds: string[] }>(actor, PC.orderAllocateLine, { type: OBJ.order, id: line?.orderId }, input, options);
}

export const cancelProcurementOrder = (actor: CurrentUser, input: Input<typeof cancelOrderSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ orderId: string; status: string; compensations: string[] }>(actor, PC.orderCancel, { type: OBJ.order, id: input.orderId }, input, options);

export const closeProcurementOrder = (actor: CurrentUser, input: Input<typeof closeOrderSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ orderId: string; status: string }>(actor, PC.orderClose, { type: OBJ.order, id: input.orderId }, input, options);

export const recordGoodsReceipt = (actor: CurrentUser, input: Input<typeof recordReceiptSchema>, options?: PurchasesCommandOptions) =>
  runAs<{ receiptId: string; number: string; status: string; lineIds: string[]; posted: PostReceiptResult | null }>(
    actor,
    PC.receiptRecord,
    { type: OBJ.order, id: input.orderId },
    input,
    options
  );

export async function postGoodsReceipt(actor: CurrentUser, input: Input<typeof postReceiptSchema>, options?: PurchasesCommandOptions) {
  const receipt = await prisma.goodsReceipt.findUnique({ where: { id: String(input.receiptId ?? '') }, select: { orderId: true } });
  return runAs<PostReceiptResult>(actor, PC.receiptPost, { type: OBJ.order, id: receipt?.orderId }, input, options);
}

export async function resolveReceiptDifference(actor: CurrentUser, input: Input<typeof resolveDifferenceSchema>, options?: PurchasesCommandOptions) {
  const line = await prisma.goodsReceiptLine.findUnique({ where: { id: String(input.receiptLineId ?? '') }, select: { receiptId: true } });
  const receipt = line ? await prisma.goodsReceipt.findUnique({ where: { id: line.receiptId }, select: { orderId: true } }) : null;
  return runAs<{ orderId: string; orderStatus: string; creditedQty: number }>(actor, PC.receiptResolveDifference, { type: OBJ.order, id: receipt?.orderId }, input, options);
}

export const confirmDirectDelivery = (actor: CurrentUser, input: Input<typeof confirmDirectDeliverySchema>, options?: PurchasesCommandOptions) =>
  runAs<ConfirmDirectDeliveryData>(actor, PC.receiptConfirmDirect, { type: OBJ.order, id: input.orderId }, input, options);

export const runSourcingSearch = (actor: CurrentUser, input: Input<typeof sourcingSearchSchema>, options?: PurchasesCommandOptions) =>
  runAs<SourcingSearchData>(actor, PC.sourcingSearch, { type: OBJ.search, id: 'new' }, input, options);

// ---------------------------------------------------------------------------
// Send an order to the supplier (PDF and/or message)
// ---------------------------------------------------------------------------

export const sendOrderSchema = z.object({
  orderId: idText,
  via: z.enum(['whatsapp', 'sms', 'telegram', 'pdf']).default('pdf'),
});

function moneyText(value: Prisma.Decimal | number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(Number(value.toString()));
  } catch {
    return `${Number(value.toString()).toFixed(2)} ${currency}`;
  }
}

async function buildOrderPdf(actor: CurrentUser, orderId: string): Promise<{ objectId: string }> {
  const order = await prisma.procurementOrder.findUniqueOrThrow({ where: { id: orderId } });
  const lines = await prisma.procurementOrderLine.findMany({ where: { orderId, status: { not: 'cancelled' } }, orderBy: { sortOrder: 'asc' } });
  const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: order.supplierId } });
  const config = await getSourcingConfig();
  const { generatePdfReport } = await import('@/modules/ai/generators/pdf-generator');
  const filePath = path.join(tmpdir(), `unik-${order.number}-${randomUUID()}.pdf`);
  try {
    await generatePdfReport(filePath, {
      title: `Orden de compra ${order.number}`,
      subtitle: `${config.companyName} · Proveedor: ${supplier.name}`,
      author: config.companyName,
      orientation: 'portrait',
      columns: [
        { header: '#', key: 'index', width: 24, align: 'right', nowrap: true },
        { header: 'Descripción', key: 'description', width: 220 },
        { header: 'Cantidad', key: 'qty', width: 60, align: 'right', nowrap: true },
        { header: 'Unidad', key: 'unit', width: 50 },
        { header: 'Precio', key: 'unitPrice', width: 80, align: 'right', nowrap: true },
        { header: 'Importe', key: 'lineTotal', width: 90, align: 'right', nowrap: true },
      ],
      rows: lines.map((line, index) => ({
        index: index + 1,
        description: line.description,
        qty: Number(line.qty.toString()),
        unit: line.unit,
        unitPrice: moneyText(line.unitPrice, order.currency),
        lineTotal: moneyText(line.lineTotal, order.currency),
      })),
      summaryCards: [
        { label: 'Subtotal', value: moneyText(order.subtotal, order.currency) },
        { label: 'IVA', value: moneyText(order.taxTotal, order.currency) },
        { label: 'Flete', value: moneyText(order.freight, order.currency) },
        { label: 'Total', value: moneyText(order.total, order.currency) },
      ],
      metadata: {
        Folio: order.number,
        Fecha: isoDay(new Date()),
        Proveedor: `${supplier.number} · ${supplier.name}`,
        Entrega: labelOf(ORDER_DELIVERY_MODE_LABELS, order.deliveryMode),
        'Fecha estimada': order.expectedAt ? isoDay(order.expectedAt) : 'Por confirmar',
        'Condición de pago': labelOf(PAYMENT_MODE_LABELS, order.paymentMode),
      },
    });
    const object = await saveGeneratedFile({
      createdBy: actor.id,
      purpose: 'document',
      fileName: `${order.number}.pdf`,
      mimeType: 'application/pdf',
      source: { filePath },
      retentionPolicy: 'protected',
      restricted: true,
      metadata: { module: 'purchases', kind: 'procurement_order_pdf', orderId },
    });
    return { objectId: object.id };
  } finally {
    await fsp.unlink(filePath).catch(() => undefined);
  }
}

/**
 * Generates the order PDF and, for a messaging channel, opens (or reuses) the
 * supplier conversation with the order message and the PDF; then records the
 * send (`purchases.order.mark_sent`).
 */
export async function sendOrderToSupplier(
  actor: CurrentUser,
  input: Input<typeof sendOrderSchema>,
  options: PurchasesCommandOptions = {}
): Promise<{ command: CommandResult<{ orderId: string; status: string; sentVia: string | null }>; pdfObjectId: string | null; conversationId: string | null }> {
  const parsed = sendOrderSchema.safeParse(input);
  if (!parsed.success) return { command: rejected(PC.orderMarkSent, 'invalid_payload', 'Datos inválidos para enviar la orden'), pdfObjectId: null, conversationId: null };
  const { orderId, via } = parsed.data;
  if (!(await isOpsFlagEnabled('purchases'))) {
    return { command: rejected(PC.orderMarkSent, 'module_disabled', MODULE_DISABLED_MESSAGE), pdfObjectId: null, conversationId: null };
  }
  if (!hasPermission(actor, P.manageOrders)) {
    return { command: rejected(PC.orderMarkSent, 'forbidden', 'No tienes permisos para enviar órdenes de compra'), pdfObjectId: null, conversationId: null };
  }
  const order = await prisma.procurementOrder.findUnique({ where: { id: orderId } });
  if (!order) return { command: rejected(PC.orderMarkSent, 'not_found', 'No se encontró la orden de compra'), pdfObjectId: null, conversationId: null };
  const check = checkSendOrder(order.status);
  if (!check.ok) return { command: rejected(PC.orderMarkSent, check.code, check.message), pdfObjectId: null, conversationId: null };

  const { objectId: pdfObjectId } = await buildOrderPdf(actor, order.id);
  let conversationId: string | null = null;
  let messageId: string | null = null;
  if (via !== 'pdf') {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: order.supplierId } });
    const channels = parseChannels(supplier.channels);
    const to =
      channels.find((c) => c.type === via)?.value ??
      (via !== 'telegram' ? (channels.find((c) => c.type === 'phone')?.value ?? supplier.primaryPhone) : null);
    if (!to) {
      return {
        command: rejected(PC.orderMarkSent, 'invalid_payload', `${supplier.name} no tiene ${via === 'telegram' ? 'Telegram' : 'teléfono'} registrado`),
        pdfObjectId,
        conversationId: null,
      };
    }
    const config = await getSourcingConfig();
    const provider = CHANNEL_PROVIDER[via as MessagingChannelType];
    const configured = config.rfqAccountId ? await prisma.commAccount.findUnique({ where: { id: config.rfqAccountId } }) : null;
    const account =
      configured && configured.provider === provider && configured.status === 'active'
        ? configured
        : await prisma.commAccount.findFirst({ where: { provider, status: 'active' }, orderBy: { createdAt: 'asc' } });
    if (!account) {
      return { command: rejected(PC.orderMarkSent, 'invalid_state', 'No hay una cuenta activa de ese canal en la bandeja'), pdfObjectId, conversationId: null };
    }
    const lines = await prisma.procurementOrderLine.findMany({ where: { orderId: order.id, status: { not: 'cancelled' } }, orderBy: { sortOrder: 'asc' } });
    const orderMessage = {
      template: config.orderMessageTemplate,
      supplierName: supplier.name,
      companyName: config.companyName,
      folio: order.number,
      lines: lines.map((line) => ({
        description: line.description,
        qty: num(line.qty),
        unit: line.unit,
        unitPrice: num(line.unitPrice),
        currency: order.currency,
      })),
      total: num(order.total),
      currency: order.currency,
      deliveryLabel: labelOf(ORDER_DELIVERY_MODE_LABELS, order.deliveryMode),
      expectedAt: order.expectedAt,
    };
    if (via === 'whatsapp' && !config.orderTemplateKey && !(await whatsappWindowOpen(prisma, { accountId: account.id, to, now: options.now ?? new Date() }))) {
      return {
        command: rejected(
          PC.orderMarkSent,
          'invalid_state',
          `WhatsApp sólo permite escribir primero a ${supplier.name} con una plantilla aprobada: configura la plantilla de órdenes o envíala por SMS o PDF`
        ),
        pdfObjectId,
        conversationId: null,
      };
    }
    try {
      const started = await startConversation(actor, {
        accountId: account.id,
        to,
        contactName: supplier.name.slice(0, 120),
        body: renderOrderMessage(orderMessage),
        ...(via === 'whatsapp' && config.orderTemplateKey
          ? { templateKey: config.orderTemplateKey, templateVariables: orderTemplateVariables(orderMessage) }
          : {}),
      });
      conversationId = started.conversation.id;
      messageId = started.message?.id ?? null;
      if (started.message?.status === 'failed') {
        return {
          command: rejected(PC.orderMarkSent, 'invalid_state', started.message.error ?? 'El canal rechazó el mensaje'),
          pdfObjectId,
          conversationId,
        };
      }
      try {
        await sendOutboundMessage({
          accountId: account.id,
          conversationId,
          body: `Orden de compra ${order.number} (PDF)`,
          mediaObjectIds: [pdfObjectId],
          sentByUserId: actor.id,
          actor,
        });
      } catch (err) {
        log('order_pdf_message_failed', { orderId: order.id, message: err instanceof Error ? err.message : String(err) });
      }
      const tag = `${ORDER_CONVERSATION_TAG_PREFIX}${order.id}`;
      if (!started.conversation.tags.includes(tag)) {
        await updateConversation(actor, conversationId, { tags: [...started.conversation.tags, tag].slice(-30) }).catch((err) =>
          log('order_tag_failed', { orderId: order.id, message: err instanceof Error ? err.message : String(err) })
        );
      }
    } catch (err) {
      return {
        command: rejected(PC.orderMarkSent, 'invalid_state', truncate(err instanceof Error ? err.message : 'No se pudo enviar al proveedor', 300)),
        pdfObjectId,
        conversationId,
      };
    }
  }
  const command = await runAs<{ orderId: string; status: string; sentVia: string | null }>(
    actor,
    PC.orderMarkSent,
    { type: OBJ.order, id: order.id },
    { orderId: order.id, via, conversationId, messageId, pdfObjectId },
    options
  );
  if (command.status === 'completed') log('order_sent', { orderId: order.id, via, status: orderStatusLabel(command.data?.status ?? '') });
  return { command, pdfObjectId, conversationId };
}

// ---------------------------------------------------------------------------
// System runners (jobs)
// ---------------------------------------------------------------------------

export function runShortfallSync(areaRequestId: string, jobId: string, attempt: number, now?: Date) {
  return runSystem<ShortfallSyncResult>(
    PC.requestSyncShortfall,
    { type: 'area_request', id: areaRequestId },
    { areaRequestId },
    `purchases:shortfall:${areaRequestId}:${jobId}:${attempt}`,
    'purchases.shortfall_sync',
    now
  );
}

export function runConsolidationSuggestion(now: Date = new Date()) {
  return runSystem<{ groups: number; workItemId: string | null }>(
    PC.requestSuggestConsolidation,
    { type: OBJ.request, id: 'consolidation' },
    {},
    `purchases:consolidate_suggest:${isoDay(now)}`,
    'purchases.consolidate_suggest',
    now
  );
}

/** System sweep (hourly job) of the invitations of an RFQ claimed for sending whose result was never recorded. */
export function runRfqSendReconciliation(rfqId: string, staleBefore: Date, bucket: string, now?: Date) {
  return runSystem<{ sent: number; failed: number }>(
    PC.rfqReconcileSends,
    { type: OBJ.rfq, id: rfqId },
    { rfqId, staleBefore: staleBefore.toISOString() },
    `purchases:rfq_reconcile_sends:${rfqId}:${bucket}`,
    'purchases.rfq_expire',
    now
  );
}

export function runRfqExpiration(rfqId: string, bucket: string, now?: Date) {
  return runSystem<{ expired: boolean; invitations: number; responses: number; status: string }>(
    PC.rfqExpire,
    { type: OBJ.rfq, id: rfqId },
    { rfqId },
    `purchases:rfq_expire:${rfqId}:${bucket}`,
    'purchases.rfq_expire',
    now
  );
}

/** Follow-up of an approved order: registers the payable (and the payment request for prepaid/cod). */
export async function runOrderPaymentFollowup(orderId: string, jobId: string, attempt: number, now?: Date) {
  const result = await runSystem<RequestPaymentData>(
    PC.orderRequestPayment,
    { type: OBJ.order, id: orderId },
    { orderId },
    `purchases:order_followup:${orderId}:${jobId}:${attempt}`,
    'purchases.order_followup',
    now
  );
  if (result.status !== 'rejected' || ['duplicate', 'invalid_state', 'not_found', 'module_disabled'].includes(result.errorCode ?? '')) {
    return { result, failure: null };
  }
  if (result.errorCode === 'concurrency_conflict') return { result, failure: null };
  const failure = await runSystem<{ workItemId: string | null }>(
    PC.orderFollowupFailed,
    { type: OBJ.order, id: orderId },
    { orderId, step: 'payment', message: result.message ?? result.errorCode ?? 'Error desconocido' },
    `purchases:order_followup_failed:${orderId}:${jobId}`,
    'purchases.order_followup',
    now
  );
  return { result, failure };
}

export async function runDirectDeliverySync(plan: DirectDeliveryPlan, jobId: string, attempt: number, now?: Date) {
  const result = await runSystem<{ deliveryOrderIds: string[]; resolvedRequestIds: string[] }>(
    PC.receiptSyncDirect,
    { type: OBJ.receipt, id: plan.receiptId },
    plan,
    `purchases:direct_sync:${plan.receiptId}:${jobId}:${attempt}`,
    'purchases.direct_delivery_sync',
    now
  );
  if (result.status !== 'rejected' || result.errorCode === 'concurrency_conflict') return { result, failure: null };
  const failure = await runSystem<{ incidentId: string; workItemId: string | null }>(
    PC.receiptDirectSyncFailed,
    { type: OBJ.receipt, id: plan.receiptId },
    { receiptId: plan.receiptId, message: result.message ?? result.errorCode ?? 'Error desconocido' },
    `purchases:direct_sync_failed:${plan.receiptId}`,
    'purchases.direct_delivery_sync',
    now
  );
  return { result, failure };
}

export const PURCHASES_COMMAND_TYPES: readonly string[] = Object.values(PC);

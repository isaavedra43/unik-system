import type { AreaKey } from '@/modules/operations/types';

/**
 * Vocabulary of Compras y Sourcing (plan 6.1): states (identical to the `///`
 * comments of prisma/schema.prisma, where every state is a String), Spanish
 * labels, event types, command types, job types and object types.
 *
 * Pure module (no Prisma, no server imports): safe for client components.
 */

export const PURCHASES_AREA_KEY: AreaKey = 'compras';

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const SUPPLIER_STATUSES = ['active', 'blocked', 'archived'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  active: 'Activo',
  blocked: 'Bloqueado',
  archived: 'Archivado',
};

export const SUPPLIER_CHANNEL_TYPES = [
  'whatsapp',
  'sms',
  'telegram',
  'email',
  'phone',
  'web',
] as const;
export type SupplierChannelType = (typeof SUPPLIER_CHANNEL_TYPES)[number];
export const SUPPLIER_CHANNEL_LABELS: Record<SupplierChannelType, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  telegram: 'Telegram',
  email: 'Correo',
  phone: 'Teléfono',
  web: 'Sitio web',
};

/** Channels through which an RFQ or an order can be sent by the inbox. */
export const MESSAGING_CHANNEL_TYPES = ['whatsapp', 'sms', 'telegram'] as const;
export type MessagingChannelType = (typeof MESSAGING_CHANNEL_TYPES)[number];

/** Comms provider of each messaging channel. */
export const CHANNEL_PROVIDER: Record<MessagingChannelType, string> = {
  whatsapp: 'twilio_whatsapp',
  sms: 'twilio_sms',
  telegram: 'telegram',
};

export const PAYMENT_MODES = ['prepaid', 'credit', 'cod'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  prepaid: 'Pago anticipado',
  credit: 'Crédito',
  cod: 'Contra entrega',
};

export const SUPPLIER_PRODUCT_SOURCES = ['rfq', 'receipt', 'manual'] as const;

// ---------------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------------

export const PURCHASE_REQUEST_STATUSES = [
  'draft',
  'open',
  'consolidated',
  'sourcing',
  'ordered',
  'closed',
  'cancelled',
] as const;
export type PurchaseRequestStatus = (typeof PURCHASE_REQUEST_STATUSES)[number];
export const PURCHASE_REQUEST_STATUS_LABELS: Record<PurchaseRequestStatus, string> = {
  draft: 'Borrador',
  open: 'Abierta',
  consolidated: 'Consolidada',
  sourcing: 'Cotizando',
  ordered: 'Ordenada',
  closed: 'Cerrada',
  cancelled: 'Cancelada',
};
export const PURCHASE_REQUEST_OPEN_STATUSES = [
  'draft',
  'open',
  'consolidated',
  'sourcing',
  'ordered',
] as const;

export const PURCHASE_REQUEST_LINE_STATUSES = ['open', 'ordered', 'received', 'cancelled'] as const;
export type PurchaseRequestLineStatus = (typeof PURCHASE_REQUEST_LINE_STATUSES)[number];
export const PURCHASE_REQUEST_LINE_STATUS_LABELS: Record<PurchaseRequestLineStatus, string> = {
  open: 'Pendiente',
  ordered: 'Ordenada',
  received: 'Recibida',
  cancelled: 'Cancelada',
};

export const REQUEST_PRIORITIES = ['normal', 'high', 'urgent'] as const;

/** Area requests addressed to Compras that turn into a purchase request (plan 6.1, núcleo). */
export const SHORTFALL_REQUEST_KINDS = [
  'purchase_shortfall',
  'material_shortfall',
  'direct_delivery',
] as const;

// ---------------------------------------------------------------------------
// RFQ
// ---------------------------------------------------------------------------

export const RFQ_STATUSES = [
  'draft',
  'sent',
  'collecting',
  'compared',
  'closed',
  'cancelled',
] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];
export const RFQ_STATUS_LABELS: Record<RfqStatus, string> = {
  draft: 'Borrador',
  sent: 'Enviada',
  collecting: 'Recibiendo respuestas',
  compared: 'Comparada',
  closed: 'Cerrada',
  cancelled: 'Cancelada',
};
export const RFQ_OPEN_STATUSES = ['draft', 'sent', 'collecting', 'compared'] as const;

export const RFQ_INVITATION_STATUSES = [
  'pending',
  'sent',
  'failed',
  'replied',
  'declined',
  'expired',
] as const;
export type RfqInvitationStatus = (typeof RFQ_INVITATION_STATUSES)[number];
export const RFQ_INVITATION_STATUS_LABELS: Record<RfqInvitationStatus, string> = {
  pending: 'Por enviar',
  sent: 'Enviada',
  failed: 'Falló el envío',
  replied: 'Respondió',
  declined: 'Declinó',
  expired: 'Sin respuesta',
};

export const RFQ_RESPONSE_STATUSES = [
  'parsed',
  'needs_review',
  'confirmed',
  'rejected',
  'selected',
] as const;
export type RfqResponseStatus = (typeof RFQ_RESPONSE_STATUSES)[number];
export const RFQ_RESPONSE_STATUS_LABELS: Record<RfqResponseStatus, string> = {
  parsed: 'Interpretada',
  needs_review: 'Requiere revisión',
  confirmed: 'Confirmada',
  rejected: 'Descartada',
  selected: 'Seleccionada',
};

// ---------------------------------------------------------------------------
// Procurement orders and receipts
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: 'Sin pagar',
  partial: 'Pago parcial',
  paid: 'Pagada',
};

export const ORDER_DELIVERY_MODES = ['warehouse', 'direct_to_customer'] as const;
export type OrderDeliveryMode = (typeof ORDER_DELIVERY_MODES)[number];
export const ORDER_DELIVERY_MODE_LABELS: Record<OrderDeliveryMode, string> = {
  warehouse: 'Entrega en bodega',
  direct_to_customer: 'Entrega directa al cliente',
};

export const ORDER_SEND_CHANNELS = ['whatsapp', 'sms', 'telegram', 'pdf'] as const;
export type OrderSendChannel = (typeof ORDER_SEND_CHANNELS)[number];

export const ORDER_LINE_STATUSES = ['open', 'partial', 'received', 'closed', 'cancelled'] as const;
export type OrderLineStatus = (typeof ORDER_LINE_STATUSES)[number];

export const RECEIPT_MODES = ['warehouse', 'direct_delivery'] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];
export const RECEIPT_STATUSES = ['draft', 'posted', 'disputed'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const RECEIPT_STATUS_LABELS: Record<ReceiptStatus, string> = {
  draft: 'Borrador',
  posted: 'Registrada',
  disputed: 'Con diferencias',
};

export const DIFFERENCE_KINDS = ['none', 'short', 'over', 'damaged', 'wrong_item'] as const;
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number];
export const DIFFERENCE_KIND_LABELS: Record<DifferenceKind, string> = {
  none: 'Sin diferencia',
  short: 'Faltante',
  over: 'Excedente',
  damaged: 'Dañado',
  wrong_item: 'Artículo equivocado',
};

/** How Compras settles a receipt difference with the supplier. */
export const DIFFERENCE_RESOLUTIONS = ['replacement', 'credit', 'return', 'accept'] as const;
export type DifferenceResolution = (typeof DIFFERENCE_RESOLUTIONS)[number];
export const DIFFERENCE_RESOLUTION_LABELS: Record<DifferenceResolution, string> = {
  replacement: 'El proveedor repone lo faltante',
  credit: 'Se ajusta la orden (nota de crédito)',
  return: 'Se devuelve al proveedor',
  accept: 'Se acepta como llegó',
};

// ---------------------------------------------------------------------------
// Sourcing Lab
// ---------------------------------------------------------------------------

export const SOURCING_PROVIDERS = ['brave_search', 'catalog_page'] as const;
export type SourcingProviderKey = (typeof SOURCING_PROVIDERS)[number];
export const SOURCING_PROVIDER_LABELS: Record<SourcingProviderKey, string> = {
  brave_search: 'Búsqueda web (Brave)',
  catalog_page: 'Catálogo de proveedor',
};

export const SOURCING_SEARCH_STATUSES = ['pending', 'done', 'failed'] as const;
export type SourcingSearchStatus = (typeof SOURCING_SEARCH_STATUSES)[number];

export const CANDIDATE_STATUSES = [
  'new',
  'contacted',
  'rfq_sent',
  'quoted',
  'approved',
  'rejected',
  'promoted',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  new: 'Nuevo',
  contacted: 'Contactado',
  rfq_sent: 'Cotización enviada',
  quoted: 'Cotizó',
  approved: 'Aprobado',
  rejected: 'Descartado',
  promoted: 'Ya es proveedor',
};

/** Storage purpose of the Sourcing Lab evidence (raw results and fetched pages). */
export const SOURCING_EVIDENCE_PURPOSE = 'sourcing_evidence';

/** Upload target of receipt/direct delivery photos: `{type: 'purchase_receipt_evidence', id: orderId}`. */
export const RECEIPT_EVIDENCE_UPLOAD_TARGET = 'purchase_receipt_evidence';

// ---------------------------------------------------------------------------
// Object types, events, commands and jobs
// ---------------------------------------------------------------------------

export const PURCHASES_OBJECT_TYPES = {
  supplier: 'supplier',
  supplierProduct: 'supplier_product',
  request: 'purchase_request',
  requestLine: 'purchase_request_line',
  rfq: 'rfq',
  rfqInvitation: 'rfq_invitation',
  rfqResponse: 'rfq_response',
  order: 'procurement_order',
  orderLine: 'procurement_order_line',
  receipt: 'goods_receipt',
  receiptLine: 'goods_receipt_line',
  search: 'sourcing_search',
  candidate: 'sourcing_candidate',
} as const;

export const PURCHASES_EVENTS = {
  supplier: {
    created: 'purchases.supplier.created',
    updated: 'purchases.supplier.updated',
    linkedZoho: 'purchases.supplier.linked_zoho',
    productUpserted: 'purchases.supplier.product_upserted',
    evaluated: 'purchases.supplier.evaluated',
    promoted: 'purchases.supplier.promoted',
  },
  request: {
    created: 'purchases.request.created',
    updated: 'purchases.request.updated',
    cancelled: 'purchases.request.cancelled',
    consolidated: 'purchases.request.consolidated',
    consolidationSuggested: 'purchases.request.consolidation_suggested',
  },
  rfq: {
    created: 'purchases.rfq.created',
    sent: 'purchases.rfq.sent',
    responseParsed: 'purchases.rfq.response.parsed',
    responseConfirmed: 'purchases.rfq.response.confirmed',
    responseRejected: 'purchases.rfq.response.rejected',
    responseSelected: 'purchases.rfq.response.selected',
    compared: 'purchases.rfq.compared',
    expired: 'purchases.rfq.expired',
    cancelled: 'purchases.rfq.cancelled',
  },
  order: {
    created: 'purchases.order.created',
    updated: 'purchases.order.updated',
    submitted: 'purchases.order.submitted',
    approved: 'purchases.order.approved',
    rejected: 'purchases.order.rejected',
    paymentRequested: 'purchases.order.payment_requested',
    paid: 'purchases.order.paid',
    sent: 'purchases.order.sent',
    allocated: 'purchases.order.allocated',
    cancelled: 'purchases.order.cancelled',
    closed: 'purchases.order.closed',
    followupFailed: 'purchases.order.followup_failed',
  },
  receipt: {
    created: 'purchases.receipt.created',
    posted: 'purchases.receipt.posted',
    difference: 'purchases.receipt.difference',
    differenceResolved: 'purchases.receipt.difference_resolved',
    directConfirmed: 'purchases.receipt.direct_confirmed',
    directSyncFailed: 'purchases.receipt.direct_sync_failed',
  },
  sourcing: {
    requested: 'purchases.sourcing.search_requested',
    completed: 'purchases.sourcing.search_completed',
    failed: 'purchases.sourcing.search_failed',
    candidateUpdated: 'purchases.sourcing.candidate_updated',
  },
} as const;

export const PURCHASES_COMMANDS = {
  supplierCreate: 'purchases.supplier.create',
  supplierUpdate: 'purchases.supplier.update',
  supplierLinkZoho: 'purchases.supplier.link_zoho',
  supplierProductUpsert: 'purchases.supplier.product_upsert',
  supplierEvaluate: 'purchases.supplier.evaluate',
  candidatePromote: 'purchases.candidate.promote',
  candidateStatus: 'purchases.candidate.set_status',
  requestCreate: 'purchases.request.create',
  requestCancel: 'purchases.request.cancel',
  requestConsolidate: 'purchases.request.consolidate',
  requestSyncShortfall: 'purchases.request.sync_shortfall',
  requestSuggestConsolidation: 'purchases.request.suggest_consolidation',
  rfqCreate: 'purchases.rfq.create',
  rfqInvite: 'purchases.rfq.invite',
  rfqRecordSends: 'purchases.rfq.record_sends',
  rfqReconcileSends: 'purchases.rfq.reconcile_sends',
  rfqRecordInterpretation: 'purchases.rfq.record_interpretation',
  rfqManualResponse: 'purchases.rfq.manual_response',
  rfqConfirmResponse: 'purchases.rfq.confirm_response',
  rfqRejectResponse: 'purchases.rfq.reject_response',
  rfqCompare: 'purchases.rfq.compare',
  rfqSelectResponse: 'purchases.rfq.select_response',
  rfqCancel: 'purchases.rfq.cancel',
  rfqExpire: 'purchases.rfq.expire',
  orderCreate: 'purchases.order.create',
  orderUpdate: 'purchases.order.update',
  orderSubmit: 'purchases.order.submit',
  orderRequestPayment: 'purchases.order.request_payment',
  orderMarkSent: 'purchases.order.mark_sent',
  orderAllocateLine: 'purchases.order.allocate_line',
  orderCancel: 'purchases.order.cancel',
  orderClose: 'purchases.order.close',
  orderFollowupFailed: 'purchases.order.followup_failed',
  receiptRecord: 'purchases.receipt.record',
  receiptPost: 'purchases.receipt.post',
  receiptResolveDifference: 'purchases.receipt.resolve_difference',
  receiptConfirmDirect: 'purchases.receipt.confirm_direct',
  receiptSyncDirect: 'purchases.receipt.sync_direct',
  receiptDirectSyncFailed: 'purchases.receipt.direct_sync_failed',
  sourcingSearch: 'purchases.sourcing.search',
  sourcingRecordResults: 'purchases.sourcing.record_results',
} as const;

export type PurchasesCommandType = (typeof PURCHASES_COMMANDS)[keyof typeof PURCHASES_COMMANDS];

export const PURCHASES_JOB_TYPES = {
  sourcingSearch: 'purchases.sourcing_search',
  rfqInterpret: 'purchases.rfq_interpret',
  consolidateSuggest: 'purchases.consolidate_suggest',
  rfqExpire: 'purchases.rfq_expire',
  /** Area request of a shortfall created/closed → purchase request created/updated. */
  shortfallSync: 'purchases.shortfall_sync',
  /** Direct supplier delivery confirmed by Compras → logistics delivery order recorded. */
  directDeliverySync: 'purchases.direct_delivery_sync',
  /** After an approval: register the payable and, for prepaid orders, ask for the payment. */
  orderFollowup: 'purchases.order_followup',
} as const;

/** Board channel of the purchases area (realtime; authorized with `purchases.view`). */
export const PURCHASES_BOARD_CHANNEL = 'purchases:board';
export const PURCHASES_REALTIME_TYPE = 'purchases.changed';

/**
 * Conversation tag that marks an RFQ thread: `rfq:{rfqId}`.
 *
 * ÚNICO CONTRATO entre Compras (que ETIQUETA la conversación al invitar al
 * proveedor, `tagRfqConversation` en rfq-service.ts) y el fan-out de mensajería
 * (que LEE la etiqueta para decidir si interpreta la respuesta,
 * `runMessageFanout` en comms-jobs.ts). Este módulo es puro (sin Prisma, sin
 * registro de permisos), así que mensajería lo importa directamente en vez de
 * copiar el literal: una copia divergente rompería la interpretación de las
 * cotizaciones entrantes EN SILENCIO (`rfq: 'not_tagged'`, sin error ni
 * reintento). Escribe y lee siempre con los ayudantes de abajo.
 */
export const RFQ_CONVERSATION_TAG_PREFIX = 'rfq:';

/** Etiqueta que Compras escribe en la conversación de una invitación. */
export function rfqConversationTag(rfqId: string): string {
  return `${RFQ_CONVERSATION_TAG_PREFIX}${rfqId}`;
}

/** True si la conversación es un hilo de RFQ (el fan-out interpreta sus mensajes entrantes). */
export function isRfqConversationTagged(tags: readonly string[]): boolean {
  return tags.some((tag) => tag.startsWith(RFQ_CONVERSATION_TAG_PREFIX));
}

/** Ids de las RFQ a las que pertenece la conversación (inverso de `rfqConversationTag`). */
export function rfqIdsFromConversationTags(tags: readonly string[]): string[] {
  return tags
    .filter((tag) => tag.startsWith(RFQ_CONVERSATION_TAG_PREFIX))
    .map((tag) => tag.slice(RFQ_CONVERSATION_TAG_PREFIX.length))
    .filter(Boolean);
}

/** Conversation tag that marks the thread where an order was sent: `oc:{orderId}`. */
export const ORDER_CONVERSATION_TAG_PREFIX = 'oc:';

export const PURCHASES_SEQUENCES = {
  supplier: { key: 'purchases.supplier', prefix: 'PRV' },
  request: { key: 'purchases.request', prefix: 'SC' },
  rfq: { key: 'purchases.rfq', prefix: 'RFQ' },
  order: { key: 'purchases.order', prefix: 'OC' },
  receipt: { key: 'purchases.receipt', prefix: 'RC' },
} as const;

export function labelOf<T extends string>(labels: Record<T, string>, value: string): string {
  return (labels as Record<string, string>)[value] ?? value;
}

/**
 * Constants of the Sales / CRM module (plan 6.5). Pure module: no Prisma, no
 * services, so rules, DTOs, tools and the UI can import it freely.
 */

/** Operational area that owns CRM work items, incidents and events. */
export const CRM_AREA_KEY = 'ventas' as const;

/** Actor id of system commands issued by CRM jobs. */
export const CRM_SYSTEM_ACTOR_ID = 'system:crm';

/** Realtime channel of the radar (authorized with `crm.radar`). */
export const CRM_RADAR_CHANNEL = 'crm:radar';

/** Sequence key and prefix of the human folio (OPP-000123). */
export const OPPORTUNITY_SEQUENCE_KEY = 'opportunity';
export const OPPORTUNITY_NUMBER_PREFIX = 'OPP';

export const CRM_OBJECT_TYPES = {
  opportunity: 'opportunity',
  radarSignal: 'radar_signal',
  pipelineStage: 'pipeline_stage',
  salesOrderWrite: 'sales_order_write_request',
} as const;

export const CRM_COMMANDS = {
  stageCreate: 'crm.stage.create',
  stageUpdate: 'crm.stage.update',
  stageReorder: 'crm.stage.reorder',
  opportunityCreate: 'crm.opportunity.create',
  opportunityCreateFromConversation: 'crm.opportunity.create_from_conversation',
  opportunityUpdate: 'crm.opportunity.update',
  opportunityMoveStage: 'crm.opportunity.move_stage',
  opportunityLinkQuote: 'crm.opportunity.link_quote',
  opportunityLinkSalesOrder: 'crm.opportunity.link_sales_order',
  opportunityLinkCase: 'crm.opportunity.link_case',
  opportunityRecordActivity: 'crm.opportunity.record_activity',
  opportunityMarkWon: 'crm.opportunity.mark_won',
  opportunityMarkLost: 'crm.opportunity.mark_lost',
  opportunityMarkDormant: 'crm.opportunity.mark_dormant',
  conversationTouch: 'crm.conversation.touch',
  quoteChanged: 'crm.quote.changed',
  radarSnooze: 'crm.radar.snooze',
  radarDismiss: 'crm.radar.dismiss',
  radarConvertToTask: 'crm.radar.convert_to_task',
  radarSetExplanation: 'crm.radar.set_explanation',
  salesOrderReadbackMismatch: 'crm.sales_order.readback_mismatch',
} as const;

export const CRM_EVENTS = {
  stageCreated: 'crm.stage.created',
  stageUpdated: 'crm.stage.updated',
  stagesReordered: 'crm.stage.reordered',
  opportunityCreated: 'crm.opportunity.created',
  opportunityUpdated: 'crm.opportunity.updated',
  opportunityStageChanged: 'crm.opportunity.stage_changed',
  opportunityWon: 'crm.opportunity.won',
  opportunityLost: 'crm.opportunity.lost',
  opportunityDormant: 'crm.opportunity.dormant',
  opportunityReactivated: 'crm.opportunity.reactivated',
  quoteLinked: 'crm.opportunity.quote_linked',
  salesOrderLinked: 'crm.opportunity.sales_order_linked',
  caseLinked: 'crm.opportunity.case_linked',
  activityRecorded: 'crm.activity.recorded',
  radarSnoozed: 'crm.radar.snoozed',
  radarDismissed: 'crm.radar.dismissed',
  radarConverted: 'crm.radar.converted_to_task',
  radarExplained: 'crm.radar.explained',
  salesOrderCreated: 'crm.sales_order.created',
  salesOrderReadbackMismatch: 'crm.sales_order.readback_mismatch',
} as const;

export const CRM_JOB_TYPES = {
  conversationTouch: 'crm.conversation_touch',
  quoteChanged: 'crm.quote_changed',
  salesOrderReadback: 'crm.sales_order_readback',
  radarRefresh: 'crm.radar_refresh',
  radarExplain: 'crm.radar_explain',
  linkCases: 'crm.link_cases',
} as const;

/** Delay before re-linking the cases of an order created from UNIK (after `case.start` had time to commit). */
export const CRM_LINK_CASES_DELAY_MS = 30_000;

export const CRM_RADAR_REFRESH_EVERY_MS = 15 * 60_000;
export const CRM_RADAR_EXPLAIN_EVERY_MS = 24 * 60 * 60_000;
export const CRM_QUOTE_CHANGES_EVERY_MS = 5 * 60_000;
/** Delay of the read-back of a sales order created from UNIK. */
export const CRM_SALES_ORDER_READBACK_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export const STAGE_KINDS = ['open', 'won', 'lost'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const STAGE_KIND_LABELS: Record<StageKind, string> = {
  open: 'Abierta',
  won: 'Ganada',
  lost: 'Perdida',
};

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export const OPPORTUNITY_STATUSES = ['open', 'won', 'lost', 'dormant'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const OPPORTUNITY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  open: 'Abierta',
  won: 'Ganada',
  lost: 'Perdida',
  dormant: 'Dormida',
};

export const OPPORTUNITY_SOURCES = ['inbox', 'call', 'manual', 'quote', 'web'] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

export const OPPORTUNITY_SOURCE_LABELS: Record<OpportunitySource, string> = {
  inbox: 'Bandeja',
  call: 'Llamada',
  manual: 'Manual',
  quote: 'Cotización',
  web: 'Web',
};

export const ACTIVITY_KINDS = [
  'note',
  'message_in',
  'message_out',
  'call',
  'quote_sent',
  'quote_viewed',
  'quote_accepted',
  'quote_declined',
  'stage_change',
  'order_created',
  'task',
  'objection',
  'objection_resolved',
  'ai_suggestion',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Kinds a person records by hand (the rest come from messages, quotes, orders and stages). */
export const MANUAL_ACTIVITY_KINDS = [
  'note',
  'call',
  'task',
  'objection',
  'objection_resolved',
] as const satisfies readonly ActivityKind[];
export type ManualActivityKind = (typeof MANUAL_ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  note: 'Nota',
  message_in: 'Mensaje del cliente',
  message_out: 'Mensaje enviado',
  call: 'Llamada',
  quote_sent: 'Cotización enviada',
  quote_viewed: 'Cotización vista',
  quote_accepted: 'Cotización aceptada',
  quote_declined: 'Cotización rechazada',
  stage_change: 'Cambio de etapa',
  order_created: 'Orden de venta creada',
  task: 'Tarea',
  objection: 'Objeción',
  objection_resolved: 'Objeción resuelta',
  ai_suggestion: 'Sugerencia de la IA',
};

/** Reference types stored in `OpportunityActivity.refType`. */
export const ACTIVITY_REF_TYPES = {
  message: 'comm_message',
  conversation: 'comm_conversation',
  voiceCall: 'voice_call',
  quote: 'quote',
  salesOrder: 'sales_order',
  case: 'operational_case',
  workItem: 'work_item',
  activity: 'opportunity_activity',
  changeEvent: 'entity_change_event',
  stage: 'pipeline_stage',
  radarSignal: 'radar_signal',
} as const;

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

export const RADAR_KINDS = [
  'no_first_reply',
  'no_followup',
  'quote_expiring',
  'next_action_overdue',
  'objection_open',
  'high_intent',
  'repurchase_overdue',
  'delivery_incident',
] as const;
export type RadarKind = (typeof RADAR_KINDS)[number];

export const RADAR_KIND_LABELS: Record<RadarKind, string> = {
  no_first_reply: 'Sin primera respuesta',
  no_followup: 'Sin seguimiento',
  quote_expiring: 'Cotización por vencer',
  next_action_overdue: 'Siguiente acción vencida',
  objection_open: 'Objeción sin resolver',
  high_intent: 'Alta intención sin cotización',
  repurchase_overdue: 'Recompra atrasada',
  delivery_incident: 'Incidencia en entrega',
};

export const RADAR_STATUSES = ['active', 'snoozed', 'dismissed', 'resolved'] as const;
export type RadarStatus = (typeof RADAR_STATUSES)[number];

export const RADAR_STATUS_LABELS: Record<RadarStatus, string> = {
  active: 'Activa',
  snoozed: 'Pospuesta',
  dismissed: 'Descartada',
  resolved: 'Resuelta',
};

export function isRadarKind(value: unknown): value is RadarKind {
  return typeof value === 'string' && (RADAR_KINDS as readonly string[]).includes(value);
}

export function isOpportunityStatus(value: unknown): value is OpportunityStatus {
  return typeof value === 'string' && (OPPORTUNITY_STATUSES as readonly string[]).includes(value);
}

import { AREA_KEYS, isAreaKey, type AreaKey } from '@/modules/operations/types';

/**
 * Tools a background agent turn may offer to the model, per identity.
 *
 * An agent turn (`runAssistant` with `context.agent`) only sees the
 * intersection of the tools available to its bot actor and this list, so a
 * coordinator never receives the ~150 tools of the general assistant: a short,
 * stable list keeps the prompt small (≈15–20 schemas) and the prefix cacheable.
 *
 * Keys: the seven area coordinators (`AREA_KEYS`) plus the company-wide
 * administrator identity (`admin`). An empty list means the identity has no
 * tools yet (the turn still runs but can only answer in text).
 */
export type AgentAllowlistKey = AreaKey | 'admin';

/** Every coordinator: read its cases and area, talk to other areas, keep its own work moving. */
const COORDINATOR_CORE = [
  'getCaseSnapshot',
  'explainCase',
  'listAreaWorkItems',
  'findResponsible',
  'summarizeAreaDay',
  'createAreaRequest',
  'acknowledgeAreaRequest',
  'respondAreaRequest',
  'openIncident',
  'escalateCase',
  'assignWorkItem',
  'postCaseNote',
  'completeWorkItem',
] as const;

/** Output contract of background turns (only offered in agent turns). */
const RUNNER_CONTRACT = ['concludeAgentTurn'] as const;

/** Company-wide administrator: every case and area, Control Tower readings; never escalates to itself. */
const ADMIN_TOOLS = [
  'getCaseSnapshot',
  'explainCase',
  'listAreaWorkItems',
  'findResponsible',
  'summarizeAreaDay',
  'proposeDeliveryPlan',
  'createAreaRequest',
  'acknowledgeAreaRequest',
  'respondAreaRequest',
  'openIncident',
  'assignWorkItem',
  'postCaseNote',
  'getCompanyPulse',
  'findStuckCases',
  'whoIsBlocking',
  'simulateDelay',
  ...RUNNER_CONTRACT,
] as const;

/**
 * Domain tools of each area (plan 6.6), kept short on purpose: no identity
 * offers more than 20 schemas per turn (prompt size and prefix cache), so each
 * area gets the few tools that actually move its work — the rest of its module
 * stays in the UI and in the assistant of the person.
 *
 * Names are literals: this module is pure and never imports the tool files
 * (importing one registers every tool of that module as a side effect).
 */
/** Ventas: the closing radar loop (see, understand, draft the message for the person). */
const CRM_TOOLS = [
  'listOpportunities',
  'listRadarSignals',
  'explainRadarSignal',
  'draftRadarMessage',
] as const;

/** Compras: the requests it must cover and the RFQ → order path (receipts are a physical fact of a person). */
const PROCUREMENT_TOOLS = [
  'listPurchaseRequests',
  'draftRfq',
  'compareRfq',
  'submitProcurementOrder',
] as const;

const MANUFACTURING_TOOLS = [
  'listProductionOrders',
  'getProductionBoard',
  'createTransformationOrderDraft',
  'recordProductionOutput',
  'reportScrap',
] as const;

/** Logística: see the day's board, put the load on a truck and close what was really delivered. */
const LOGISTICS_TOOLS = ['getDispatchBoard', 'buildTrip', 'recordDeliveryResult'] as const;

/** Contabilidad: cash readings and collections (capturing an expense is `recordExpense`). */
const FINANCE_TOOLS = [
  'getCashflowProjection',
  'listUnmatchedPayments',
  'matchPaymentToObligation',
  'getCashBook',
] as const;

/**
 * Stable order (prefix cache). Tools the bot's permissions do not cover are
 * dropped by the registry before reaching the model, so an area whose module
 * permissions do not exist yet simply sees fewer tools.
 */
export const AGENT_TOOL_ALLOWLIST: Readonly<Record<AgentAllowlistKey, readonly string[]>> = {
  ventas: [
    ...COORDINATOR_CORE,
    'proposeDeliveryPlan',
    'requestStockVerification',
    ...CRM_TOOLS,
    ...RUNNER_CONTRACT,
  ],
  compras: [
    ...COORDINATOR_CORE,
    'researchSourcing',
    'recordExpense',
    ...PROCUREMENT_TOOLS,
    ...RUNNER_CONTRACT,
  ],
  inventario: [
    ...COORDINATOR_CORE,
    'proposeDeliveryPlan',
    'requestStockVerification',
    'reserveStock',
    'createPurchaseRequest',
    'createProductionOrder',
    ...RUNNER_CONTRACT,
  ],
  manufactura: [...COORDINATOR_CORE, 'recordExpense', ...MANUFACTURING_TOOLS, ...RUNNER_CONTRACT],
  logistica: [
    ...COORDINATOR_CORE,
    'proposeDeliveryPlan',
    'assignCarrier',
    'recordExpense',
    ...LOGISTICS_TOOLS,
    ...RUNNER_CONTRACT,
  ],
  contabilidad: [
    ...COORDINATOR_CORE,
    'recordExpense',
    'authorizePayment',
    ...FINANCE_TOOLS,
    ...RUNNER_CONTRACT,
  ],
  administracion: [...ADMIN_TOOLS],
  admin: [...ADMIN_TOOLS],
};

export const AGENT_ALLOWLIST_KEYS: readonly AgentAllowlistKey[] = [...AREA_KEYS, 'admin'];

/**
 * Allowlist of one agent identity. `null`/empty/`'admin'` resolve to the
 * administrator identity; an unknown area key resolves to no tools at all
 * (fail closed).
 */
export function agentToolAllowlistFor(areaKey: string | null | undefined): readonly string[] {
  if (!areaKey || areaKey === 'admin') return AGENT_TOOL_ALLOWLIST.admin;
  return isAreaKey(areaKey) ? AGENT_TOOL_ALLOWLIST[areaKey] : [];
}

import type {
  AllocationSource,
  AreaKey,
  CasePhase,
  EscalationRung,
  StepKind,
  StepScope,
} from '../types';
import type { ConditionKey } from './conditions';

/**
 * Versioned process blueprints (plan section 2.3).
 *
 * A blueprint is plain, serializable data: it is stored as JSON in
 * `ProcessVersion.definition` (with its checksum) the first time it is used,
 * and every case keeps the version it was instantiated with. Conditions are
 * referenced by key (`conditions.ts`), never as functions, so a stored
 * definition can be re-evaluated by any later build of the code.
 *
 * Pure module (types only).
 */

/** Result key or evidence kind a step needs to close (e.g. `availability_result`, `photo`). */
export type EvidenceKey = string;

/** Who owns the work of a step. */
export type OwnerResolution =
  | {
      area: AreaKey;
      /** Prefer the responsible of `{area}_{warehouseKey}` of the demand's warehouse. */
      byLocation?: boolean;
    }
  | { role: 'case_owner' };

/** Date the SLA is counted from instead of "when the step became ready". */
export type SlaAnchor = 'expectedAt' | 'plannedDate';

export interface StepEscalation {
  afterMinutes: number[];
  ladder: EscalationRung[];
}

/** Steps the engine executes by itself (no human work item unless it fails). */
export type EngineAction =
  | 'reserve_stock'
  | 'request_purchase'
  | 'request_production'
  | 'request_direct_delivery'
  | 'plan_delivery';

/** Hint for the UI of the work item (what screen or command closes it). */
export type StepUiAction =
  | 'count_stock'
  | 'plan_allocations'
  | 'reserve_stock'
  | 'prepare_order'
  | 'assign_transport'
  | 'record_delivery'
  | 'close_case';

/**
 * How a human may close the work item of a step:
 * - `manual`: completing the work item (with its required evidence) closes the step.
 * - `condition`: the step closes only when its `autoComplete` condition holds
 *   (engine steps and steps closed by other modules, e.g. a confirmed shipment).
 */
export type StepCompletion = 'manual' | 'condition';

export interface StepDef {
  /** Stable key (`verificar_disponibilidad`); unique inside the blueprint. */
  key: string;
  /** Spanish label used in work items and timelines. */
  label: string;
  areaKey: AreaKey;
  kind: StepKind;
  scope: StepScope;
  /** Allocation-scoped steps only exist for these sources. */
  appliesTo?: AllocationSource[];
  /** Keys of steps that must be done or skipped first (resolved per scope by `instantiate.ts`). */
  dependsOn: string[];
  /** Evaluated when dependencies are satisfied; false ⇒ the step is skipped. */
  entryCondition?: ConditionKey;
  exit: {
    evidence: EvidenceKey[];
    eventType: string;
    /** Other facts that also close the step (e.g. `delivery.partial`). */
    alternateEventTypes?: string[];
  };
  /** SLA in minutes (counted from `slaAnchor` when present). */
  slaMinutes: number;
  slaAnchor?: SlaAnchor;
  /** SLA used when the anchor date is unknown. */
  slaFallbackMinutes?: number;
  ownerResolution: OwnerResolution;
  escalation: StepEscalation;
  /** Closes the step as soon as the condition holds. */
  autoComplete?: ConditionKey;
  engine?: EngineAction;
  completion: StepCompletion;
  uiAction?: StepUiAction;
  /** Phase of the case while this step is in progress. */
  phase: CasePhase;
}

export interface ProcessBlueprint {
  processKey: string;
  /** Blueprint version (not a concurrency counter). */
  version: number;
  label: string;
  steps: StepDef[];
}

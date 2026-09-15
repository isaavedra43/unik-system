/**
 * Domain errors of the operations core. Every service of the operational
 * modules (inventory, logistics, purchases, manufacturing, finance, CRM)
 * throws `OperationsError` for expected business rejections: the command
 * engine turns them into a `rejected` CommandResult with the same `code`, and
 * routes map `httpStatus` to the response. `code` is stable (clients and tests
 * rely on it); `message` is Spanish and safe to show to the user.
 */

export const OPERATIONS_ERROR_CODES = [
  'invalid_payload',
  'unknown_command',
  'unauthenticated',
  'forbidden',
  'actor_mismatch',
  'not_found',
  'version_conflict',
  'concurrency_conflict',
  'command_id_conflict',
  'invalid_request',
  'invalid_config',
  'config_conflict',
  'no_responsible',
  'no_approvers',
  'approval_closed',
  'approval_expired',
  'already_voted',
  'self_approval',
  'not_eligible',
  'outside_command',
  'invalid_state',
  'missing_evidence',
  // Case engine
  'case_not_eligible',
  'step_condition_pending',
  'process_version_mismatch',
  'process_version_corrupt',
  'invalid_blueprint',
  'plan_quantity_mismatch',
  'plan_stock_exceeded',
  'stock_not_promisable',
  // Inventory (inventory-types.ts)
  'insufficient_stock',
  'stock_uncounted',
  'stock_disputed',
  'provisional_not_allowed',
  'provisional_verification_stale',
  'provisional_requires_human',
  'invalid_quantity',
  'invalid_unit',
  'invalid_variant',
  'duplicate',
  'module_disabled',
  'empty_count',
  'legacy_claim_expired',
  'negative_stock',
  'demand_over_reserved',
  // Logistics (logistics-helpers.ts)
  'package_missing',
  'allocation_in_delivery',
  'evidence_required',
  'evidence_invalid',
  'nothing_delivered',
  'capacity_exceeded',
  'fleet_unavailable',
  'duplicate_code',
  'driver_user_taken',
  'in_use',
  'stops_pending',
] as const;

export type OperationsErrorCode = (typeof OPERATIONS_ERROR_CODES)[number];

/** HTTP status used when a code is thrown without an explicit status. */
export const OPERATIONS_ERROR_HTTP_STATUS: Record<OperationsErrorCode, number> = {
  invalid_payload: 422,
  unknown_command: 400,
  unauthenticated: 401,
  forbidden: 403,
  actor_mismatch: 403,
  not_found: 404,
  version_conflict: 409,
  concurrency_conflict: 409,
  command_id_conflict: 409,
  invalid_request: 422,
  invalid_config: 422,
  config_conflict: 409,
  no_responsible: 409,
  no_approvers: 409,
  approval_closed: 409,
  approval_expired: 409,
  already_voted: 409,
  self_approval: 403,
  not_eligible: 403,
  outside_command: 500,
  invalid_state: 409,
  missing_evidence: 422,
  case_not_eligible: 409,
  step_condition_pending: 409,
  process_version_mismatch: 409,
  process_version_corrupt: 500,
  invalid_blueprint: 500,
  plan_quantity_mismatch: 409,
  plan_stock_exceeded: 409,
  stock_not_promisable: 409,
  insufficient_stock: 409,
  stock_uncounted: 409,
  stock_disputed: 409,
  provisional_not_allowed: 409,
  provisional_verification_stale: 409,
  provisional_requires_human: 403,
  invalid_quantity: 422,
  invalid_unit: 422,
  invalid_variant: 422,
  duplicate: 409,
  module_disabled: 409,
  empty_count: 409,
  legacy_claim_expired: 409,
  negative_stock: 409,
  demand_over_reserved: 409,
  package_missing: 409,
  allocation_in_delivery: 409,
  evidence_required: 422,
  evidence_invalid: 422,
  nothing_delivered: 422,
  capacity_exceeded: 422,
  fleet_unavailable: 409,
  duplicate_code: 409,
  driver_user_taken: 409,
  in_use: 409,
  stops_pending: 409,
};

export class OperationsError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OperationsErrorCode | (string & {}),
    message: string,
    options: { httpStatus?: number; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = 'OperationsError';
    this.code = code;
    this.httpStatus =
      options.httpStatus ?? (OPERATIONS_ERROR_HTTP_STATUS as Record<string, number>)[code] ?? 400;
    this.details = options.details;
  }
}

export function isOperationsError(err: unknown): err is OperationsError {
  return err instanceof OperationsError;
}

/** HTTP status for a rejection code (unknown codes → 400). */
export function httpStatusForCode(code: string | undefined): number {
  if (!code) return 200;
  return (OPERATIONS_ERROR_HTTP_STATUS as Record<string, number>)[code] ?? 400;
}

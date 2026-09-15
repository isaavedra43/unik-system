/**
 * Start policy of a sales fulfillment case (plan section 2.4). Pure module.
 *
 * An order starts a case on its own when:
 * - the operations core is enabled and the `salesToCase` flag is on;
 * - its status is not draft, void, closed or cancelled;
 * - its shipped status is not fulfilled nor delivered;
 * - it was created in Zoho at or after `cutoverDate` (created time, falling
 *   back to the order date);
 * - with `pilotLocationIds`, its Zoho location is one of them.
 *
 * The manual override ("Iniciar seguimiento", `operations.manage`) skips the
 * flag, the cutover and the pilot filter, but never the status filters nor the
 * kill switch of the core.
 */

export const START_EXCLUDED_ORDER_STATUSES = ['draft', 'void', 'closed', 'cancelled'] as const;
export const CANCELLED_ORDER_STATUSES = ['void', 'cancelled'] as const;
export const START_EXCLUDED_SHIPPED_STATUSES = ['fulfilled', 'delivered'] as const;

export interface StartPolicyOrder {
  status: string | null;
  shippedStatus: string | null;
  createdTime: Date | null;
  orderDate: Date | null;
  locationId: string | null;
}

export interface StartPolicyConfig {
  isEnabled: boolean;
  flags: { salesToCase: boolean };
  cutoverDate: string;
  pilotLocationIds: readonly string[];
}

export type StartPolicyReason =
  | 'core_disabled'
  | 'flag_disabled'
  | 'status_excluded'
  | 'already_fulfilled'
  | 'missing_date'
  | 'invalid_cutover'
  | 'before_cutover'
  | 'location_not_in_pilot';

export type StartPolicyDecision =
  | { eligible: true; basis: 'created_time' | 'order_date' | 'manual' }
  | { eligible: false; reason: StartPolicyReason; message: string };

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function isCancelledOrderStatus(status: string | null | undefined): boolean {
  return (CANCELLED_ORDER_STATUSES as readonly string[]).includes(normalized(status));
}

/** Date the cutover is compared with: Zoho created time, else the order date. */
export function orderReferenceDate(
  order: Pick<StartPolicyOrder, 'createdTime' | 'orderDate'>
): { date: Date; basis: 'created_time' | 'order_date' } | null {
  if (order.createdTime && !Number.isNaN(order.createdTime.getTime())) {
    return { date: order.createdTime, basis: 'created_time' };
  }
  if (order.orderDate && !Number.isNaN(order.orderDate.getTime())) {
    return { date: order.orderDate, basis: 'order_date' };
  }
  return null;
}

const refuse = (reason: StartPolicyReason, message: string): StartPolicyDecision => ({
  eligible: false,
  reason,
  message,
});

export function evaluateStartPolicy(
  order: StartPolicyOrder,
  config: StartPolicyConfig,
  options: { manual?: boolean } = {}
): StartPolicyDecision {
  if (!config.isEnabled) {
    return refuse('core_disabled', 'El núcleo de operaciones está desactivado');
  }
  const status = normalized(order.status);
  if ((START_EXCLUDED_ORDER_STATUSES as readonly string[]).includes(status)) {
    return refuse(
      'status_excluded',
      `La orden está en estado "${order.status}" y no se le da seguimiento operativo`
    );
  }
  if (
    (START_EXCLUDED_SHIPPED_STATUSES as readonly string[]).includes(normalized(order.shippedStatus))
  ) {
    return refuse('already_fulfilled', 'La orden ya aparece entregada en Zoho');
  }
  if (options.manual) return { eligible: true, basis: 'manual' };

  if (!config.flags.salesToCase) {
    return refuse('flag_disabled', 'El arranque automático de expedientes está desactivado');
  }
  const reference = orderReferenceDate(order);
  if (!reference) {
    return refuse('missing_date', 'La orden no tiene fecha de creación ni fecha de orden');
  }
  const cutover = new Date(config.cutoverDate);
  if (Number.isNaN(cutover.getTime())) {
    return refuse('invalid_cutover', 'La fecha de corte de operaciones es inválida');
  }
  if (reference.date.getTime() < cutover.getTime()) {
    return refuse(
      'before_cutover',
      'La orden es anterior a la fecha de corte; usa «Iniciar seguimiento» para darle seguimiento'
    );
  }
  if (config.pilotLocationIds.length > 0) {
    const location = order.locationId?.trim() ?? '';
    if (!location || !config.pilotLocationIds.includes(location)) {
      return refuse(
        'location_not_in_pilot',
        'La ubicación de la orden no está en el piloto de operaciones'
      );
    }
  }
  return { eligible: true, basis: reference.basis };
}

/**
 * Pure helpers for the vendor profile (detail page, preview drawer, transactions API).
 */

export type VendorTransactionType = 'purchase_orders' | 'bills' | 'vendor_credits';

export const VENDOR_TRANSACTION_TYPES: VendorTransactionType[] = ['purchase_orders', 'bills', 'vendor_credits'];

export function parseVendorTransactionType(value: string | null | undefined): VendorTransactionType | null {
  return VENDOR_TRANSACTION_TYPES.includes(value as VendorTransactionType) ? (value as VendorTransactionType) : null;
}

/** Purchase orders still in progress (not fully received/billed, not closed or cancelled). */
export const PURCHASE_ORDER_OPEN_STATUSES = ['open', 'issued', 'partially_received', 'partially_billed', 'pending_approval'];

/** Never counted in amounts or pending balances. */
export const NON_COUNTABLE_STATUSES = ['draft', 'cancelled', 'void'];

export const DEFAULT_TRANSACTIONS_PAGE_SIZE = 25;

export function parsePageParams(page: string | null | undefined, pageSize: string | null | undefined): { page: number; pageSize: number } {
  const p = Number.parseInt(page ?? '', 10);
  const s = Number.parseInt(pageSize ?? '', 10);
  return {
    page: Number.isFinite(p) && p > 0 ? p : 1,
    pageSize: Number.isFinite(s) ? Math.min(100, Math.max(10, s)) : DEFAULT_TRANSACTIONS_PAGE_SIZE,
  };
}

/**
 * Difference between the balance Zoho reports on the contact and the one computed from the synced
 * documents. Null when they agree within `tolerance` or either side is unknown.
 */
export function balanceGap(reported: string | null | undefined, computed: string | null | undefined, tolerance = 1): number | null {
  if (reported === null || reported === undefined || computed === null || computed === undefined) return null;
  const a = Number(reported);
  const b = Number(computed);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = Math.round((a - b) * 100) / 100;
  return Math.abs(diff) > tolerance ? diff : null;
}

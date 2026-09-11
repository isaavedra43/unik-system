import {
  anyTextMatches,
  matchesDeliveryMethod,
  matchesDeliveryType,
  matchesLocation,
  matchesStatus,
  statusLabel,
  textEquals,
  textMatches,
  toAmount,
  type DeliveryType,
} from './ai-filter-matching';

export interface SalesOrderFilterArgs {
  paymentMethods?: string[];
  deliveryMethod?: string;
  deliveryType?: DeliveryType;
  shippingLocation?: string;
  customer?: string;
  salesperson?: string;
  status?: string;
  subStatus?: string;
  paidStatus?: string;
  invoicedStatus?: string;
  shippedStatus?: string;
  location?: string;
  product?: string;
  minTotal?: number;
  maxTotal?: number;
  hasBalance?: boolean;
  saleMadeInWarehouse?: boolean;
  search?: string;
}

export interface FilterableSalesOrder {
  salesOrderNumber?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  salespersonName?: string | null;
  status?: string | null;
  subStatus?: string | null;
  paidStatus?: string | null;
  invoicedStatus?: string | null;
  shippedStatus?: string | null;
  paymentMethod?: string | null;
  deliveryMethod?: string | null;
  locationName?: string | null;
  referenceNumber?: string | null;
  shippingAttention?: string | null;
  shippingAddressLine1?: string | null;
  shippingAddressLine2?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingPostalCode?: string | null;
  notes?: string | null;
  total?: unknown;
  balance?: unknown;
  saleMadeInWarehouse?: boolean | null;
  items?: Array<{ name?: string | null; sku?: string | null; description?: string | null }>;
}

type FilterKey = keyof SalesOrderFilterArgs;

const BALANCE_EPSILON = 0.009;

const FILTER_PREDICATES: Record<FilterKey, (o: FilterableSalesOrder, a: SalesOrderFilterArgs) => boolean> = {
  paymentMethods: (o, a) =>
    !a.paymentMethods || a.paymentMethods.length === 0 || a.paymentMethods.some((m) => textEquals(o.paymentMethod, m)),
  deliveryMethod: (o, a) => matchesDeliveryMethod(o.deliveryMethod, a.deliveryMethod),
  deliveryType: (o, a) => matchesDeliveryType(o.deliveryMethod, a.deliveryType),
  shippingLocation: (o, a) =>
    matchesLocation(
      [o.shippingAddressLine1, o.shippingAddressLine2, o.shippingCity, o.shippingState, o.shippingPostalCode, o.shippingAttention],
      a.shippingLocation
    ),
  customer: (o, a) => textMatches(o.customerName, a.customer),
  salesperson: (o, a) => textMatches(o.salespersonName, a.salesperson),
  status: (o, a) => matchesStatus('salesOrder', o.status, a.status),
  subStatus: (o, a) => textMatches(o.subStatus, a.subStatus),
  paidStatus: (o, a) => matchesStatus('salesPaid', o.paidStatus, a.paidStatus),
  invoicedStatus: (o, a) => matchesStatus('salesInvoiced', o.invoicedStatus, a.invoicedStatus),
  shippedStatus: (o, a) => matchesStatus('salesShipped', o.shippedStatus, a.shippedStatus),
  location: (o, a) => textMatches(o.locationName, a.location),
  product: (o, a) =>
    !a.product || (o.items ?? []).some((item) => anyTextMatches([item.name, item.sku, item.description], a.product)),
  minTotal: (o, a) => a.minTotal === undefined || toAmount(o.total) >= a.minTotal,
  maxTotal: (o, a) => a.maxTotal === undefined || toAmount(o.total) <= a.maxTotal,
  hasBalance: (o, a) => a.hasBalance === undefined || toAmount(o.balance) > BALANCE_EPSILON === a.hasBalance,
  saleMadeInWarehouse: (o, a) =>
    a.saleMadeInWarehouse === undefined || Boolean(o.saleMadeInWarehouse) === a.saleMadeInWarehouse,
  search: (o, a) =>
    anyTextMatches(
      [o.salesOrderNumber, o.customerName, o.referenceNumber, o.shippingAddressLine1, o.shippingAddressLine2, o.shippingCity, o.notes, o.customerPhone],
      a.search
    ),
};

export function activeSalesOrderFilters(args: SalesOrderFilterArgs): FilterKey[] {
  return (Object.keys(FILTER_PREDICATES) as FilterKey[]).filter((k) => {
    const v = args[k];
    if (Array.isArray(v)) return v.length > 0;
    return v !== undefined && v !== null && v !== '';
  });
}

export function applySalesOrderFilters<T extends FilterableSalesOrder>(orders: T[], args: SalesOrderFilterArgs): T[] {
  const active = activeSalesOrderFilters(args);
  if (active.length === 0) return orders;
  return orders.filter((o) => active.every((k) => FILTER_PREDICATES[k](o, args)));
}

/** How many orders satisfy each active filter on its own — tells the model which filter emptied the result. */
export function perFilterMatchCounts(orders: FilterableSalesOrder[], args: SalesOrderFilterArgs): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of activeSalesOrderFilters(args)) {
    counts[k] = orders.filter((o) => FILTER_PREDICATES[k](o, args)).length;
  }
  return counts;
}

function distinct(values: Array<string | null | undefined>, limit = 15): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].slice(0, limit);
}

/** Real values that satisfied fuzzy filters, so the model can explain how it interpreted the question. */
export function interpretSalesOrderMatches(orders: FilterableSalesOrder[], args: SalesOrderFilterArgs): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (args.deliveryMethod || args.deliveryType) out.deliveryMethods = distinct(orders.map((o) => o.deliveryMethod));
  if (args.shippedStatus) out.shippedStatuses = distinct(orders.map((o) => statusLabel('salesShipped', o.shippedStatus)));
  if (args.paidStatus) out.paidStatuses = distinct(orders.map((o) => statusLabel('salesPaid', o.paidStatus)));
  if (args.invoicedStatus) out.invoicedStatuses = distinct(orders.map((o) => statusLabel('salesInvoiced', o.invoicedStatus)));
  if (args.status) out.statuses = distinct(orders.map((o) => statusLabel('salesOrder', o.status)));
  if (args.paymentMethods?.length) out.paymentMethods = distinct(orders.map((o) => o.paymentMethod));
  if (args.customer) out.customers = distinct(orders.map((o) => o.customerName));
  if (args.salesperson) out.salespeople = distinct(orders.map((o) => o.salespersonName));
  if (args.location) out.locations = distinct(orders.map((o) => o.locationName));
  if (args.product) {
    out.products = distinct(
      orders.flatMap((o) => (o.items ?? []).filter((i) => anyTextMatches([i.name, i.sku, i.description], args.product)).map((i) => i.name))
    );
  }
  if (args.shippingLocation) {
    out.shippingCitiesOrAddresses = distinct(
      orders.map((o) => o.shippingCity || o.shippingState || o.shippingAddressLine1?.slice(0, 60))
    );
  }
  return out;
}

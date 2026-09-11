/**
 * Pure business rules behind the audit tools (no database access), so they can be unit tested.
 */
import {
  classifyDeliveryMethod,
  matchesStatus,
  normalizeText,
  statusLabel,
  textEquals,
  toAmount,
} from './ai-filter-matching';
import { formatDate } from './date-helpers';

export type Severity = 'alta' | 'media' | 'baja';

export interface AuditFlag {
  code: string;
  severity: Severity;
  reason: string;
}

const SEVERITY_SCORE: Record<Severity, number> = { alta: 3, media: 2, baja: 1 };
const EPSILON = 0.009;
const MS_PER_DAY = 86_400_000;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatMxn(n: number): string {
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function daysBetween(from: Date | null | undefined, to: Date): number | null {
  if (!from) return null;
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.max(0, Math.floor((b - a) / MS_PER_DAY));
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* Pending deliveries ------------------------------------------------------ */

export interface AuditOrderInput {
  salesOrderNumber?: string | null;
  orderDate?: Date | null;
  status?: string | null;
  paidStatus?: string | null;
  shippedStatus?: string | null;
  paymentMethod?: string | null;
  deliveryMethod?: string | null;
  shippingAddressLine1?: string | null;
  shippingAddressLine2?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  notes?: string | null;
  total?: unknown;
  balance?: unknown;
}

export interface AuditPackageInput {
  packageNumber?: string | null;
  status?: string | null;
}

export interface DeliveryAuditContext {
  today: Date;
  staleDays: number;
  highTotalThreshold: number | null;
  packages: AuditPackageInput[];
}

const LOCATION_REQUEST = /pedir ubicacion|pedir la ubicacion|mandar ubicacion|favor de llamar|llamar para|sin direccion/;
const SCHEDULE_PATTERN =
  /(entrega\s+(programada|el|para)|se\s+entrega|entregar\s+el|programad[oa]\s+para|(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+\d{1,2})[^,;)\n]{0,40}/i;

export function auditPendingDelivery(
  order: AuditOrderInput,
  ctx: DeliveryAuditContext
): { daysOpen: number | null; flags: AuditFlag[]; score: number } {
  const flags: AuditFlag[] = [];
  const days = daysBetween(order.orderDate, ctx.today);
  const total = toAmount(order.total);
  const balance = toAmount(order.balance);
  const kinds = classifyDeliveryMethod(order.deliveryMethod);
  const pickup = kinds.length > 0 && kinds.every((k) => k === 'pickup');
  const address = [order.shippingAddressLine1, order.shippingAddressLine2, order.shippingCity, order.shippingState]
    .filter((p) => p && p.trim())
    .join(', ');
  const context = `${address} ${order.notes ?? ''}`;

  if (matchesStatus('salesOrder', order.status, 'Borrador')) {
    flags.push({ code: 'borrador', severity: 'alta', reason: 'Está en Borrador: no está confirmada, así que no sale a entrega.' });
  }
  if (matchesStatus('salesOrder', order.status, 'Cerrada')) {
    flags.push({ code: 'cerrada_sin_entregar', severity: 'alta', reason: 'La orden está Cerrada pero su entrega sigue pendiente en el sistema.' });
  }

  if (days !== null && days >= ctx.staleDays) {
    const severity: Severity = days >= ctx.staleDays * 3 ? 'alta' : 'media';
    flags.push(
      pickup
        ? { code: 'no_ha_recogido', severity, reason: `El cliente no ha recogido en ${days} días.` }
        : { code: 'atrasada', severity, reason: `Lleva ${days} días sin entregarse.` }
    );
  }

  const paid = matchesStatus('salesPaid', order.paidStatus, 'Pagada');
  if (paid && balance > EPSILON) {
    flags.push({ code: 'pago_incongruente', severity: 'alta', reason: `Marcada como Pagada pero el sistema muestra saldo de ${formatMxn(balance)}.` });
  } else if (paid && days !== null && days >= 3) {
    flags.push({ code: 'pagada_sin_entregar', severity: 'media', reason: `Ya está pagada y lleva ${days} días sin entregarse.` });
  } else if (!paid && balance > EPSILON) {
    flags.push({ code: 'saldo_pendiente', severity: 'media', reason: `Tiene saldo por cobrar de ${formatMxn(balance)}; puede estar detenida esperando el pago.` });
  }

  if (normalizeText(order.paymentMethod).includes('pendiente')) {
    flags.push({ code: 'metodo_pago_pendiente', severity: 'media', reason: `Método de pago "${order.paymentMethod}".` });
  }

  if (!pickup && kinds.length > 0) {
    if (!address) {
      flags.push({ code: 'sin_direccion', severity: 'alta', reason: `Es ${order.deliveryMethod} pero no tiene dirección de entrega.` });
    } else if (LOCATION_REQUEST.test(normalizeText(context))) {
      flags.push({ code: 'pedir_ubicacion', severity: 'media', reason: 'La dirección o notas indican que falta pedir ubicación o llamar al cliente.' });
    }
  }

  const schedule = stripAccents(context).match(SCHEDULE_PATTERN);
  if (schedule) {
    flags.push({ code: 'entrega_programada', severity: 'baja', reason: `Tiene entrega programada: "${schedule[0].trim()}".` });
  }

  if (matchesStatus('salesShipped', order.shippedStatus, 'Parcial')) {
    flags.push({ code: 'entrega_parcial', severity: 'media', reason: 'Entrega parcial: aún faltan productos por entregar.' });
  }

  for (const pkg of ctx.packages) {
    const label = statusLabel('package', pkg.status) ?? 'sin estado';
    if (matchesStatus('package', pkg.status, 'Enviado, Entregado')) {
      flags.push({
        code: 'paquete_enviado_orden_pendiente',
        severity: 'alta',
        reason: `El paquete ${pkg.packageNumber ?? ''} está ${label} pero la orden sigue pendiente de entrega (no se actualizó).`,
      });
    } else {
      flags.push({ code: 'paquete_sin_enviar', severity: 'baja', reason: `Ya tiene paquete ${pkg.packageNumber ?? ''} creado (${label}); falta enviarlo.` });
    }
  }

  if (ctx.highTotalThreshold !== null && total >= ctx.highTotalThreshold) {
    flags.push({ code: 'monto_alto', severity: 'baja', reason: `Monto alto (${formatMxn(total)}) comparado con el resto de pendientes.` });
  }

  return { daysOpen: days, flags, score: flags.reduce((s, f) => s + SEVERITY_SCORE[f.severity], 0) };
}

/* Cash close -------------------------------------------------------------- */

export interface CashOrderInput {
  salesOrderNumber?: string | null;
  customerName?: string | null;
  salespersonName?: string | null;
  paymentMethod?: string | null;
  status?: string | null;
  paidStatus?: string | null;
  total?: unknown;
  balance?: unknown;
  orderDate?: Date | null;
}

export interface CashPaymentInput {
  paymentNumber?: string | null;
  customerName?: string | null;
  paymentMode?: string | null;
  amount?: unknown;
  date?: Date | null;
  referenceNumber?: string | null;
}

export interface CashFlag extends AuditFlag {
  orderNumber?: string | null;
  paymentNumber?: string | null;
  customer?: string | null;
  amount?: number;
}

const NON_CASH_COLLECTION = new Set(['credito', 'nota de credito', 'pendiente de pago', 'sin metodo']);

/** Groups a payment method/mode into a comparable category ("EFECTIVO EN BODEGA" and "Efectivo" → efectivo). */
export function paymentCategory(method: string | null | undefined): string {
  const m = normalizeText(method);
  if (!m) return 'sin metodo';
  const cats = new Set<string>();
  if (m.includes('efectivo') || m.includes('cash')) cats.add('efectivo');
  if (m.includes('transfer') || m.includes('spei')) cats.add('transferencia');
  if (m.includes('tarjeta') || m.includes('card') || m.includes('terminal')) cats.add('tarjeta');
  if (m.includes('deposito')) cats.add('deposito');
  if (m.includes('cheque')) cats.add('cheque');
  if (m.includes('nota de credito')) cats.add('nota de credito');
  else if (m.includes('credito') && !cats.has('tarjeta')) cats.add('credito');
  if (m.includes('pendiente')) cats.add('pendiente de pago');
  if (cats.size === 0) return 'otro';
  if (cats.size > 1) return 'combinado';
  return [...cats][0];
}

export function reconcileCashClose(orders: CashOrderInput[], payments: CashPaymentInput[]) {
  const excluded = orders.filter((o) => matchesStatus('salesOrder', o.status, 'Borrador, Anulada, Cancelada'));
  const valid = orders.filter((o) => !excluded.includes(o));
  const flags: CashFlag[] = [];

  const byMethod = new Map<string, { method: string; category: string; count: number; total: number; collected: number; pending: number; orders: CashOrderInput[] }>();
  const byCategory = new Map<string, { salesTotal: number; collected: number; pending: number; orders: number; payments: number; paymentsCount: number }>();
  const categoryEntry = (category: string) => {
    const e = byCategory.get(category) ?? { salesTotal: 0, collected: 0, pending: 0, orders: 0, payments: 0, paymentsCount: 0 };
    byCategory.set(category, e);
    return e;
  };

  for (const o of valid) {
    const total = toAmount(o.total);
    const balance = Math.max(0, toAmount(o.balance));
    const collected = Math.max(0, total - balance);
    const method = o.paymentMethod?.trim() || 'SIN MÉTODO';
    const category = paymentCategory(o.paymentMethod);
    const m = byMethod.get(method) ?? { method, category, count: 0, total: 0, collected: 0, pending: 0, orders: [] };
    m.count++;
    m.total += total;
    m.collected += collected;
    m.pending += balance;
    m.orders.push(o);
    byMethod.set(method, m);
    const c = categoryEntry(category);
    c.salesTotal += total;
    c.collected += collected;
    c.pending += balance;
    c.orders++;

    const base = { orderNumber: o.salesOrderNumber, customer: o.customerName };
    if (matchesStatus('salesPaid', o.paidStatus, 'Pagada') && balance > EPSILON) {
      flags.push({ ...base, code: 'pagada_con_saldo', severity: 'alta', amount: round2(balance), reason: `Marcada como Pagada pero con saldo de ${formatMxn(balance)} en el sistema.` });
    } else if (category === 'efectivo' && balance > EPSILON) {
      flags.push({ ...base, code: 'efectivo_con_saldo', severity: 'media', amount: round2(balance), reason: `Registrada en efectivo pero con ${formatMxn(balance)} sin cobrar.` });
    }
    if (matchesStatus('salesPaid', o.paidStatus, 'sin pagar') && balance <= EPSILON && total > EPSILON) {
      flags.push({ ...base, code: 'saldo_cero_no_pagada', severity: 'media', amount: round2(total), reason: 'Saldo en $0 pero marcada como no pagada.' });
    }
    if (category === 'combinado') {
      flags.push({ ...base, code: 'pago_combinado', severity: 'baja', amount: round2(collected), reason: `Pago combinado (${o.paymentMethod}): confirmar cuánto fue de cada método.` });
    }
    if (category === 'pendiente de pago' || category === 'sin metodo') {
      flags.push({ ...base, code: 'sin_metodo_pago', severity: 'media', amount: round2(total), reason: `Método de pago "${o.paymentMethod ?? 'vacío'}".` });
    }
  }

  const duplicates = new Map<string, CashOrderInput[]>();
  for (const o of valid) {
    const total = toAmount(o.total);
    if (total <= EPSILON) continue;
    const key = `${normalizeText(o.customerName)}|${total.toFixed(2)}`;
    duplicates.set(key, [...(duplicates.get(key) ?? []), o]);
  }
  for (const group of duplicates.values()) {
    if (group.length < 2) continue;
    const numbers = group.map((o) => o.salesOrderNumber).join(', ');
    flags.push({
      orderNumber: group[0].salesOrderNumber,
      customer: group[0].customerName,
      code: 'posible_duplicado',
      severity: 'media',
      amount: round2(toAmount(group[0].total)),
      reason: `Posible venta duplicada: mismo cliente y monto (${numbers}).`,
    });
  }

  const byMode = new Map<string, { mode: string; category: string; count: number; amount: number }>();
  for (const p of payments) {
    const amount = toAmount(p.amount);
    const mode = p.paymentMode?.trim() || 'SIN MODO';
    const category = paymentCategory(p.paymentMode);
    const m = byMode.get(mode) ?? { mode, category, count: 0, amount: 0 };
    m.count++;
    m.amount += amount;
    byMode.set(mode, m);
    const c = categoryEntry(category);
    c.payments += amount;
    c.paymentsCount++;
    if (!valid.some((o) => textEquals(o.customerName, p.customerName))) {
      flags.push({
        paymentNumber: p.paymentNumber,
        customer: p.customerName,
        code: 'pago_sin_venta_en_periodo',
        severity: 'baja',
        amount: round2(amount),
        reason: 'Pago de un cliente sin venta en el periodo (posible abono de una venta anterior).',
      });
    }
  }

  if (payments.length > 0) {
    for (const o of valid) {
      const collected = Math.max(0, toAmount(o.total) - Math.max(0, toAmount(o.balance)));
      if (collected <= EPSILON || NON_CASH_COLLECTION.has(paymentCategory(o.paymentMethod))) continue;
      if (!payments.some((p) => textEquals(p.customerName, o.customerName))) {
        flags.push({
          orderNumber: o.salesOrderNumber,
          customer: o.customerName,
          code: 'sin_pago_registrado',
          severity: 'media',
          amount: round2(collected),
          reason: `Cobrada por ${formatMxn(collected)} pero no hay pago registrado del cliente en el periodo.`,
        });
      }
    }
  }

  flags.sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity]);

  const flagSummary = new Map<string, { code: string; severity: Severity; count: number; amount: number }>();
  for (const f of flags) {
    const e = flagSummary.get(f.code) ?? { code: f.code, severity: f.severity, count: 0, amount: 0 };
    e.count++;
    e.amount = round2(e.amount + (f.amount ?? 0));
    flagSummary.set(f.code, e);
  }

  const sum = (list: number[]) => round2(list.reduce((s, n) => s + n, 0));
  return {
    totals: {
      orders: valid.length,
      excludedOrders: excluded.length,
      salesTotal: sum([...byMethod.values()].map((m) => m.total)),
      collectedPerSales: sum([...byMethod.values()].map((m) => m.collected)),
      pendingBalance: sum([...byMethod.values()].map((m) => m.pending)),
      payments: payments.length,
      paymentsReceived: sum([...byMode.values()].map((m) => m.amount)),
    },
    salesByPaymentMethod: [...byMethod.values()]
      .map((m) => ({ method: m.method, category: m.category, orders: m.count, total: round2(m.total), collected: round2(m.collected), pendingBalance: round2(m.pending) }))
      .sort((a, b) => b.total - a.total),
    paymentsByMode: [...byMode.values()]
      .map((m) => ({ mode: m.mode, category: m.category, payments: m.count, amount: round2(m.amount) }))
      .sort((a, b) => b.amount - a.amount),
    comparisonByCategory: [...byCategory.entries()]
      .map(([category, c]) => ({
        category,
        orders: c.orders,
        salesTotal: round2(c.salesTotal),
        collectedPerSales: round2(c.collected),
        pendingBalance: round2(c.pending),
        paymentsReceived: round2(c.payments),
        payments: c.paymentsCount,
        difference: round2(c.payments - c.collected),
      }))
      .sort((a, b) => b.salesTotal - a.salesTotal),
    flagSummary: [...flagSummary.values()].sort((a, b) => b.count - a.count),
    flags,
    ordersByPaymentMethod: Object.fromEntries(
      [...byMethod.values()].map((m) => [
        m.method,
        m.orders.map((o) => ({
          number: o.salesOrderNumber,
          date: formatDate(o.orderDate),
          customer: o.customerName,
          salesperson: o.salespersonName,
          total: round2(toAmount(o.total)),
          balance: round2(toAmount(o.balance)),
          paidStatus: statusLabel('salesPaid', o.paidStatus),
        })),
      ])
    ),
    excluded: excluded.map((o) => ({ number: o.salesOrderNumber, status: statusLabel('salesOrder', o.status), total: round2(toAmount(o.total)) })),
  };
}

/* Product relations ------------------------------------------------------- */

export interface RelationItem {
  name?: string | null;
  sku?: string | null;
  zohoItemId?: string | null;
  quantity?: unknown;
  unit?: string | null;
  lineTotal?: unknown;
  party?: string | null;
  document?: string | null;
  date?: Date | null;
}

interface ProductAggregate {
  key: string;
  itemId: string | null;
  nameKey: string;
  product: string;
  sku: string | null;
  unit: string | null;
  quantity: number;
  total: number;
  documents: Set<string>;
  parties: Map<string, number>;
  lastDate: Date | null;
}

function aggregateProducts(items: RelationItem[]): ProductAggregate[] {
  const map = new Map<string, ProductAggregate>();
  for (const i of items) {
    const nameKey = normalizeText(i.name);
    const key = i.zohoItemId ? `id:${i.zohoItemId}` : `name:${nameKey}`;
    const a = map.get(key) ?? {
      key,
      itemId: i.zohoItemId ?? null,
      nameKey,
      product: i.name ?? 'SIN NOMBRE',
      sku: i.sku ?? null,
      unit: i.unit ?? null,
      quantity: 0,
      total: 0,
      documents: new Set<string>(),
      parties: new Map<string, number>(),
      lastDate: null,
    };
    const qty = toAmount(i.quantity);
    a.quantity += qty;
    a.total += toAmount(i.lineTotal);
    if (i.document) a.documents.add(i.document);
    if (i.party) a.parties.set(i.party, (a.parties.get(i.party) ?? 0) + qty);
    if (i.date && (!a.lastDate || i.date > a.lastDate)) a.lastDate = i.date;
    if (!a.unit && i.unit) a.unit = i.unit;
    map.set(key, a);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function serializeAggregate(a: ProductAggregate, partyLabel: string) {
  return {
    product: a.product,
    sku: a.sku,
    unit: a.unit,
    quantity: round2(a.quantity),
    total: round2(a.total),
    documents: a.documents.size,
    lastDate: formatDate(a.lastDate),
    [partyLabel]: [...a.parties.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([name, quantity]) => ({ name, quantity: round2(quantity) })),
  };
}

function partyTotals(items: RelationItem[], limit: number) {
  const map = new Map<string, { name: string; quantity: number; total: number; documents: Set<string> }>();
  for (const i of items) {
    if (!i.party) continue;
    const e = map.get(i.party) ?? { name: i.party, quantity: 0, total: 0, documents: new Set<string>() };
    e.quantity += toAmount(i.quantity);
    e.total += toAmount(i.lineTotal);
    if (i.document) e.documents.add(i.document);
    map.set(i.party, e);
  }
  return [...map.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map((e) => ({ name: e.name, quantity: round2(e.quantity), total: round2(e.total), documents: e.documents.size }));
}

/** Links sold and purchased items by Zoho item id, falling back to the normalized product name. */
export function summarizeProductRelations(sold: RelationItem[], purchased: RelationItem[], limit = 30) {
  const soldAgg = aggregateProducts(sold);
  const boughtAgg = aggregateProducts(purchased);
  const shared = soldAgg
    .map((s) => {
      const b = boughtAgg.find((x) => (s.itemId && x.itemId === s.itemId) || (s.nameKey && x.nameKey === s.nameKey));
      return b
        ? {
            product: s.product,
            unit: s.unit ?? b.unit,
            soldQuantity: round2(s.quantity),
            soldTotal: round2(s.total),
            purchasedQuantity: round2(b.quantity),
            purchasedTotal: round2(b.total),
            customers: [...s.parties.keys()].slice(0, 5),
            vendors: [...b.parties.keys()].slice(0, 5),
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    soldProducts: soldAgg.slice(0, limit).map((a) => serializeAggregate(a, 'topCustomers')),
    purchasedProducts: boughtAgg.slice(0, limit).map((a) => serializeAggregate(a, 'topVendors')),
    sharedProducts: shared.slice(0, limit),
    customers: partyTotals(sold, 15),
    vendors: partyTotals(purchased, 15),
    counts: { soldProducts: soldAgg.length, purchasedProducts: boughtAgg.length, sharedProducts: shared.length },
  };
}

/**
 * Filter matching shared by AI tools.
 *
 * Zoho statuses are stored raw in English (`pending`, `partially_shipped`,
 * `not_invoiced`...) while users and the model speak Spanish ("Pendiente",
 * "por entregar", "sin facturar"). Every status filter must resolve through
 * this dictionary instead of a raw substring match.
 *
 * IMPORTANT — single-field vs. derived status: this file only translates
 * Spanish/English phrases into the raw value of ONE field at a time. Any
 * business status computed from MORE than one field (like a sales order's
 * overall "ticket" status) must be computed by that module's own canonical
 * function (e.g. `getTicketStatus` in `@/modules/sales/sales-orders-helpers`)
 * and only WRAPPED here (see `matchesTicketStatus`) — never re-derived from
 * scratch. Reimplementing multi-field logic here is what caused the AI to
 * disagree with the app's own "Ticket" column on 2026-09-11 (it treated a
 * `shippedStatus="shipped"` order as already delivered, when the order was
 * only "in transit" and still open per `getTicketStatus`).
 */

import { getSalesOrderStatusOptions, getTicketStatus } from '@/modules/sales/sales-orders-helpers';

export type StatusDomain =
  | 'salesOrder'
  | 'salesPaid'
  | 'salesInvoiced'
  | 'salesShipped'
  | 'salesTicket'
  | 'invoice'
  | 'bill'
  | 'purchaseOrder'
  | 'vendorCredit'
  | 'package'
  | 'customerPayment';

interface StatusDef {
  raw: string;
  label: string;
  synonyms: string[];
}

interface StatusGroup {
  phrases: string[];
  raws: string[];
}

interface DomainDictionary {
  statuses: StatusDef[];
  groups: StatusGroup[];
}

const STOP_WORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'en', 'y', 'a', 'al', 'con', 'por', 'para', 'the']);

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_\-()[\].,;:#"'/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularize(text: string): string {
  return text
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ');
}

function canonical(value: unknown): string {
  return singularize(normalizeText(value));
}

/** Accent/case-insensitive text match; also matches when every meaningful word of the query is present. */
export function textMatches(value: unknown, query: string | null | undefined): boolean {
  if (!query) return true;
  const v = normalizeText(value);
  const q = normalizeText(query);
  if (!q) return true;
  if (v.includes(q)) return true;
  const tokens = q.split(' ').filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return false;
  const cv = canonical(value);
  return tokens.every((t) => v.includes(t) || cv.includes(singularize(t)));
}

export function anyTextMatches(values: unknown[], query: string | null | undefined): boolean {
  if (!query) return true;
  return values.some((v) => textMatches(v, query));
}

/** Exact comparison ignoring case, accents and extra spaces. */
export function textEquals(a: unknown, b: unknown): boolean {
  return normalizeText(a) === normalizeText(b);
}

const OPEN_SHIPPING = ['pending', 'not_shipped', 'partially_shipped', 'packaged', 'packed'];
const DONE_SHIPPING = ['shipped', 'delivered', 'fulfilled'];
const UNPAID = ['unpaid', 'pending', 'overdue'];
const WITH_BALANCE = ['unpaid', 'pending', 'overdue', 'partially_paid', 'partial'];

const DICTIONARIES: Record<StatusDomain, DomainDictionary> = {
  salesOrder: {
    statuses: [
      { raw: 'confirmed', label: 'Confirmada', synonyms: ['confirmada', 'confirmado'] },
      { raw: 'closed', label: 'Cerrada', synonyms: ['cerrada', 'cerrado', 'completada', 'finalizada'] },
      { raw: 'void', label: 'Anulada', synonyms: ['anulada', 'anulado'] },
      { raw: 'cancelled', label: 'Cancelada', synonyms: ['cancelada', 'cancelado', 'canceled'] },
      { raw: 'draft', label: 'Borrador', synonyms: ['borrador'] },
      { raw: 'open', label: 'Abierta', synonyms: [] },
      { raw: 'pending_approval', label: 'Pendiente de aprobación', synonyms: ['pendiente de aprobacion', 'por aprobar'] },
      { raw: 'approved', label: 'Aprobada', synonyms: ['aprobada'] },
      { raw: 'onhold', label: 'En espera', synonyms: ['en espera', 'on hold'] },
    ],
    groups: [{ phrases: ['abierta', 'activa', 'vigente', 'open'], raws: ['open', 'confirmed'] }],
  },
  salesPaid: {
    statuses: [
      { raw: 'paid', label: 'Pagada', synonyms: ['pagada', 'pagado', 'liquidada', 'liquidado', 'cobrada', 'cobrado'] },
      { raw: 'partially_paid', label: 'Parcial', synonyms: ['parcial', 'parcialmente pagada', 'pago parcial', 'abonada', 'con abono'] },
      { raw: 'partial', label: 'Parcial', synonyms: [] },
      { raw: 'unpaid', label: 'Pendiente', synonyms: [] },
      { raw: 'pending', label: 'Pendiente', synonyms: [] },
      { raw: 'overdue', label: 'Vencida', synonyms: ['vencida', 'vencido', 'atrasada'] },
    ],
    groups: [
      { phrases: ['parcial', 'parcialmente pagada', 'pago parcial', 'abonada', 'con abono'], raws: ['partially_paid', 'partial'] },
      { phrases: ['pendiente'], raws: ['unpaid', 'pending'] },
      {
        phrases: ['no pagada', 'sin pagar', 'pendiente de pago', 'por cobrar', 'sin cobrar', 'no cobrada', 'impagada'],
        raws: UNPAID,
      },
      {
        phrases: ['con saldo', 'saldo pendiente', 'adeudo', 'con adeudo', 'debe', 'deben', 'a credito', 'no liquidada', 'sin liquidar', 'con balance'],
        raws: WITH_BALANCE,
      },
    ],
  },
  salesInvoiced: {
    statuses: [
      { raw: 'invoiced', label: 'Facturada', synonyms: ['facturada', 'facturado'] },
      { raw: 'not_invoiced', label: 'No facturada', synonyms: [] },
      { raw: 'partially_invoiced', label: 'Parcial', synonyms: ['parcial', 'parcialmente facturada'] },
      { raw: 'pending', label: 'Pendiente', synonyms: [] },
    ],
    groups: [
      { phrases: ['pendiente'], raws: ['not_invoiced', 'pending'] },
      {
        phrases: ['no facturada', 'sin facturar', 'por facturar', 'pendiente de facturar', 'pendiente de facturacion', 'falta facturar'],
        raws: ['not_invoiced', 'pending', 'partially_invoiced'],
      },
    ],
  },
  salesShipped: {
    statuses: [
      { raw: 'pending', label: 'Pendiente', synonyms: [] },
      { raw: 'not_shipped', label: 'No enviado', synonyms: [] },
      { raw: 'partially_shipped', label: 'Parcial', synonyms: ['parcial', 'parcialmente enviado', 'envio parcial', 'entrega parcial'] },
      { raw: 'packaged', label: 'Empaquetado', synonyms: ['empaquetado', 'empacado'] },
      { raw: 'packed', label: 'Empaquetado', synonyms: [] },
      { raw: 'shipped', label: 'Enviado', synonyms: ['enviado', 'embarcado'] },
      { raw: 'delivered', label: 'Entregado', synonyms: [] },
      { raw: 'fulfilled', label: 'Cumplido', synonyms: ['cumplido', 'surtido', 'completado'] },
    ],
    groups: [
      { phrases: ['pendiente', 'no enviado'], raws: ['pending', 'not_shipped'] },
      {
        phrases: [
          'por enviar', 'por entregar', 'sin enviar', 'sin entregar', 'no entregado', 'no entregada',
          'pendiente de entrega', 'pendiente de entregar', 'pendiente de envio', 'pendiente de enviar',
          'abierto', 'abierta', 'open', 'falta enviar', 'falta entregar', 'faltan por entregar',
          'faltan por enviar', 'en proceso', 'unshipped',
        ],
        raws: OPEN_SHIPPING,
      },
      { phrases: ['entregado', 'entregada', 'ya entregado', 'ya enviado', 'terminado'], raws: DONE_SHIPPING },
    ],
  },
  invoice: {
    statuses: [
      { raw: 'draft', label: 'Borrador', synonyms: ['borrador'] },
      { raw: 'sent', label: 'Enviada', synonyms: ['enviada'] },
      { raw: 'viewed', label: 'Vista', synonyms: ['vista'] },
      { raw: 'overdue', label: 'Vencida', synonyms: ['vencida', 'vencido', 'atrasada'] },
      { raw: 'paid', label: 'Pagada', synonyms: ['pagada', 'cobrada', 'liquidada'] },
      { raw: 'partially_paid', label: 'Parcialmente pagada', synonyms: ['parcial', 'parcialmente pagada', 'abonada'] },
      { raw: 'unpaid', label: 'Sin pagar', synonyms: [] },
      { raw: 'void', label: 'Anulada', synonyms: ['anulada', 'cancelada'] },
      { raw: 'pending', label: 'Pendiente', synonyms: [] },
      { raw: 'open', label: 'Abierta', synonyms: [] },
      { raw: 'closed', label: 'Cerrada', synonyms: ['cerrada'] },
      { raw: 'approved', label: 'Aprobada', synonyms: ['aprobada'] },
      { raw: 'pending_approval', label: 'Pendiente de aprobación', synonyms: ['pendiente de aprobacion', 'por aprobar'] },
    ],
    groups: [
      {
        phrases: ['abierta', 'open', 'pendiente', 'sin pagar', 'no pagada', 'por cobrar', 'sin cobrar', 'pendiente de pago', 'con saldo', 'unpaid'],
        raws: ['open', 'sent', 'viewed', 'overdue', 'unpaid', 'partially_paid', 'pending'],
      },
    ],
  },
  bill: {
    statuses: [
      { raw: 'draft', label: 'Borrador', synonyms: ['borrador'] },
      { raw: 'open', label: 'Abierta', synonyms: [] },
      { raw: 'overdue', label: 'Vencida', synonyms: ['vencida', 'vencido', 'atrasada'] },
      { raw: 'paid', label: 'Pagada', synonyms: ['pagada', 'liquidada'] },
      { raw: 'partially_paid', label: 'Parcialmente pagada', synonyms: ['parcial', 'parcialmente pagada', 'abonada'] },
      { raw: 'unpaid', label: 'Sin pagar', synonyms: [] },
      { raw: 'void', label: 'Anulada', synonyms: ['anulada', 'cancelada'] },
      { raw: 'pending', label: 'Pendiente', synonyms: [] },
      { raw: 'closed', label: 'Cerrada', synonyms: ['cerrada'] },
    ],
    groups: [
      {
        phrases: ['abierta', 'open', 'pendiente', 'por pagar', 'sin pagar', 'no pagada', 'pendiente de pago', 'con saldo', 'unpaid'],
        raws: ['open', 'overdue', 'partially_paid', 'unpaid', 'pending'],
      },
    ],
  },
  purchaseOrder: {
    statuses: [
      { raw: 'draft', label: 'Borrador', synonyms: ['borrador'] },
      { raw: 'open', label: 'Abierta', synonyms: [] },
      { raw: 'issued', label: 'Emitida', synonyms: ['emitida', 'enviada'] },
      { raw: 'billed', label: 'Facturada', synonyms: ['facturada'] },
      { raw: 'partially_billed', label: 'Parcialmente facturada', synonyms: ['parcialmente facturada'] },
      { raw: 'received', label: 'Recibida', synonyms: ['recibida', 'llego', 'entregada'] },
      { raw: 'partially_received', label: 'Parcialmente recibida', synonyms: ['parcialmente recibida', 'recibida parcial'] },
      { raw: 'closed', label: 'Cerrada', synonyms: ['cerrada', 'completada'] },
      { raw: 'cancelled', label: 'Cancelada', synonyms: ['cancelada', 'canceled'] },
      { raw: 'pending_approval', label: 'Pendiente de aprobación', synonyms: ['pendiente de aprobacion', 'por aprobar'] },
      { raw: 'approved', label: 'Aprobada', synonyms: ['aprobada'] },
    ],
    groups: [
      {
        phrases: ['abierta', 'open', 'pendiente', 'por recibir', 'sin recibir', 'no recibida', 'sin llegar', 'en proceso', 'en transito'],
        raws: ['open', 'issued', 'partially_billed', 'partially_received', 'approved', 'pending_approval'],
      },
    ],
  },
  vendorCredit: {
    statuses: [
      { raw: 'open', label: 'Abierto', synonyms: [] },
      { raw: 'closed', label: 'Cerrado', synonyms: ['cerrado', 'cerrada', 'aplicado', 'usado'] },
      { raw: 'void', label: 'Anulado', synonyms: ['anulado', 'anulada', 'cancelado'] },
      { raw: 'draft', label: 'Borrador', synonyms: ['borrador'] },
    ],
    groups: [{ phrases: ['abierto', 'abierta', 'open', 'disponible', 'con saldo', 'pendiente', 'sin aplicar'], raws: ['open'] }],
  },
  package: {
    statuses: [
      { raw: 'not_shipped', label: 'No enviado', synonyms: [] },
      { raw: 'shipped', label: 'Enviado', synonyms: ['enviado', 'en camino', 'en transito'] },
      { raw: 'delivered', label: 'Entregado', synonyms: ['entregado', 'entregada'] },
      { raw: 'packed', label: 'Empaquetado', synonyms: ['empaquetado', 'empacado'] },
    ],
    groups: [
      {
        phrases: ['abierto', 'abierta', 'open', 'pendiente', 'por enviar', 'sin enviar', 'no enviado', 'no entregado', 'por entregar'],
        raws: ['not_shipped', 'packed', 'pending', 'open'],
      },
    ],
  },
  customerPayment: {
    statuses: [
      { raw: 'success', label: 'Exitoso', synonyms: ['exitoso', 'aplicado', 'completado'] },
      { raw: 'paid', label: 'Pagado', synonyms: ['pagado'] },
      { raw: 'failed', label: 'Fallido', synonyms: ['fallido', 'rechazado'] },
      { raw: 'refunded', label: 'Reembolsado', synonyms: ['reembolsado', 'devuelto'] },
      { raw: 'void', label: 'Anulado', synonyms: ['anulado', 'cancelado'] },
      { raw: 'draft', label: 'Borrador', synonyms: ['borrador'] },
    ],
    groups: [],
  },
  // Raw values/labels sourced from getTicketStatus's own TICKET_STATUS_MAP (via
  // getSalesOrderStatusOptions) so this can never drift from the app's real "Ticket" column.
  salesTicket: {
    statuses: getSalesOrderStatusOptions('ticket').map((o) => ({ raw: o.value, label: o.label, synonyms: [] as string[] })),
    groups: [
      {
        // "Still needs to be delivered" — excludes closed/void/delivered. Deliberately excludes
        // draft/on_hold: those aren't confirmed sales yet, so counting them here would overstate
        // "what's pending to deliver". They're still reachable via the broader "no cerrado" group below.
        phrases: [
          'pendiente de entrega', 'pendientes de entrega', 'pendiente de entregar', 'por entregar',
          'sin entregar', 'no entregado', 'no entregada', 'que falta entregar', 'falta por entregar',
          'que tengo que entregar', 'que me falta entregar', 'pendiente', 'pendientes',
        ],
        raws: ['in_transit', 'pending_shipment', 'payment_pending', 'not_invoiced', 'open'],
      },
      {
        // Broader "ticket not finished" — everything except closed/void (includes delivered, draft, on_hold).
        phrases: [
          'no se ha cerrado', 'no cerrado', 'no cerrada', 'sin cerrar', 'abierto', 'abierta',
          'no terminado', 'no terminada', 'que falta por hacer',
        ],
        raws: ['draft', 'on_hold', 'delivered', 'in_transit', 'pending_shipment', 'payment_pending', 'not_invoiced', 'open'],
      },
      { phrases: ['entregado', 'entregada', 'ya entregado', 'ya entregada', 'ya llego', 'ya le llego'], raws: ['delivered'] },
      { phrases: ['cerrado', 'cerrada', 'terminado', 'terminada', 'completado', 'finalizado'], raws: ['closed'] },
    ],
  },
};

function humanize(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Human (Spanish) label for a raw status value. */
export function statusLabel(domain: StatusDomain, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const key = normalizeText(raw);
  const def = DICTIONARIES[domain].statuses.find((s) => normalizeText(s.raw) === key);
  return def ? def.label : humanize(raw);
}

function splitQuery(query: string): string[] {
  return query
    .split(/[,|;]|\s+o\s+|\s+or\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Resolves one query fragment to raw status values. Exact phrase matches win;
 * otherwise the longest known phrase contained in the fragment is used
 * ("pendientes de entregar a pie de obra" → "pendiente de entregar").
 */
function resolveFragment(domain: StatusDomain, fragment: string): Set<string> | null {
  const dict = DICTIONARIES[domain];
  const q = canonical(fragment);
  if (!q) return null;

  const candidates: Array<{ phrase: string; raws: string[] }> = [];
  for (const g of dict.groups) {
    for (const p of g.phrases) candidates.push({ phrase: canonical(p), raws: g.raws });
  }
  for (const s of dict.statuses) {
    candidates.push({ phrase: canonical(s.raw), raws: [s.raw] });
    for (const syn of s.synonyms) candidates.push({ phrase: canonical(syn), raws: [s.raw] });
  }

  const exact = candidates.find((c) => c.phrase === q);
  if (exact) return new Set(exact.raws);

  let best: { phrase: string; raws: string[] } | null = null;
  for (const c of candidates) {
    if (!c.phrase) continue;
    const re = new RegExp(`(^| )${c.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
    if (re.test(q) && (!best || c.phrase.length > best.phrase.length)) best = c;
  }
  return best ? new Set(best.raws) : null;
}

/** Raw values a status query refers to, or null when any fragment is unknown. */
export function resolveStatusQuery(domain: StatusDomain, query: string | null | undefined): string[] | null {
  if (!query) return null;
  const all = new Set<string>();
  for (const fragment of splitQuery(query)) {
    const resolved = resolveFragment(domain, fragment);
    if (!resolved) return null;
    resolved.forEach((r) => all.add(r));
  }
  return all.size > 0 ? [...all] : null;
}

/** True when a raw status value satisfies a user/model status query (Spanish, English or label). */
export function matchesStatus(
  domain: StatusDomain,
  raw: string | null | undefined,
  query: string | null | undefined
): boolean {
  if (!query) return true;
  if (raw === null || raw === undefined || raw === '') return false;
  const rawKey = normalizeText(raw);
  return splitQuery(query).some((fragment) => {
    const resolved = resolveFragment(domain, fragment);
    if (resolved) return [...resolved].some((r) => normalizeText(r) === rawKey);
    const f = normalizeText(fragment);
    return rawKey.includes(f) || normalizeText(statusLabel(domain, raw)).includes(f);
  });
}

export interface TicketStatusFields {
  status?: string | null;
  subStatus?: string | null;
  paidStatus?: string | null;
  invoicedStatus?: string | null;
  shippedStatus?: string | null;
}

/**
 * True when an order's OVERALL ticket status (computed by the same `getTicketStatus` the app's
 * Sales Orders Workspace uses for its "Ticket" column — never re-derived here) satisfies a
 * user/model query. Use this for "pendientes de entregar" / "qué me falta entregar" / "qué no se
 * ha cerrado" — a `shippedStatus="shipped"` order is still open here (in_transit), unlike
 * `matchesStatus('salesShipped', ...)` which only reasons about warehouse dispatch mechanics.
 */
export function matchesTicketStatus(order: TicketStatusFields, query: string | null | undefined): boolean {
  if (!query) return true;
  const raw = getTicketStatus({
    status: order.status ?? null,
    subStatus: order.subStatus ?? null,
    paidStatus: order.paidStatus ?? null,
    invoicedStatus: order.invoicedStatus ?? null,
    shippedStatus: order.shippedStatus ?? null,
  }).raw;
  return matchesStatus('salesTicket', raw, query);
}

/** Value → count distribution with Spanish labels, for diagnostics. */
export function statusDistribution(
  domain: StatusDomain,
  values: Array<string | null | undefined>
): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v ?? '';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value: value || '(vacío)', label: statusLabel(domain, value) ?? 'Sin estado', count }))
    .sort((a, b) => b.count - a.count);
}

export function toAmount(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(n) ? n : 0;
}

/* Delivery methods -------------------------------------------------------- */

export const DELIVERY_TYPES = ['entrega_a_cliente', 'recoge_en_bodega', 'instalacion', 'pie_de_obra', 'domicilio'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];
export type DeliveryKind = 'pickup' | 'installation' | 'site' | 'home' | 'shipping';

const DELIVERY_KIND_KEYWORDS: Array<[DeliveryKind, string[]]> = [
  ['pickup', ['recoge', 'recoger', 'bodega', 'sucursal', 'mostrador', 'pickup', 'en tienda']],
  ['installation', ['instalacion', 'instalar', 'instalado']],
  ['site', ['pie de obra', 'en obra', 'a obra']],
  ['home', ['domicilio']],
  ['shipping', ['envio', 'paqueteria', 'flete', 'foraneo', 'reparto', 'entrega']],
];

const DELIVERY_TYPE_KINDS: Record<DeliveryType, DeliveryKind[]> = {
  entrega_a_cliente: ['site', 'home', 'installation', 'shipping'],
  recoge_en_bodega: ['pickup'],
  instalacion: ['installation'],
  pie_de_obra: ['site'],
  domicilio: ['home', 'installation'],
};

// In UNIK "a domicilio" is colloquial for anything delivered to the customer, including A PIE DE OBRA.
const DELIVERY_CONCEPTS: Array<[DeliveryType, string[]]> = [
  ['recoge_en_bodega', ['recoge', 'recogen', 'recoger', 'que recogen', 'bodega', 'pickup', 'pasan por', 'pasa por', 'mostrador', 'sucursal', 'tienda']],
  ['instalacion', ['instalacion', 'instalar', 'instalado']],
  ['pie_de_obra', ['pie de obra', 'obra']],
  ['entrega_a_cliente', ['domicilio', 'entrega', 'entrega a domicilio', 'envio', 'enviar', 'entregar', 'llevar', 'flete', 'reparto', 'su casa', 'foraneo', 'mandar', 'cliente']],
];

export function classifyDeliveryMethod(value: unknown): DeliveryKind[] {
  const v = ` ${normalizeText(value)} `;
  if (!v.trim()) return [];
  return DELIVERY_KIND_KEYWORDS.filter(([, words]) => words.some((w) => v.includes(` ${w}`))).map(([kind]) => kind);
}

export function matchesDeliveryType(value: unknown, type: DeliveryType | null | undefined): boolean {
  if (!type) return true;
  const kinds = classifyDeliveryMethod(value);
  if (kinds.length === 0) return false;
  const pickupOnly = kinds.every((k) => k === 'pickup');
  if (type === 'recoge_en_bodega') return pickupOnly;
  if (pickupOnly) return false;
  return kinds.some((k) => DELIVERY_TYPE_KINDS[type].includes(k));
}

export function resolveDeliveryConcept(query: string | null | undefined): DeliveryType | null {
  const q = canonical(query).replace(/^(a|al|con|para|de|en) /, '');
  if (!q) return null;
  for (const [type, phrases] of DELIVERY_CONCEPTS) {
    if (phrases.some((p) => canonical(p) === q)) return type;
  }
  return null;
}

/** Generic words ("a domicilio", "recogen") resolve to a delivery type; specific names use text matching. */
export function matchesDeliveryMethod(value: unknown, query: string | null | undefined): boolean {
  if (!query) return true;
  const concept = resolveDeliveryConcept(query);
  if (concept) return matchesDeliveryType(value, concept);
  return textMatches(value, query);
}

/* Shipping locations ------------------------------------------------------ */

interface MxState {
  names: string[];
  abbrevs: string[];
  cities: string[];
}

// Abbreviations that collide with common address words (col, mor, ver, son...) are intentionally omitted.
const MX_STATES: MxState[] = [
  { names: ['aguascalientes'], abbrevs: ['ags'], cities: ['jesus maria', 'calvillo', 'pabellon de arteaga', 'rincon de romos'] },
  { names: ['baja california'], abbrevs: [], cities: ['tijuana', 'mexicali', 'ensenada'] },
  { names: ['baja california sur'], abbrevs: ['bcs'], cities: ['los cabos', 'cabo san lucas'] },
  { names: ['campeche'], abbrevs: [], cities: ['ciudad del carmen'] },
  { names: ['chiapas'], abbrevs: ['chis'], cities: ['tuxtla gutierrez', 'tapachula'] },
  { names: ['chihuahua'], abbrevs: ['chih'], cities: ['ciudad juarez'] },
  { names: ['ciudad de mexico', 'distrito federal'], abbrevs: ['cdmx'], cities: [] },
  { names: ['coahuila'], abbrevs: ['coah'], cities: ['saltillo', 'torreon', 'monclova'] },
  { names: ['colima'], abbrevs: [], cities: ['manzanillo'] },
  { names: ['durango'], abbrevs: ['dgo'], cities: ['gomez palacio'] },
  {
    names: ['guanajuato'],
    abbrevs: ['gto'],
    cities: [
      'leon', 'irapuato', 'celaya', 'silao', 'salamanca', 'san francisco del rincon', 'purisima del rincon',
      'purisima de bustos', 'manuel doblado', 'cortazar', 'san felipe', 'dolores hidalgo', 'juventino rosas',
      'uriangato', 'penjamo', 'valle de santiago', 'san miguel de allende', 'acambaro', 'romita', 'cueramaro',
    ],
  },
  { names: ['guerrero'], abbrevs: ['gro'], cities: ['acapulco', 'chilpancingo', 'iguala'] },
  { names: ['hidalgo'], abbrevs: ['hgo'], cities: ['pachuca', 'tulancingo'] },
  {
    names: ['jalisco'],
    abbrevs: ['jal'],
    cities: [
      'guadalajara', 'zapopan', 'tlaquepaque', 'tonala', 'tlajomulco', 'lagos de moreno', 'tepatitlan', 'arandas',
      'san juan de los lagos', 'puerto vallarta', 'ocotlan', 'encarnacion de diaz', 'teocaltiche', 'ojuelos', 'ciudad guzman',
    ],
  },
  { names: ['estado de mexico'], abbrevs: ['edomex'], cities: ['toluca', 'naucalpan', 'ecatepec', 'nezahualcoyotl', 'tlalnepantla'] },
  { names: ['michoacan'], abbrevs: ['mich'], cities: ['morelia', 'zamora', 'la piedad', 'uruapan', 'sahuayo'] },
  { names: ['morelos'], abbrevs: [], cities: ['cuernavaca', 'cuautla'] },
  { names: ['nayarit'], abbrevs: [], cities: ['tepic', 'bahia de banderas'] },
  { names: ['nuevo leon'], abbrevs: [], cities: ['monterrey', 'san pedro garza garcia', 'apodaca'] },
  { names: ['oaxaca'], abbrevs: ['oax'], cities: [] },
  { names: ['puebla'], abbrevs: [], cities: ['tehuacan', 'cholula'] },
  { names: ['queretaro'], abbrevs: ['qro'], cities: ['san juan del rio', 'el marques'] },
  { names: ['quintana roo'], abbrevs: ['qroo'], cities: ['cancun', 'playa del carmen', 'chetumal', 'tulum'] },
  { names: ['san luis potosi'], abbrevs: ['slp'], cities: ['ciudad valles', 'matehuala'] },
  { names: ['sinaloa'], abbrevs: [], cities: ['culiacan', 'mazatlan', 'los mochis'] },
  { names: ['sonora'], abbrevs: [], cities: ['hermosillo', 'ciudad obregon'] },
  { names: ['tabasco'], abbrevs: [], cities: ['villahermosa'] },
  { names: ['tamaulipas'], abbrevs: ['tamps'], cities: ['reynosa', 'matamoros', 'nuevo laredo', 'tampico', 'ciudad victoria'] },
  { names: ['tlaxcala'], abbrevs: ['tlax'], cities: ['apizaco'] },
  { names: ['veracruz'], abbrevs: [], cities: ['xalapa', 'coatzacoalcos', 'boca del rio', 'orizaba'] },
  { names: ['yucatan'], abbrevs: ['yuc'], cities: ['merida'] },
  { names: ['zacatecas'], abbrevs: ['zac'], cities: ['fresnillo'] },
];

function findMxState(query: string): MxState | null {
  const q = normalizeText(query);
  const stripped = q.replace(/^(estado|edo) (de )?/, '');
  return (
    MX_STATES.find((s) => s.names.includes(q) || s.abbrevs.includes(q)) ??
    MX_STATES.find((s) => s.names.includes(stripped) || s.abbrevs.includes(stripped)) ??
    null
  );
}

function matchesLocationSingle(values: unknown[], query: string): boolean {
  if (anyTextMatches(values, query)) return true;
  const state = findMxState(query);
  if (!state) return false;
  const text = ` ${values.map(normalizeText).filter(Boolean).join(' ')} `;
  const has = (term: string) => text.includes(` ${term} `);
  if (state.names.some(has) || state.abbrevs.some(has)) return true;
  if (MX_STATES.some((s) => s !== state && s.names.some(has))) return false;
  return state.cities.some(has);
}

/**
 * Matches free-text addresses by the query itself, by a Mexican state's name/abbreviation/main
 * cities, or by a city name alone (any city listed under any state). Accepts several places in
 * one query ("León o Silao", "León, Silao") — matches if ANY of them matches.
 */
export function matchesLocation(values: unknown[], query: string | null | undefined): boolean {
  if (!query) return true;
  return splitQuery(query).some((fragment) => matchesLocationSingle(values, fragment));
}

export function valueDistribution(values: Array<string | null | undefined>, limit = 30): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v && v.trim() ? v : '(vacío)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

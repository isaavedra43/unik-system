import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { statusLabel } from './ai-filter-matching';
import { getTicketStatus } from '@/modules/sales/sales-orders-helpers';

/**
 * Deterministic cross-checks between what a user wrote/photographed and the
 * system: batch lookup of sales orders by number, with "did you mean" for
 * numbers that do not exist (one wrong digit, two swapped digits) — the exact
 * reasoning a careful analyst applies when a handwritten "23364" is not in
 * the system but "23354" is.
 */

const MAX_LOOKUP = 400;

/** "OV-23354", "ov 23354", "23354." → "23354". Returns null when there is no number. */
export function normalizeOrderNumber(raw: string): string | null {
  const m = String(raw).replace(/[\s.,;:]+$/g, '').match(/(\d{3,8})\s*$/);
  return m ? m[1] : null;
}

/** Candidate numbers at edit distance 1 (substitution, adjacent transposition, insertion/deletion of one digit). Pure. */
export function nearbyNumberVariants(num: string): string[] {
  const out = new Set<string>();
  const digits = '0123456789';
  for (let i = 0; i < num.length; i++) {
    for (const d of digits) if (d !== num[i]) out.add(num.slice(0, i) + d + num.slice(i + 1));
    if (i < num.length - 1 && num[i] !== num[i + 1]) out.add(num.slice(0, i) + num[i + 1] + num[i] + num.slice(i + 2));
    out.add(num.slice(0, i) + num.slice(i + 1));
  }
  for (let i = 0; i <= num.length; i++) for (const d of digits) out.add(num.slice(0, i) + d + num.slice(i));
  out.delete(num);
  return [...out].filter((v) => v.length >= 3 && !v.startsWith('0'));
}

export interface OrderLookupRow {
  number: string;
  requested: string;
  date: string | null;
  customer: string | null;
  salesperson: string | null;
  ticketStatus: string;
  status: string | null;
  paidStatus: string | null;
  invoicedStatus: string | null;
  shippedStatus: string | null;
  paymentMethod: string | null;
  deliveryMethod: string | null;
  location: string | null;
  total: string | null;
  balance: string | null;
  notes?: string | null;
}

export interface OrderLookupResult {
  found: OrderLookupRow[];
  notFound: Array<{ requested: string; suggestions: Array<{ number: string; customer: string | null; ticketStatus: string }> }>;
  duplicates: string[];
}

function fmtDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Mexico_City' });
}

function dec(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function toRow(o: Record<string, unknown>, requested: string): OrderLookupRow {
  return {
    number: String(o.salesOrderNumber ?? ''),
    requested,
    date: fmtDate(o.orderDate as Date | null),
    customer: (o.customerName as string | null) ?? null,
    salesperson: (o.salespersonName as string | null) ?? null,
    ticketStatus: getTicketStatus({
      status: (o.status as string | null) ?? null,
      subStatus: (o.subStatus as string | null) ?? null,
      paidStatus: (o.paidStatus as string | null) ?? null,
      invoicedStatus: (o.invoicedStatus as string | null) ?? null,
      shippedStatus: (o.shippedStatus as string | null) ?? null,
    }).label,
    status: statusLabel('salesOrder', o.status as string | null),
    paidStatus: statusLabel('salesPaid', o.paidStatus as string | null),
    invoicedStatus: statusLabel('salesInvoiced', o.invoicedStatus as string | null),
    shippedStatus: statusLabel('salesShipped', o.shippedStatus as string | null),
    paymentMethod: (o.paymentMethod as string | null) ?? null,
    deliveryMethod: (o.deliveryMethod as string | null) ?? null,
    location: (o.locationName as string | null) ?? null,
    total: dec(o.total),
    balance: dec(o.balance),
    notes: o.notes ? String(o.notes).slice(0, 300) : null,
  };
}

const SELECT = {
  salesOrderNumber: true,
  orderDate: true,
  customerName: true,
  salespersonName: true,
  status: true,
  subStatus: true,
  paidStatus: true,
  invoicedStatus: true,
  shippedStatus: true,
  paymentMethod: true,
  deliveryMethod: true,
  locationName: true,
  total: true,
  balance: true,
  notes: true,
} as const;

/**
 * Finds sales orders whose number ends with each requested number (numbers are
 * stored as "OV-23354"; the user writes "23354"). Unknown numbers get up to 3
 * suggestions among existing orders one edit away.
 */
export async function matchSalesOrderNumbers(rawNumbers: string[]): Promise<OrderLookupResult> {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const numbers: string[] = [];
  for (const raw of rawNumbers.slice(0, MAX_LOOKUP)) {
    const n = normalizeOrderNumber(raw);
    if (!n) continue;
    if (seen.has(n)) {
      duplicates.push(n);
      continue;
    }
    seen.add(n);
    numbers.push(n);
  }
  if (numbers.length === 0) return { found: [], notFound: [], duplicates };

  const rows = await prisma.salesOrder.findMany({
    where: { OR: numbers.map((n) => ({ salesOrderNumber: { endsWith: n } })) },
    select: SELECT,
    take: MAX_LOOKUP * 2,
  });
  const byNumber = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const n = normalizeOrderNumber(r.salesOrderNumber ?? '');
    if (n && !byNumber.has(n)) byNumber.set(n, r as Record<string, unknown>);
  }

  const found: OrderLookupRow[] = [];
  const missing: string[] = [];
  for (const n of numbers) {
    const row = byNumber.get(n);
    if (row) found.push(toRow(row, n));
    else missing.push(n);
  }

  const notFound: OrderLookupResult['notFound'] = [];
  if (missing.length > 0) {
    const variants = new Map<string, string[]>();
    for (const n of missing) variants.set(n, nearbyNumberVariants(n));
    const allVariants = [...new Set([...variants.values()].flat())].slice(0, 4000);
    const candidates = allVariants.length
      ? await prisma.salesOrder.findMany({
          where: { OR: allVariants.map((v) => ({ salesOrderNumber: { endsWith: v } })) },
          select: SELECT,
          take: 2000,
        })
      : [];
    const candidateByNumber = new Map<string, Record<string, unknown>>();
    for (const c of candidates) {
      const n = normalizeOrderNumber(c.salesOrderNumber ?? '');
      if (n && !candidateByNumber.has(n)) candidateByNumber.set(n, c as Record<string, unknown>);
    }
    for (const n of missing) {
      const suggestions = (variants.get(n) ?? [])
        .filter((v) => candidateByNumber.has(v))
        .slice(0, 3)
        .map((v) => {
          const row = toRow(candidateByNumber.get(v) as Record<string, unknown>, n);
          return { number: row.number, customer: row.customer, ticketStatus: row.ticketStatus };
        });
      notFound.push({ requested: n, suggestions });
    }
  }
  return { found, notFound, duplicates };
}

registerTool({
  name: 'lookupSalesOrdersByNumber',
  category: 'sales',
  effect: 'read',
  enabledByDefault: true,
  requiredPermission: 'sales_orders.view',
  description:
    'Busca MUCHAS órdenes de venta por su número en una sola llamada (folios de una libreta, de un PDF, de un mensaje del cliente) y devuelve lo que dice el sistema de cada una: cliente, vendedor, fecha, ticket (Cerrado / En tránsito / Pendiente de envío / Borrador…), pago, facturación, envío, método de entrega y saldo. ' +
    'Los números que NO existen regresan en notFound con sugerencias de folios reales a un dígito de distancia (lectura probable de un manuscrito: "23364" → "23354"). ' +
    'Úsala siempre que cruces folios escritos por alguien contra el sistema; acepta "23354", "OV-23354" u "ov 23354".',
  parameters: z.object({
    numbers: z.array(z.string().max(30)).min(1).max(MAX_LOOKUP).describe('Folios a buscar (hasta 400). Pasa TODOS en una sola llamada.'),
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { numbers: string[] };
    const result = await matchSalesOrderNumbers(args.numbers);
    return {
      requested: args.numbers.length,
      foundCount: result.found.length,
      notFoundCount: result.notFound.length,
      orders: result.found,
      notFound: result.notFound,
      duplicates: result.duplicates,
      note:
        result.notFound.length > 0
          ? 'Los folios en notFound no existen tal cual: si traen suggestions, lo más probable es que el número se leyó/escribió mal; usa la sugerencia y dilo explícitamente ("23364 no existe; se asocia a 23354"). Si no hay sugerencias, repórtalo como folio no encontrado.'
          : 'Todos los folios existen en el sistema.',
    };
  },
});

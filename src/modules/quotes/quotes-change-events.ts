import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { QUOTE_ENTITY_TYPE } from './permissions';

/**
 * Change detection and notification service for Quotes (cotizaciones).
 * Mirrors sales-orders-change-events.ts:
 * - First import does NOT generate a change event.
 * - Idempotent per sourceSnapshotId (unique on EntityChangeEvent).
 * - Only meaningful business fields are compared.
 * - Notifications only for active watchers.
 */

export interface QuoteSnapshot {
  id: string;
  status: string | null;
  customerName: string | null;
  salespersonName: string | null;
  date: Date | null;
  expiryDate: Date | null;
  referenceNumber: string | null;
  discount: Prisma.Decimal | null;
  subTotal: Prisma.Decimal | null;
  discountTotal: Prisma.Decimal | null;
  taxTotal: Prisma.Decimal | null;
  shippingCharge: Prisma.Decimal | null;
  adjustment: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
  notes: string | null;
  terms: string | null;
}

export interface QuoteItemSnapshot {
  zohoLineItemId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  name: string | null;
  quantity: Prisma.Decimal | null;
  rate: Prisma.Decimal | null;
  discount: string | null;
  taxPercentage: Prisma.Decimal | null;
  lineTotal: Prisma.Decimal | null;
}

const MEANINGFUL_FIELDS: (keyof QuoteSnapshot)[] = [
  'status', 'customerName', 'salespersonName', 'date', 'expiryDate', 'referenceNumber',
  'discount', 'subTotal', 'discountTotal', 'taxTotal', 'shippingCharge', 'adjustment', 'total',
  'notes', 'terms',
];

const FIELD_LABELS: Record<string, string> = {
  status: 'Estado', customerName: 'Cliente', salespersonName: 'Vendedor', date: 'Fecha',
  expiryDate: 'Vencimiento', referenceNumber: 'Referencia', discount: 'Descuento', subTotal: 'Subtotal',
  discountTotal: 'Descuento total', taxTotal: 'Impuestos', shippingCharge: 'Envío', adjustment: 'Ajuste',
  total: 'Total', notes: 'Notas', terms: 'Términos',
};

function serialize(v: unknown): unknown {
  if (v instanceof Prisma.Decimal) return v.toString();
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a instanceof Prisma.Decimal && b instanceof Prisma.Decimal) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return String(a) === String(b);
}

function diffFields(before: QuoteSnapshot, after: QuoteSnapshot): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of MEANINGFUL_FIELDS) {
    if (!valuesEqual(before[field], after[field])) {
      changes[field] = { before: serialize(before[field]), after: serialize(after[field]) };
    }
  }
  return changes;
}

function itemKey(item: QuoteItemSnapshot): string {
  return item.zohoLineItemId ?? item.zohoItemId ?? item.sku ?? item.name ?? '';
}

function diffItems(before: QuoteItemSnapshot[], after: QuoteItemSnapshot[]): Record<string, unknown> | null {
  const beforeMap = new Map(before.map((i) => [itemKey(i), i]));
  const afterMap = new Map(after.map((i) => [itemKey(i), i]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: Record<string, Record<string, { before: unknown; after: unknown }>> = {};

  for (const [key, afterItem] of afterMap) {
    const beforeItem = beforeMap.get(key);
    if (!beforeItem) { added.push(afterItem.name ?? key); continue; }
    const itemChanges: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of ['quantity', 'rate', 'discount', 'taxPercentage', 'lineTotal'] as (keyof QuoteItemSnapshot)[]) {
      if (!valuesEqual(beforeItem[field], afterItem[field])) {
        itemChanges[field] = { before: serialize(beforeItem[field]), after: serialize(afterItem[field]) };
      }
    }
    if (Object.keys(itemChanges).length > 0) modified[afterItem.name ?? key] = itemChanges;
  }
  for (const [key, beforeItem] of beforeMap) {
    if (!afterMap.has(key)) removed.push(beforeItem.name ?? key);
  }
  if (added.length === 0 && removed.length === 0 && Object.keys(modified).length === 0) return null;
  return { added, removed, modified };
}

const SNAPSHOT_SELECT = {
  id: true, status: true, customerName: true, salespersonName: true, date: true, expiryDate: true,
  referenceNumber: true, discount: true, subTotal: true, discountTotal: true, taxTotal: true,
  shippingCharge: true, adjustment: true, total: true, notes: true, terms: true,
} satisfies Prisma.QuoteSelect;

const ITEM_SNAPSHOT_SELECT = {
  zohoLineItemId: true, zohoItemId: true, sku: true, name: true, quantity: true, rate: true,
  discount: true, taxPercentage: true, lineTotal: true,
} satisfies Prisma.QuoteItemSelect;

export async function getQuoteSnapshot(
  tx: Prisma.TransactionClient,
  quoteId: string
): Promise<{ quote: QuoteSnapshot | null; items: QuoteItemSnapshot[] }> {
  const quote = await tx.quote.findUnique({ where: { id: quoteId }, select: SNAPSHOT_SELECT });
  if (!quote) return { quote: null, items: [] };
  const items = await tx.quoteItem.findMany({ where: { quoteId }, orderBy: { sortOrder: 'asc' }, select: ITEM_SNAPSHOT_SELECT });
  return { quote, items };
}

export async function getQuoteSnapshotByZohoId(
  tx: Prisma.TransactionClient,
  zohoEstimateId: string
): Promise<{ quote: QuoteSnapshot | null; items: QuoteItemSnapshot[] }> {
  const existing = await tx.quote.findUnique({ where: { zohoEstimateId }, select: { id: true } });
  if (!existing) return { quote: null, items: [] };
  return getQuoteSnapshot(tx, existing.id);
}

export interface RecordQuoteChangeInput {
  quoteId: string;
  estimateNumber: string | null;
  sourceSnapshotId: string;
  sourceRemoteModifiedAt: Date | null;
  before: { quote: QuoteSnapshot | null; items: QuoteItemSnapshot[] };
  after: { quote: QuoteSnapshot; items: QuoteItemSnapshot[] };
  /** Who made the change from UNIK (null when detected via sync from Zoho). */
  actorUserId?: string | null;
  /** Free label of what happened, e.g. 'edited_in_unik', 'status_sent'. */
  origin?: string | null;
}

export async function recordQuoteChange(tx: Prisma.TransactionClient, input: RecordQuoteChangeInput): Promise<void> {
  if (input.before.quote === null) return;

  const existing = await tx.entityChangeEvent.findUnique({ where: { sourceSnapshotId: input.sourceSnapshotId }, select: { id: true } });
  if (existing) return;

  const fieldChanges = diffFields(input.before.quote, input.after.quote);
  const itemChanges = diffItems(input.before.items, input.after.items);
  if (Object.keys(fieldChanges).length === 0 && itemChanges === null) return;

  const changes: Record<string, unknown> = {};
  if (Object.keys(fieldChanges).length > 0) changes.fields = fieldChanges;
  if (itemChanges !== null) changes.items = itemChanges;
  if (input.actorUserId) changes.actorUserId = input.actorUserId;
  if (input.origin) changes.origin = input.origin;

  const event = await tx.entityChangeEvent.create({
    data: {
      entityType: QUOTE_ENTITY_TYPE,
      entityId: input.quoteId,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceRemoteModifiedAt: input.sourceRemoteModifiedAt,
      changes: changes as Prisma.InputJsonValue,
    },
  });

  const watchers = await tx.entityWatch.findMany({
    where: { entityType: QUOTE_ENTITY_TYPE, entityId: input.quoteId, isActive: true },
    select: { userId: true },
  });
  if (watchers.length === 0) return;

  const title = `Cotización ${input.estimateNumber ?? input.quoteId.slice(-6)} tiene cambios`;
  const body = Object.keys(fieldChanges)
    .slice(0, 3)
    .map((f) => `${FIELD_LABELS[f] ?? f}: ${fieldChanges[f].before ?? '—'} → ${fieldChanges[f].after ?? '—'}`)
    .join(', ');

  for (const watcher of watchers) {
    if (input.actorUserId && watcher.userId === input.actorUserId) continue;
    const existingNotif = await tx.notification.findFirst({ where: { userId: watcher.userId, changeEventId: event.id }, select: { id: true } });
    if (existingNotif) continue;
    await tx.notification.create({
      data: {
        userId: watcher.userId,
        type: 'quote_changed',
        title,
        body: body || 'Se detectaron cambios en la cotización',
        entityType: QUOTE_ENTITY_TYPE,
        entityId: input.quoteId,
        changeEventId: event.id,
        metadata: { estimateNumber: input.estimateNumber } as Prisma.InputJsonValue,
      },
    });
  }
}

export async function getQuoteChangeEvents(quoteId: string, limit = 50): Promise<{ id: string; changes: unknown; sourceRemoteModifiedAt: string | null; createdAt: string }[]> {
  const events = await prisma.entityChangeEvent.findMany({
    where: { entityType: QUOTE_ENTITY_TYPE, entityId: quoteId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  });
  return events.map((e) => ({
    id: e.id, changes: e.changes,
    sourceRemoteModifiedAt: e.sourceRemoteModifiedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  }));
}

export { FIELD_LABELS as QUOTE_CHANGE_FIELD_LABELS };

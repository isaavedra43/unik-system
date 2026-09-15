import { canonicalUnit } from './unit-normalizer';
import type { PurchaseRequestLineStatus, PurchaseRequestStatus } from './purchases-types';

/**
 * Rules of purchase requests (plan 6.1, `requests-service`): consolidation
 * keys (`zohoItemId|ISO week` in Mexico City time), line and request states,
 * consolidation suggestions and the grouping of request lines into one order
 * or RFQ that keeps every demand traceable.
 *
 * Pure module.
 */

export const REQUEST_TIMEZONE = 'America/Mexico_City';
const EPS = 0.00005;

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** ISO 8601 week of the local day of `date`: `2026-W38`. */
export function isoWeekKey(date: Date, timeZone: string = REQUEST_TIMEZONE): string {
  const { year, month, day } = localDateParts(date, timeZone);
  const d = new Date(Date.UTC(year, month - 1, day));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** `zohoItemId|ISO week` of the date the material is needed (or created); null without item. */
export function consolidationKey(zohoItemId: string | null | undefined, date: Date | null | undefined): string | null {
  const item = String(zohoItemId ?? '').trim();
  if (!item || !date || Number.isNaN(date.getTime())) return null;
  return `${item}|${isoWeekKey(date)}`.slice(0, 190);
}

export interface RequestLineQuantities {
  status: string;
  qty: number;
  qtyOrdered: number;
  qtyReceived: number;
}

export function requestLineStatus(line: RequestLineQuantities): PurchaseRequestLineStatus {
  if (line.status === 'cancelled') return 'cancelled';
  if (line.qty > 0 && line.qtyReceived + EPS >= line.qty) return 'received';
  if (line.qty > 0 && line.qtyOrdered + EPS >= line.qty) return 'ordered';
  return 'open';
}

export function remainingToOrder(line: Pick<RequestLineQuantities, 'qty' | 'qtyOrdered' | 'status'>): number {
  if (line.status === 'cancelled') return 0;
  return Math.max(0, Math.round((line.qty - line.qtyOrdered) * 10_000) / 10_000);
}

/**
 * Request status from its lines: cancelled when every line is cancelled, closed
 * when every live line is received, ordered when every live line is ordered;
 * otherwise a consolidated/sourcing/draft request keeps its stage and the rest
 * go back to open.
 */
export function requestStatusFromLines(
  current: PurchaseRequestStatus | string,
  lines: readonly RequestLineQuantities[]
): PurchaseRequestStatus {
  if (current === 'cancelled' || current === 'closed') return current;
  const live = lines.filter((line) => line.status !== 'cancelled');
  if (lines.length > 0 && live.length === 0) return 'cancelled';
  if (live.length === 0) return (current as PurchaseRequestStatus) ?? 'open';
  const statuses = live.map(requestLineStatus);
  if (statuses.every((s) => s === 'received')) return 'closed';
  if (statuses.every((s) => s === 'received' || s === 'ordered')) return 'ordered';
  if (current === 'consolidated' || current === 'sourcing' || current === 'draft') return current;
  return 'open';
}

export interface ConsolidationLine {
  id: string;
  requestId: string;
  zohoItemId: string | null;
  consolidationKey: string | null;
  description: string;
  qty: number;
  qtyOrdered: number;
  unit: string;
  status: string;
}

export interface ConsolidationGroup {
  key: string;
  zohoItemId: string;
  week: string;
  description: string;
  lineIds: string[];
  requestIds: string[];
  totals: Array<{ unit: string; qty: number }>;
}

/** Open, not ordered lines of the same item and week coming from two or more requests. */
export function suggestConsolidations(lines: readonly ConsolidationLine[]): ConsolidationGroup[] {
  const groups = new Map<string, ConsolidationLine[]>();
  for (const line of lines) {
    if (!line.consolidationKey || !line.zohoItemId) continue;
    if (line.status !== 'open' || line.qtyOrdered > EPS) continue;
    const list = groups.get(line.consolidationKey) ?? [];
    list.push(line);
    groups.set(line.consolidationKey, list);
  }
  const out: ConsolidationGroup[] = [];
  for (const [key, list] of groups) {
    const requestIds = [...new Set(list.map((l) => l.requestId))];
    if (list.length < 2 || requestIds.length < 2) continue;
    const totals = new Map<string, number>();
    for (const line of list) {
      const unit = canonicalUnit(line.unit) || line.unit;
      totals.set(unit, Math.round(((totals.get(unit) ?? 0) + line.qty) * 10_000) / 10_000);
    }
    out.push({
      key,
      zohoItemId: list[0].zohoItemId!,
      week: key.split('|').pop() ?? '',
      description: list[0].description,
      lineIds: list.map((l) => l.id),
      requestIds,
      totals: [...totals].map(([unit, qty]) => ({ unit, qty })),
    });
  }
  return out.sort((a, b) => b.lineIds.length - a.lineIds.length || a.key.localeCompare(b.key));
}

export interface GroupableRequestLine {
  id: string;
  zohoItemId: string | null;
  description: string;
  unit: string;
  /** Quantity still to order. */
  remaining: number;
  demandId: string | null;
  allocationId: string | null;
}

export interface GroupedOrderLine {
  zohoItemId: string | null;
  description: string;
  unit: string;
  qty: number;
  sources: Array<{ requestLineId: string; demandId: string | null; allocationId: string | null; qty: number }>;
}

function descriptionKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** One order/RFQ line per item and unit; each source keeps its request line and demand. */
export function groupRequestLines(lines: readonly GroupableRequestLine[]): GroupedOrderLine[] {
  const groups = new Map<string, GroupedOrderLine>();
  for (const line of lines) {
    if (!(line.remaining > EPS)) continue;
    const unit = canonicalUnit(line.unit) || line.unit;
    const key = `${line.zohoItemId ? `item:${line.zohoItemId}` : `desc:${descriptionKey(line.description)}`}|${unit}`;
    const group =
      groups.get(key) ??
      ({ zohoItemId: line.zohoItemId, description: line.description, unit: line.unit, qty: 0, sources: [] } as GroupedOrderLine);
    group.qty = Math.round((group.qty + line.remaining) * 10_000) / 10_000;
    group.sources.push({
      requestLineId: line.id,
      demandId: line.demandId,
      allocationId: line.allocationId,
      qty: line.remaining,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

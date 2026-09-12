/** Client-side types and helpers for the quotes workspace (mirrors the API DTOs). */

export interface QuoteItem {
  sku?: string;
  name: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

export interface QuoteDTO {
  id: string;
  number: string | null;
  customerName: string;
  contactId: string | null;
  zohoCustomerId: string | null;
  items: QuoteItem[];
  subtotal: string;
  tax: string;
  total: string;
  currency: string;
  status: string;
  version: number;
  contentHash: string | null;
  zohoEstimateId: string | null;
  documentId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  syncedAt: string | null;
  invalidationReason: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteScenario {
  name: string;
  discountPct?: number;
  quantityMultiplier?: number;
  taxRate?: number;
}

export interface ScenarioTotals {
  name: string;
  subtotal: string;
  tax: string;
  total: string;
  deltaTotal?: string;
  deltaPct?: string;
}

export const QUOTE_STATUS_LABEL: Record<string, { label: string; badge: string }> = {
  draft: { label: 'Borrador', badge: 'badge-weak' },
  pending_approval: { label: 'Pendiente de aprobación', badge: 'badge-warning' },
  approved: { label: 'Aprobada (sin sincronizar)', badge: 'badge-info' },
  synced: { label: 'Oficial en Books', badge: 'badge-success' },
  sent: { label: 'Enviada', badge: 'badge-success' },
  rejected: { label: 'Rechazada', badge: 'badge-danger' },
  invalidated: { label: 'Invalidada', badge: 'badge-danger' },
};

export function money(value: string | number, currency: string): string {
  const n = Number(value);
  return `${new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(n) ? n : 0)} ${currency}`;
}

/** Client-side preview only; the server recomputes with Decimal. */
export function previewTotals(items: QuoteItem[]): {
  subtotal: number;
  tax: number;
  total: number;
} {
  let subtotal = 0;
  let tax = 0;
  for (const item of items) {
    const line = Math.round(item.quantity * item.unitPrice * 10000) / 10000;
    subtotal += line;
    tax += Math.round(line * (item.taxRate ?? 0) * 10000) / 10000;
  }
  return { subtotal, tax, total: subtotal + tax };
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const emptyItem = (): QuoteItem => ({ name: '', quantity: 1, unitPrice: 0, taxRate: 0.16 });

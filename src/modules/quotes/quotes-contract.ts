import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * Quotes contract: validation schemas, Decimal-safe totals and the canonical
 * content hash that binds a human approval to the exact content reviewed.
 */

export const QUOTE_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'synced',
  'sent',
  'rejected',
  'invalidated',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const quoteItemSchema = z.object({
  sku: z.string().trim().max(80).optional(),
  name: z.string().trim().min(1, 'Nombre requerido').max(200),
  description: z.string().trim().max(2000).optional(),
  quantity: z.number().positive('La cantidad debe ser mayor que 0').max(1_000_000),
  unitPrice: z.number().min(0, 'El precio no puede ser negativo').max(1_000_000_000),
  taxRate: z.number().min(0).max(1).default(0),
});
export type QuoteItemInput = z.infer<typeof quoteItemSchema>;

export const createQuoteSchema = z.object({
  customerName: z.string().trim().min(1, 'Cliente requerido').max(200),
  contactId: z.string().trim().min(1).max(64).optional(),
  zohoCustomerId: z.string().trim().min(1).max(64).optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'Moneda ISO de 3 letras')
    .default('MXN'),
  items: z.array(quoteItemSchema).max(200),
  notes: z.string().trim().max(4000).optional(),
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const updateQuoteSchema = createQuoteSchema.partial();
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;

export const scenarioSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Percentage discount applied to every unit price (0-100). */
  discountPct: z.number().min(0).max(100).optional(),
  /** Multiplies every quantity (e.g. 2 = double the order). */
  quantityMultiplier: z.number().positive().max(1000).optional(),
  /** Overrides the tax rate of every line (0-1). */
  taxRate: z.number().min(0).max(1).optional(),
});
export type QuoteScenario = z.infer<typeof scenarioSchema>;

export const simulateScenariosSchema = z.object({
  scenarios: z.array(scenarioSchema).min(1).max(10),
});

export const quoteSettingsSchema = z.object({
  /** Commercial conditions printed in every commercial package. */
  conditions: z.string().max(8000).default(''),
  validityDays: z.number().int().min(1).max(365).default(15),
  companyName: z.string().max(120).default('UNIK'),
});
export type QuoteSettings = z.infer<typeof quoteSettingsSchema>;

export const DEFAULT_QUOTE_SETTINGS: QuoteSettings = {
  conditions:
    'Precios en la moneda indicada, sujetos a cambio sin previo aviso una vez vencida la vigencia. ' +
    'Impuestos incluidos según se indica en cada partida. Tiempos de entrega sujetos a disponibilidad.',
  validityDays: 15,
  companyName: 'UNIK',
};

export const QUOTE_SETTINGS_KEY = 'quotes:settings';

/* ------------------------------------------------------------------ */
/* Money                                                              */
/* ------------------------------------------------------------------ */

const SCALE = 4;

export function toDecimal(
  value: Prisma.Decimal | number | string | null | undefined
): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function round(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

export interface QuoteLineTotals {
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
}

export interface QuoteTotals {
  subtotal: string;
  tax: string;
  total: string;
  lines: QuoteLineTotals[];
}

/** Computes line and document totals with Decimal arithmetic (never floats). */
export function computeTotals(items: QuoteItemInput[]): QuoteTotals {
  let subtotal = new Prisma.Decimal(0);
  let tax = new Prisma.Decimal(0);
  const lines: QuoteLineTotals[] = [];
  for (const item of items) {
    const lineSubtotal = round(toDecimal(item.quantity).mul(toDecimal(item.unitPrice)));
    const lineTax = round(lineSubtotal.mul(toDecimal(item.taxRate ?? 0)));
    const lineTotal = lineSubtotal.plus(lineTax);
    subtotal = subtotal.plus(lineSubtotal);
    tax = tax.plus(lineTax);
    lines.push({
      lineSubtotal: lineSubtotal.toFixed(SCALE),
      lineTax: lineTax.toFixed(SCALE),
      lineTotal: lineTotal.toFixed(SCALE),
    });
  }
  return {
    subtotal: subtotal.toFixed(SCALE),
    tax: tax.toFixed(SCALE),
    total: subtotal.plus(tax).toFixed(SCALE),
    lines,
  };
}

/** Applies a scenario to the items and returns the resulting totals. */
export function applyScenario(items: QuoteItemInput[], scenario: QuoteScenario): QuoteTotals {
  const factor =
    scenario.discountPct === undefined
      ? new Prisma.Decimal(1)
      : new Prisma.Decimal(100).minus(toDecimal(scenario.discountPct)).div(100);
  const adjusted = items.map((item) => ({
    ...item,
    quantity: Number(
      toDecimal(item.quantity)
        .mul(toDecimal(scenario.quantityMultiplier ?? 1))
        .toFixed(6)
    ),
    unitPrice: Number(round(toDecimal(item.unitPrice).mul(factor)).toFixed(SCALE)),
    taxRate: scenario.taxRate ?? item.taxRate ?? 0,
  }));
  return computeTotals(adjusted);
}

/* ------------------------------------------------------------------ */
/* Canonical content hash                                             */
/* ------------------------------------------------------------------ */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export interface QuoteContent {
  customerName: string;
  contactId?: string | null;
  zohoCustomerId?: string | null;
  currency: string;
  items: QuoteItemInput[];
  notes?: string | null;
}

/** Stable hash of the commercially relevant content (numbers normalized to 4 decimals). */
export function computeQuoteContentHash(content: QuoteContent): string {
  const normalized = {
    customerName: content.customerName.trim(),
    contactId: content.contactId ?? null,
    zohoCustomerId: content.zohoCustomerId ?? null,
    currency: content.currency,
    notes: content.notes?.trim() || null,
    items: content.items.map((item) => ({
      sku: item.sku?.trim() || null,
      name: item.name.trim(),
      description: item.description?.trim() || null,
      quantity: toDecimal(item.quantity).toFixed(6),
      unitPrice: toDecimal(item.unitPrice).toFixed(SCALE),
      taxRate: toDecimal(item.taxRate ?? 0).toFixed(6),
    })),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(normalized)))
    .digest('hex');
}

/** Parses the `items` JSON column defensively (never trusts stored shape blindly). */
export function parseStoredItems(raw: unknown): QuoteItemInput[] {
  const parsed = z.array(quoteItemSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

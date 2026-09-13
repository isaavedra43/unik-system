import { z } from 'zod';

/**
 * Shared (client + server) validation for creating / editing a quote.
 * The same schema will be reused by the AI tools later (see quotes-ai-adapter.ts),
 * so it must stay framework-agnostic.
 */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (yyyy-mm-dd)');
const money = z.coerce.number().finite().min(0, 'Debe ser mayor o igual a 0');
const zohoId = z.string().trim().min(1).max(40);

export const quoteLineInputSchema = z.object({
  /** Existing Zoho line id (edit only). Keeps the line instead of recreating it. */
  lineItemId: z.string().trim().max(40).optional().nullable(),
  /** Zoho item id from the synced Product catalog. Optional → free-text line. */
  itemId: zohoId.optional().nullable(),
  name: z.string().trim().min(1, 'El concepto necesita nombre').max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  quantity: z.coerce.number().finite().gt(0, 'La cantidad debe ser mayor a 0'),
  rate: money,
  unit: z.string().trim().max(40).optional().nullable(),
  /** Line discount percent (0-100). Only applied when discountMode === 'item'. */
  discountPercent: z.coerce.number().finite().min(0).max(100).optional().nullable(),
  /** Zoho tax id. When omitted Zoho applies the item's default tax. */
  taxId: z.string().trim().max(40).optional().nullable(),
});
export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;

export const DISCOUNT_MODES = ['none', 'entity', 'item'] as const;
export type DiscountMode = (typeof DISCOUNT_MODES)[number];

export const quoteFormInputSchema = z.object({
  /** UUID generated once per form session — idempotency key for Zoho writes. */
  requestKey: z.string().trim().min(8).max(80),
  customerId: zohoId,
  date: dateOnly,
  expiryDate: dateOnly.optional().nullable(),
  referenceNumber: z.string().trim().max(100).optional().nullable(),
  salespersonName: z.string().trim().max(120).optional().nullable(),
  /** Zoho salesperson_id when picked from the Zoho list (preferred over name). */
  salespersonId: z.string().trim().max(40).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  terms: z.string().trim().max(5000).optional().nullable(),
  discountMode: z.enum(DISCOUNT_MODES).default('none'),
  /** Entity-level discount when discountMode === 'entity'. */
  discountValue: z.coerce.number().finite().min(0).optional().nullable(),
  discountIsPercent: z.boolean().default(true),
  isDiscountBeforeTax: z.boolean().default(true),
  shippingCharge: money.optional().nullable(),
  adjustment: z.coerce.number().finite().optional().nullable(),
  adjustmentDescription: z.string().trim().max(200).optional().nullable(),
  templateId: z.string().trim().max(40).optional().nullable(),
  items: z.array(quoteLineInputSchema).min(1, 'Agrega al menos un concepto').max(200),
  /**
   * Edit only: the Zoho last_modified_time the user was looking at. If Zoho
   * reports a newer timestamp the update is rejected as a conflict.
   */
  expectedRemoteModifiedAt: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.expiryDate && value.expiryDate < value.date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiryDate'], message: 'El vencimiento no puede ser anterior a la fecha' });
  }
  if (value.discountMode === 'entity' && value.discountIsPercent && (value.discountValue ?? 0) > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'El descuento en % no puede exceder 100' });
  }
});
export type QuoteFormInput = z.input<typeof quoteFormInputSchema>;
export type QuoteFormValues = z.output<typeof quoteFormInputSchema>;

export const quoteStatusActionSchema = z.enum(['sent', 'accepted', 'declined']);
export type QuoteStatusAction = z.infer<typeof quoteStatusActionSchema>;

export const quoteEmailInputSchema = z.object({
  to: z.array(z.string().trim().email('Correo inválido')).min(1, 'Agrega al menos un destinatario').max(10),
  cc: z.array(z.string().trim().email('Correo inválido')).max(10).default([]),
  subject: z.string().trim().max(200).optional().nullable(),
  body: z.string().trim().max(5000).optional().nullable(),
});
export type QuoteEmailInput = z.input<typeof quoteEmailInputSchema>;

/** Client-side helper: totals preview (Zoho remains the source of truth). */
export function estimateTotals(values: {
  items: { quantity: number; rate: number; discountPercent?: number | null; taxPercent?: number | null }[];
  discountMode: DiscountMode;
  discountValue?: number | null;
  discountIsPercent: boolean;
  shippingCharge?: number | null;
  adjustment?: number | null;
}): { subTotal: number; discountTotal: number; taxTotal: number; total: number } {
  let subTotal = 0;
  let taxTotal = 0;
  let discountTotal = 0;
  for (const line of values.items) {
    const gross = (Number(line.quantity) || 0) * (Number(line.rate) || 0);
    const lineDiscount = values.discountMode === 'item' ? gross * ((Number(line.discountPercent) || 0) / 100) : 0;
    const net = gross - lineDiscount;
    subTotal += net;
    discountTotal += lineDiscount;
    taxTotal += net * ((Number(line.taxPercent) || 0) / 100);
  }
  if (values.discountMode === 'entity') {
    const d = Number(values.discountValue) || 0;
    const entityDiscount = values.discountIsPercent ? subTotal * (d / 100) : d;
    discountTotal += entityDiscount;
    const ratio = subTotal > 0 ? (subTotal - entityDiscount) / subTotal : 1;
    subTotal -= entityDiscount;
    taxTotal *= ratio;
  }
  const total = subTotal + taxTotal + (Number(values.shippingCharge) || 0) + (Number(values.adjustment) || 0);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { subTotal: r(subTotal), discountTotal: r(discountTotal), taxTotal: r(taxTotal), total: r(total) };
}

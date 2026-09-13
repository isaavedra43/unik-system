/**
 * quotes-ai-adapter.ts — Ready-to-wrap surface for the AI assistant and the
 * inbox copilot. NOT registered as tools yet (by design: the AI integration is
 * a later step). When wiring it, create `src/modules/ai/tools/quotes-tools.ts`
 * with `registerTool()` entries that call these functions, and add
 * `import './quotes-tools';` to `src/modules/ai/tools/index.ts`.
 *
 * Suggested tools:
 *   - queryQuotes            → effect 'read',           permission 'quotes.view'
 *   - searchQuoteCustomers   → effect 'read',           permission 'quotes.view'
 *   - searchQuoteProducts    → effect 'read',           permission 'quotes.view'
 *   - previewQuote           → effect 'draft',          permission 'quotes.create'   (no Zoho call)
 *   - createQuote            → effect 'business_write', permission 'quotes.create'   (asks approval)
 *   - updateQuote            → effect 'business_write', permission 'quotes.edit'
 *   - getQuotePdf            → effect 'draft',          permission 'quotes.view'     (stores Zoho PDF as AiArtifact)
 *
 * All writes go through quotes-write-service so the AI can never bypass the
 * idempotency ledger, the optimistic lock or the "Zoho is the source of truth" rule.
 */

import { randomUUID } from 'node:crypto';
import {
  getQuotesWorkspace,
  getQuoteById,
  searchCustomersForQuote,
  searchProductsForQuote,
  type QuotesListResult,
  type QuoteDetail,
  type CustomerLookupRow,
  type ProductLookupRow,
} from './quotes-service';
import { createQuote, updateQuote, getQuotePdfFromZoho } from './quotes-write-service';
import { estimateTotals, quoteFormInputSchema, type QuoteFormInput } from './quotes-form-schema';

export interface AiActor { id: string }

export async function aiQueryQuotes(rawQuery: unknown, actor?: AiActor): Promise<QuotesListResult> {
  return getQuotesWorkspace(rawQuery, actor?.id ?? null);
}

export async function aiGetQuote(quoteId: string): Promise<QuoteDetail | null> {
  return getQuoteById(quoteId);
}

export async function aiSearchCustomers(search: string, limit = 10): Promise<CustomerLookupRow[]> {
  return searchCustomersForQuote(search, limit);
}

export async function aiSearchProducts(search: string, limit = 10): Promise<ProductLookupRow[]> {
  return searchProductsForQuote(search, limit);
}

/** Validates + computes a preview without touching Zoho. Ideal for the approval step. */
export function aiPreviewQuote(input: Omit<QuoteFormInput, 'requestKey'> & { requestKey?: string }) {
  const values = quoteFormInputSchema.parse({ ...input, requestKey: input.requestKey ?? randomUUID() });
  const totals = estimateTotals({
    items: values.items.map((i) => ({ quantity: i.quantity, rate: i.rate, discountPercent: i.discountPercent ?? null })),
    discountMode: values.discountMode,
    discountValue: values.discountValue ?? null,
    discountIsPercent: values.discountIsPercent,
    shippingCharge: values.shippingCharge ?? null,
    adjustment: values.adjustment ?? null,
  });
  return { values, totals };
}

/** Creates the quote in Zoho (idempotent by requestKey). */
export async function aiCreateQuote(actor: AiActor, input: Omit<QuoteFormInput, 'requestKey'> & { requestKey?: string }): Promise<QuoteDetail> {
  return createQuote(actor, { ...input, requestKey: input.requestKey ?? randomUUID() });
}

export async function aiUpdateQuote(actor: AiActor, quoteId: string, input: QuoteFormInput): Promise<QuoteDetail> {
  return updateQuote(actor, quoteId, input);
}

/** Returns the official Zoho PDF bytes; the tool layer stores them via storeArtifactFile. */
export async function aiGetQuotePdf(quoteId: string): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  return getQuotePdfFromZoho(quoteId);
}

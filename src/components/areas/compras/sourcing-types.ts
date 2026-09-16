/**
 * Shapes the Compras client components read from the area APIs.
 *
 * They mirror the JSON of `purchases-dto.ts` but are declared here on purpose:
 * that module reaches `purchases-helpers.ts`, which imports the Prisma runtime
 * and must never be bundled into the browser. Only the fields the UI actually
 * uses are declared, so an extra field on the server never breaks the client.
 *
 * Decimals travel as strings (never floats) and dates as ISO strings.
 */

export interface PriceSnippetView {
  text: string;
  price: number | null;
  currency: string | null;
  unit: string | null;
  url: string | null;
}

export interface EvidenceEntryView {
  url: string;
  fetchedAt: string;
  objectId: string | null;
  sha256: string | null;
}

export interface SourcingCandidateView {
  id: string;
  searchId: string | null;
  name: string;
  domain: string | null;
  url: string | null;
  phone: string | null;
  email: string | null;
  location: string | null;
  productsSummary: string | null;
  priceSnippets: PriceSnippetView[];
  /** Decimal 0–1 as a string, or null when the provider gave no confidence. */
  confidence: string | null;
  evidence: EvidenceEntryView[];
  status: string;
  statusLabel: string;
  supplierId: string | null;
  isKnownSupplier: boolean;
  lastFetchedAt: string | null;
  updatedAt: string;
}

export interface SourcingSearchView {
  id: string;
  queryText: string;
  providerKey: string;
  providerLabel: string;
  status: string;
  resultCount: number;
  costUnits: number;
  error: string | null;
  executedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface SourcingConfigView {
  enabled: boolean;
  dailyBudgetUnits: number;
  remainingBudget: number;
  allowedHosts: number;
  cacheTtlDays: number;
  rfqDefaultDueDays: number;
}

export interface SourcingLabData {
  searches: SourcingSearchView[];
  candidates: SourcingCandidateView[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
  config: SourcingConfigView;
}

export interface SupplierListItemView {
  id: string;
  number: string;
  name: string;
  status: string;
  statusLabel: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  paymentModeLabel: string;
  leadTimeDaysDefault: number | null;
  rating: { overall: string | null };
  productsCount: number;
}

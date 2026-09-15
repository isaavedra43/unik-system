/**
 * Deduplication of the Sourcing Lab (plan 6.1, `sourcing-dedupe.ts`).
 *
 * A company found twice (two searches, a search and a catalog page, "Acme,
 * S.A. de C.V." and "ACME") must be one `SourcingCandidate`, and a candidate
 * that is already a `Supplier` of UNIK or a Zoho vendor (`Contact`) must say
 * so instead of looking new.
 *
 * Identity strength: web domain > phone > normalized name. Generic mail
 * domains (gmail, hotmail…) never identify a company.
 *
 * Pure module.
 */

const LEGAL_SUFFIXES = [
  'sa de cv',
  'sapi de cv',
  'sab de cv',
  's de rl de cv',
  's de rl',
  'sc',
  'sa',
  'sapi',
  'inc',
  'llc',
  'ltd',
  'sas',
  'srl',
  'cv',
];

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'the', 'and']);

export const GENERIC_MAIL_DOMAINS = new Set([
  'gmail.com',
  'hotmail.com',
  'hotmail.es',
  'outlook.com',
  'outlook.es',
  'live.com',
  'live.com.mx',
  'yahoo.com',
  'yahoo.com.mx',
  'icloud.com',
  'me.com',
  'prodigy.net.mx',
  'aol.com',
  'msn.com',
  'protonmail.com',
]);

/** Directory/marketplace hosts that list many companies: never the identity of one. */
export const DIRECTORY_DOMAINS = new Set([
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'mercadolibre.com.mx',
  'amazon.com.mx',
  'google.com',
  'maps.google.com',
  'youtube.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'seccionamarilla.com.mx',
  'yelp.com',
]);

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** "Acme Materiales, S.A. de C.V." → "acme materiales". */
export function normalizeCompanyName(name: string | null | undefined): string {
  let text = stripAccents(String(name ?? ''))
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[.,]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let changed = true;
  while (changed && text) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (text === suffix) break;
      if (text.endsWith(` ${suffix}`)) {
        text = text.slice(0, -suffix.length - 1).trim();
        changed = true;
      }
    }
  }
  return text
    .split(' ')
    .filter((word) => word && !STOPWORDS.has(word))
    .join(' ');
}

/** Host of a URL/host/e-mail without `www.`; null for generic mail or directory domains. */
export function extractDomain(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  if (raw.includes('@') && !raw.includes('/')) {
    host = raw.split('@').pop() ?? '';
  } else {
    try {
      host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (GENERIC_MAIL_DOMAINS.has(host) || DIRECTORY_DOMAINS.has(host)) return null;
  for (const directory of DIRECTORY_DOMAINS) {
    if (host.endsWith(`.${directory}`)) return null;
  }
  return host;
}

/** Mexican phone as 10 digits (drops +52 / 52 / 521 / 01); other lengths 8–15 keep their digits; null otherwise. */
export function normalizePhone(value: string | null | undefined): string | null {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 13 && digits.startsWith('521')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('52')) digits = digits.slice(2);
  else if (digits.length === 12 && digits.startsWith('01')) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export interface CandidateIdentity {
  name: string;
  url?: string | null;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface NormalizedIdentity {
  name: string;
  domain: string | null;
  phone: string | null;
}

export function identityOf(candidate: CandidateIdentity): NormalizedIdentity {
  return {
    name: normalizeCompanyName(candidate.name),
    domain:
      extractDomain(candidate.domain) ?? extractDomain(candidate.url) ?? extractDomain(candidate.email),
    phone: normalizePhone(candidate.phone),
  };
}

/** Stable key of the strongest identity: `dom:{domain}` > `tel:{phone}` > `nom:{name}`. */
export function candidateDedupeKey(candidate: CandidateIdentity): string {
  const id = identityOf(candidate);
  if (id.domain) return `dom:${id.domain}`;
  if (id.phone) return `tel:${id.phone}`;
  return `nom:${id.name || 'sin-nombre'}`.slice(0, 190);
}

export interface ExistingCandidateRef extends CandidateIdentity {
  id: string;
  dedupeKey: string;
}

/** Existing candidate for the same company (same key, domain or phone). */
export function findMatchingCandidate<T extends ExistingCandidateRef>(
  candidate: CandidateIdentity,
  existing: readonly T[]
): T | null {
  const key = candidateDedupeKey(candidate);
  const id = identityOf(candidate);
  return (
    existing.find((row) => row.dedupeKey === key) ??
    existing.find((row) => {
      const other = identityOf(row);
      if (id.domain && other.domain === id.domain) return true;
      if (id.phone && other.phone === id.phone) return true;
      return false;
    }) ??
    null
  );
}

export interface ExistingSupplierRef {
  id: string;
  name: string;
  legalName?: string | null;
  website?: string | null;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  channels?: ReadonlyArray<{ type: string; value: string }> | null;
}

export interface ExistingVendorRef {
  zohoContactId: string;
  contactName?: string | null;
  companyName?: string | null;
  website?: string | null;
  primaryPhone?: string | null;
  mobile?: string | null;
  primaryEmail?: string | null;
}

export type IdentityMatchReason = 'domain' | 'phone' | 'name';

function matchIdentity(
  id: NormalizedIdentity,
  other: { names: string[]; domains: (string | null)[]; phones: (string | null)[] }
): IdentityMatchReason | null {
  if (id.domain && other.domains.includes(id.domain)) return 'domain';
  if (id.phone && other.phones.includes(id.phone)) return 'phone';
  if (id.name && id.name.length >= 4 && other.names.includes(id.name)) return 'name';
  return null;
}

/** Supplier of UNIK that already is this candidate. */
export function matchExistingSupplier(
  candidate: CandidateIdentity,
  suppliers: readonly ExistingSupplierRef[]
): { supplierId: string; reason: IdentityMatchReason } | null {
  const id = identityOf(candidate);
  for (const supplier of suppliers) {
    const channels = supplier.channels ?? [];
    const reason = matchIdentity(id, {
      names: [normalizeCompanyName(supplier.name), normalizeCompanyName(supplier.legalName)].filter(Boolean),
      domains: [
        extractDomain(supplier.website),
        extractDomain(supplier.primaryEmail),
        ...channels.filter((c) => c.type === 'web' || c.type === 'email').map((c) => extractDomain(c.value)),
      ],
      phones: [
        normalizePhone(supplier.primaryPhone),
        ...channels
          .filter((c) => ['whatsapp', 'sms', 'phone', 'telegram'].includes(c.type))
          .map((c) => normalizePhone(c.value)),
      ],
    });
    if (reason) return { supplierId: supplier.id, reason };
  }
  return null;
}

/** Zoho vendor (`Contact` with contactType vendor) that already is this candidate. */
export function matchVendorContact(
  candidate: CandidateIdentity,
  vendors: readonly ExistingVendorRef[]
): { zohoContactId: string; reason: IdentityMatchReason } | null {
  const id = identityOf(candidate);
  for (const vendor of vendors) {
    const reason = matchIdentity(id, {
      names: [normalizeCompanyName(vendor.companyName), normalizeCompanyName(vendor.contactName)].filter(Boolean),
      domains: [extractDomain(vendor.website), extractDomain(vendor.primaryEmail)],
      phones: [normalizePhone(vendor.primaryPhone), normalizePhone(vendor.mobile)],
    });
    if (reason) return { zohoContactId: vendor.zohoContactId, reason };
  }
  return null;
}

export interface PriceSnippet {
  text: string;
  price: number | null;
  currency: string | null;
  unit: string | null;
  url: string | null;
}

export interface EvidenceEntry {
  url: string;
  fetchedAt: string;
  objectId: string | null;
  sha256: string | null;
}

export interface CandidateDraft extends CandidateIdentity {
  location?: string | null;
  productsSummary?: string | null;
  priceSnippets: PriceSnippet[];
  evidence: EvidenceEntry[];
  confidence: number | null;
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string, max: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** Keeps the known fields, the highest confidence and the union of snippets/evidence (bounded). */
export function mergeCandidateDrafts(base: CandidateDraft, incoming: CandidateDraft): CandidateDraft {
  return {
    name: base.name || incoming.name,
    url: base.url ?? incoming.url ?? null,
    domain: base.domain ?? incoming.domain ?? null,
    email: base.email ?? incoming.email ?? null,
    phone: base.phone ?? incoming.phone ?? null,
    location: base.location ?? incoming.location ?? null,
    productsSummary:
      [base.productsSummary, incoming.productsSummary]
        .filter((text): text is string => Boolean(text && text.trim()))
        .filter((text, index, list) => list.indexOf(text) === index)
        .join(' · ')
        .slice(0, 1000) || null,
    priceSnippets: uniqueBy(
      [...base.priceSnippets, ...incoming.priceSnippets],
      (s) => `${s.text}|${s.price ?? ''}|${s.url ?? ''}`,
      20
    ),
    evidence: uniqueBy([...base.evidence, ...incoming.evidence], (e) => `${e.url}|${e.sha256 ?? ''}`, 20),
    confidence:
      base.confidence === null
        ? incoming.confidence
        : incoming.confidence === null
          ? base.confidence
          : Math.max(base.confidence, incoming.confidence),
  };
}

/** Collapses drafts of the same company inside one search result. */
export function dedupeCandidateDrafts(drafts: readonly CandidateDraft[]): Array<CandidateDraft & { dedupeKey: string }> {
  const out: Array<CandidateDraft & { dedupeKey: string }> = [];
  for (const draft of drafts) {
    if (!draft.name || !draft.name.trim()) continue;
    const match = findMatchingCandidate(
      draft,
      out.map((entry, index) => ({ ...entry, id: String(index) }))
    );
    if (match) {
      const index = Number(match.id);
      const merged = mergeCandidateDrafts(out[index], draft);
      out[index] = { ...merged, dedupeKey: candidateDedupeKey(merged) };
    } else {
      out.push({ ...draft, dedupeKey: candidateDedupeKey(draft) });
    }
  }
  return out;
}

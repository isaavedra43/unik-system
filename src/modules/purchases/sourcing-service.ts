import { Prisma, type SourcingCandidate } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { sourcingLabLink } from '@/modules/areas/area-links';
import { loadActiveCurrentUser } from '@/modules/auth/authorization';
import { isHostAllowed } from '@/modules/extensions/safe-fetch';
import { JOB_PRIORITY, type JobContext } from '@/modules/jobs/job-queue';
import {
  executeCommand,
  type CommandContext,
  type CommandResult,
} from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import { parseEvidence, parsePriceSnippets } from './purchases-dto';
import {
  D,
  actorUserId,
  addDays,
  asRecord,
  assertFoundRow,
  emitPurchases,
  parseChannels,
  publishBoard,
  purchaseNotificationCategory,
  recordActorId,
  truncate,
  type Db,
} from './purchases-helpers';
import { httpsUrl, idText, optionalText } from './purchases-schemas';
import {
  PURCHASES_COMMANDS,
  PURCHASES_EVENTS,
  PURCHASES_JOB_TYPES,
  PURCHASES_OBJECT_TYPES,
  SOURCING_PROVIDERS,
  SOURCING_PROVIDER_LABELS,
  labelOf,
} from './purchases-types';
import { getSourcingConfig, loadSourcingConfig } from './sourcing-config';
import {
  candidateDedupeKey,
  extractDomain,
  findMatchingCandidate,
  matchExistingSupplier,
  matchVendorContact,
  mergeCandidateDrafts,
  normalizeCompanyName,
  normalizePhone,
  type CandidateDraft,
} from './sourcing-dedupe';
import {
  chargeSourcingUnits,
  countSourcingSearch,
  releaseSourcingUnits,
  reserveSourcingUnits,
  sourcingDay,
  sourcingUnitsUsed,
} from './sourcing-budget';
import { runBraveSearch, runCatalogPages } from './sourcing-providers';
import {
  MAX_URLS_PER_SEARCH,
  budgetCheck,
  estimateSearchCost,
  normalizeSourcingQuery,
  sourcingQueryHash,
} from './sourcing-rules';
import type { SourcingProviderKey } from './purchases-types';

/**
 * Sourcing Lab searches (plan 6.1, `sourcing-service.ts`).
 *
 * - `purchases.sourcing.search`: validates hosts and the daily budget, answers
 *   a repeated search from its cache (same `queryHash`, not expired) WITHOUT
 *   spending, otherwise queues `purchases.sourcing_search` (progress on
 *   `job:{id}`).
 * - The job runs the provider and records the results with a system command:
 *   candidates deduplicated against the existing ones (key, domain, phone) and
 *   marked when they already are a Supplier or a Zoho vendor; evidence kept.
 * - Candidates move through `new → contacted → rfq_sent → quoted → approved`,
 *   can be rejected, and are promoted to suppliers (suppliers-service).
 */

const OBJ = PURCHASES_OBJECT_TYPES;
const EV = PURCHASES_EVENTS.sourcing;
const PENDING_STALE_MS = 15 * 60_000;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'purchases-sourcing', event, ...extra }));

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const sourcingSearchSchema = z.object({
  query: z.string().trim().min(3, 'Escribe qué buscas (3 caracteres o más)').max(200),
  providerKey: z.enum(SOURCING_PROVIDERS).default('brave_search'),
  urls: z.array(httpsUrl).max(MAX_URLS_PER_SEARCH).default([]),
  filters: z
    .object({
      maxResults: z.number().int().min(1).max(20).optional(),
      country: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/)
        .optional(),
    })
    .strict()
    .default({}),
  /** Runs again even when a cached result exists (spends budget). */
  refresh: z.boolean().default(false),
});
export type SourcingSearchInput = z.output<typeof sourcingSearchSchema>;

const nullableString = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => v ?? null);

export const candidateDraftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: nullableString(500),
  domain: nullableString(200),
  email: nullableString(200),
  phone: nullableString(40),
  location: nullableString(200),
  productsSummary: nullableString(1000),
  priceSnippets: z
    .array(
      z.object({
        text: z.string().max(400),
        price: z.number().nullable(),
        currency: z.string().max(3).nullable(),
        unit: z.string().max(40).nullable(),
        url: z.string().max(500).nullable(),
      })
    )
    .max(20)
    .default([]),
  evidence: z
    .array(
      z.object({
        url: z.string().max(500),
        fetchedAt: z.string().max(40),
        objectId: z.string().max(120).nullable(),
        sha256: z.string().max(80).nullable(),
      })
    )
    .max(20)
    .default([]),
  confidence: z.number().min(0).max(1).nullable(),
});

export const recordSourcingResultsSchema = z.object({
  searchId: idText,
  candidates: z.array(candidateDraftSchema).max(100),
  costUnits: z.number().int().min(0).max(1000),
  rawResultObjectId: idText.nullish(),
  error: optionalText(500),
});

export const candidateStatusSchema = z.object({
  candidateId: idText,
  status: z.enum(['new', 'contacted', 'approved', 'rejected']),
  note: optionalText(500),
});

// ---------------------------------------------------------------------------
// Request a search
// ---------------------------------------------------------------------------

export interface SourcingSearchData {
  searchId: string;
  cached: boolean;
  status: string;
  resultCount: number;
  estimatedCostUnits: number;
  jobQueued: boolean;
  remainingBudget: number;
}

export async function requestSourcingSearchInTx(
  tx: Db,
  input: SourcingSearchInput,
  ctx: CommandContext
): Promise<SourcingSearchData> {
  const config = await loadSourcingConfig(tx);
  if (!config.isEnabled)
    throw new OperationsError('module_disabled', 'El laboratorio de sourcing está desactivado');
  const query = normalizeSourcingQuery(input.query);
  const urls = [...new Set(input.urls)];
  if (input.providerKey === 'catalog_page') {
    if (urls.length === 0)
      throw new OperationsError(
        'invalid_payload',
        'Indica las páginas de catálogo que se van a revisar'
      );
    for (const url of urls) {
      const host = new URL(url).hostname.toLowerCase();
      if (!isHostAllowed(host, config.allowedHosts)) {
        throw new OperationsError(
          'forbidden',
          `El sitio ${host} no está autorizado en el laboratorio de sourcing`
        );
      }
    }
  }
  const filters = { ...input.filters, ...(urls.length > 0 ? { urls } : {}) };
  const queryHash = sourcingQueryHash({
    providerKey: input.providerKey,
    query,
    urls,
    filters: input.filters,
  });
  const usedToday = await sourcingUnitsUsed(tx, ctx.now);
  const remaining = budgetCheck(usedToday, 0, config.dailyBudgetUnits).remaining;
  const existing = await tx.sourcingSearch.findUnique({ where: { queryHash } });
  if (
    existing &&
    existing.status === 'done' &&
    existing.expiresAt &&
    existing.expiresAt.getTime() > ctx.now.getTime() &&
    !input.refresh
  ) {
    return {
      searchId: existing.id,
      cached: true,
      status: existing.status,
      resultCount: existing.resultCount,
      estimatedCostUnits: 0,
      jobQueued: false,
      remainingBudget: remaining,
    };
  }
  if (
    existing &&
    existing.status === 'pending' &&
    ctx.now.getTime() - existing.updatedAt.getTime() < PENDING_STALE_MS
  ) {
    return {
      searchId: existing.id,
      cached: false,
      status: 'pending',
      resultCount: existing.resultCount,
      estimatedCostUnits: 0,
      jobQueued: false,
      remainingBudget: remaining,
    };
  }
  const cost = estimateSearchCost(input.providerKey, urls.length);
  const budget = budgetCheck(usedToday, cost, config.dailyBudgetUnits);
  // The estimate (the most the provider can spend) is reserved atomically: concurrent searches never pass the day's budget.
  if (
    !budget.ok ||
    !(await reserveSourcingUnits(tx, {
      units: cost,
      dailyBudget: config.dailyBudgetUnits,
      at: ctx.now,
    }))
  ) {
    throw new OperationsError(
      'budget_exhausted',
      `Se agotó el presupuesto diario del laboratorio (${config.dailyBudgetUnits} unidades, quedan ${budget.remaining}); intenta mañana`,
      { httpStatus: 429 }
    );
  }
  const search = existing
    ? await tx.sourcingSearch.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          error: null,
          queryText: query,
          filters: filters as Prisma.InputJsonValue,
          executedAt: null,
          expiresAt: null,
        },
      })
    : await tx.sourcingSearch.create({
        data: {
          queryText: query,
          queryHash,
          providerKey: input.providerKey,
          filters: filters as Prisma.InputJsonValue,
          status: 'pending',
          createdByUserId: recordActorId(ctx),
        },
      });
  ctx.outbox({
    type: PURCHASES_JOB_TYPES.sourcingSearch,
    // The day the units were reserved travels with the job: it is what the job releases and charges against.
    payload: { searchId: search.id, reservedDay: sourcingDay(ctx.now) },
    dedupeKey: `${PURCHASES_JOB_TYPES.sourcingSearch}:${search.id}`,
    groupKey: 'purchases:sourcing',
    priority: JOB_PRIORITY.interactive,
    maxAttempts: 2,
    createdBy: actorUserId(ctx) ?? 'purchases',
  });
  emitPurchases(
    ctx,
    EV.requested,
    {
      searchId: search.id,
      query,
      providerKey: input.providerKey,
      urls: urls.length,
      estimatedCostUnits: cost,
      refresh: input.refresh,
    },
    { objectType: OBJ.search, objectId: search.id }
  );
  publishBoard(ctx, { searchId: search.id });
  return {
    searchId: search.id,
    cached: false,
    status: 'pending',
    resultCount: 0,
    estimatedCostUnits: cost,
    jobQueued: true,
    remainingBudget: budget.remaining - cost,
  };
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export async function runSourcingSearchJob(
  job: JobContext<unknown>,
  options: { now?: Date } = {}
): Promise<Record<string, unknown>> {
  const payload = z
    .object({ searchId: idText, reservedDay: z.string().optional() })
    .safeParse(job.payload);
  if (!payload.success) return { skipped: 'invalid_payload' };
  const search = await prisma.sourcingSearch.findUnique({ where: { id: payload.data.searchId } });
  if (!search) return { skipped: 'not_found' };
  if (search.status !== 'pending') return { skipped: `status_${search.status}` };
  const config = await getSourcingConfig();
  const actor = search.createdByUserId.includes(':')
    ? null
    : await loadActiveCurrentUser(search.createdByUserId);
  const now = options.now ?? new Date();
  const filtersForCost = asRecord(search.filters);
  const estimate = estimateSearchCost(
    search.providerKey as SourcingProviderKey,
    Array.isArray(filtersForCost.urls) ? filtersForCost.urls.length : 0
  );
  // The first attempt settles the reservation the command made: it must release and charge against the
  // day that was RESERVED (carried in the payload), not the day the provider happened to finish, or a
  // search that crosses UTC midnight never gives its units back. Jobs queued before this field existed
  // fall back to the row's last write, which is when the command reserved.
  let reservedDay = payload.data.reservedDay ?? sourcingDay(search.updatedAt);
  if (job.attempt > 1) {
    if (
      !(await reserveSourcingUnits(prisma, {
        units: estimate,
        dailyBudget: config.dailyBudgetUnits,
        at: now,
      }))
    ) {
      const result = await recordSourcingResults(
        {
          searchId: search.id,
          candidates: [],
          costUnits: 0,
          rawResultObjectId: null,
          error: `Se agotó el presupuesto diario del laboratorio (${config.dailyBudgetUnits} unidades); intenta mañana`,
        },
        `purchases:sourcing_results:${search.id}:${job.id}:${job.attempt}`,
        options.now
      );
      return { status: result.status, candidates: 0, costUnits: 0, error: 'budget_exhausted' };
    }
    reservedDay = sourcingDay(now);
  }
  const progress = async (percent: number, stage: string) => {
    await job.setProgress(percent);
    await publishRealtime(`job:${job.id}`, 'purchases.sourcing.progress', {
      searchId: search.id,
      percent,
      stage,
    }).catch(() => undefined);
  };
  await progress(5, `Buscando con ${labelOf(SOURCING_PROVIDER_LABELS, search.providerKey)}`);
  const filters = asRecord(search.filters);
  const context = {
    searchId: search.id,
    actor,
    createdBy: search.createdByUserId,
    config,
    onProgress: progress,
    signal: job.signal,
  };
  const outcome =
    search.providerKey === 'catalog_page'
      ? await runCatalogPages(
          search.queryText,
          Array.isArray(filters.urls) ? filters.urls.map(String) : [],
          context
        )
      : await runBraveSearch(
          search.queryText,
          {
            maxResults: typeof filters.maxResults === 'number' ? filters.maxResults : undefined,
            country: typeof filters.country === 'string' ? filters.country : undefined,
          },
          context
        );
  await progress(85, 'Guardando candidatos');
  const result = await recordSourcingResults(
    {
      searchId: search.id,
      candidates: outcome.candidates.slice(0, 100),
      costUnits: outcome.costUnits,
      rawResultObjectId: outcome.rawResultObjectId,
      error: outcome.error,
    },
    `purchases:sourcing_results:${search.id}:${job.id}:${job.attempt}`,
    options.now
  );
  try {
    await releaseSourcingUnits(prisma, { units: estimate - outcome.costUnits, day: reservedDay });
    await chargeSourcingUnits(outcome.costUnits - estimate, reservedDay);
    await countSourcingSearch(search.providerKey, reservedDay);
  } catch (err) {
    log('spend_record_failed', {
      searchId: search.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  await progress(
    100,
    outcome.error && outcome.candidates.length === 0 ? 'Sin resultados' : 'Listo'
  );
  if (result.status === 'rejected')
    throw new Error(result.message ?? 'No se pudieron guardar los resultados');
  return {
    status: result.status,
    candidates: outcome.candidates.length,
    costUnits: outcome.costUnits,
    error: outcome.error,
  };
}

export async function recordSourcingResults(
  payload: z.input<typeof recordSourcingResultsSchema>,
  commandId: string,
  now?: Date
): Promise<CommandResult<RecordSourcingResultsData>> {
  await import('./purchases-commands');
  return executeCommand<RecordSourcingResultsData>(
    {
      commandId: commandId.slice(0, 160),
      type: PURCHASES_COMMANDS.sourcingRecordResults,
      actor: { type: 'system', id: 'purchases.sourcing_search' },
      aggregate: { type: OBJ.search, id: payload.searchId },
      payload,
    },
    null,
    { now }
  );
}

// ---------------------------------------------------------------------------
// Record results
// ---------------------------------------------------------------------------

export interface RecordSourcingResultsData {
  searchId: string;
  status: string;
  candidateIds: string[];
  created: number;
  merged: number;
  knownSuppliers: number;
}

function draftFromRow(row: SourcingCandidate): CandidateDraft {
  return {
    name: row.name,
    url: row.url,
    domain: row.domain,
    email: row.email,
    phone: row.phone,
    location: row.location,
    productsSummary: row.productsSummary,
    priceSnippets: parsePriceSnippets(row.priceSnippets),
    evidence: parseEvidence(row.evidence),
    confidence: row.confidence === null ? null : Number(row.confidence.toString()),
  };
}

export async function recordSourcingResultsInTx(
  tx: Db,
  input: z.output<typeof recordSourcingResultsSchema>,
  ctx: CommandContext
): Promise<RecordSourcingResultsData> {
  const search = assertFoundRow(
    await tx.sourcingSearch.findUnique({ where: { id: input.searchId } }),
    'No se encontró la búsqueda'
  );
  const config = await loadSourcingConfig(tx);
  const drafts: CandidateDraft[] = input.candidates;
  const keys = [...new Set(drafts.map((d) => candidateDedupeKey(d)))];
  const domains = [
    ...new Set(
      drafts
        .map((d) => extractDomain(d.domain) ?? extractDomain(d.url))
        .filter((d): d is string => Boolean(d))
    ),
  ];
  const phones = [
    ...new Set(drafts.map((d) => normalizePhone(d.phone)).filter((p): p is string => Boolean(p))),
  ];
  const words = [
    ...new Set(
      drafts
        .map((d) => normalizeCompanyName(d.name).split(' ')[0])
        .filter((w) => w && w.length >= 3)
    ),
  ].slice(0, 50);

  const candidateWhere: Prisma.SourcingCandidateWhereInput[] = [];
  if (keys.length) candidateWhere.push({ dedupeKey: { in: keys } });
  if (domains.length) candidateWhere.push({ domain: { in: domains } });
  if (phones.length) candidateWhere.push({ phone: { in: phones } });
  const existing = candidateWhere.length
    ? await tx.sourcingCandidate.findMany({ where: { OR: candidateWhere }, take: 500 })
    : [];

  const identityWhere = (fields: {
    name: string;
    website: string;
    phone: string;
    email: string;
  }) => {
    const or: Record<string, unknown>[] = [];
    for (const word of words) or.push({ [fields.name]: { contains: word, mode: 'insensitive' } });
    for (const domain of domains) {
      or.push({ [fields.website]: { contains: domain, mode: 'insensitive' } });
      or.push({ [fields.email]: { contains: domain, mode: 'insensitive' } });
    }
    for (const phone of phones) or.push({ [fields.phone]: { contains: phone.slice(-8) } });
    return or;
  };
  const supplierOr = identityWhere({
    name: 'name',
    website: 'website',
    phone: 'primaryPhone',
    email: 'primaryEmail',
  });
  const suppliers = supplierOr.length
    ? await tx.supplier.findMany({
        where: { OR: supplierOr as Prisma.SupplierWhereInput[] },
        take: 500,
      })
    : [];
  const vendorOr = identityWhere({
    name: 'companyName',
    website: 'website',
    phone: 'primaryPhone',
    email: 'primaryEmail',
  });
  const vendors = vendorOr.length
    ? await tx.contact.findMany({
        where: { contactType: 'vendor', OR: vendorOr as Prisma.ContactWhereInput[] },
        take: 500,
        select: {
          zohoContactId: true,
          contactName: true,
          companyName: true,
          website: true,
          primaryPhone: true,
          mobile: true,
          primaryEmail: true,
        },
      })
    : [];
  const supplierRefs = suppliers.map((s) => ({ ...s, channels: parseChannels(s.channels) }));

  const candidateIds: string[] = [];
  let created = 0;
  let merged = 0;
  let knownSuppliers = 0;
  for (const draft of drafts) {
    const supplierMatch = matchExistingSupplier(draft, supplierRefs);
    const vendorMatch = supplierMatch ? null : matchVendorContact(draft, vendors);
    const supplierId =
      supplierMatch?.supplierId ??
      (vendorMatch
        ? (suppliers.find((s) => s.zohoContactId === vendorMatch.zohoContactId)?.id ?? null)
        : null);
    if (supplierId) knownSuppliers += 1;
    const match = findMatchingCandidate(draft, existing);
    const target = match ? mergeCandidateDrafts(draftFromRow(match), draft) : draft;
    const data = {
      searchId: search.id,
      domain: extractDomain(target.domain) ?? extractDomain(target.url),
      url: target.url ?? null,
      phone: target.phone ?? null,
      email: target.email ?? null,
      location: target.location ?? null,
      productsSummary: target.productsSummary ? truncate(target.productsSummary, 1000) : null,
      priceSnippets: target.priceSnippets as unknown as Prisma.InputJsonValue,
      evidence: target.evidence as unknown as Prisma.InputJsonValue,
      confidence: target.confidence === null ? null : D(target.confidence),
      lastFetchedAt: ctx.now,
    };
    if (match) {
      const updated = await tx.sourcingCandidate.update({
        where: { id: match.id },
        data: { ...data, supplierId: match.supplierId ?? supplierId, version: { increment: 1 } },
      });
      const index = existing.findIndex((row) => row.id === match.id);
      if (index >= 0) existing[index] = updated;
      candidateIds.push(updated.id);
      merged += 1;
      continue;
    }
    const dedupeKey = candidateDedupeKey(draft);
    const [inserted] = await tx.sourcingCandidate.createManyAndReturn({
      data: [{ ...data, dedupeKey, name: draft.name, status: 'new', supplierId }],
      skipDuplicates: true,
    });
    if (inserted) {
      existing.push(inserted);
      candidateIds.push(inserted.id);
      created += 1;
      continue;
    }
    const winner = await tx.sourcingCandidate.findUnique({ where: { dedupeKey } });
    if (winner) {
      const mergedDraft = mergeCandidateDrafts(draftFromRow(winner), draft);
      const updated = await tx.sourcingCandidate.update({
        where: { id: winner.id },
        data: {
          searchId: search.id,
          priceSnippets: mergedDraft.priceSnippets as unknown as Prisma.InputJsonValue,
          evidence: mergedDraft.evidence as unknown as Prisma.InputJsonValue,
          lastFetchedAt: ctx.now,
          supplierId: winner.supplierId ?? supplierId,
          version: { increment: 1 },
        },
      });
      existing.push(updated);
      candidateIds.push(updated.id);
      merged += 1;
    }
  }
  const unique = [...new Set(candidateIds)];
  const failed = Boolean(input.error) && unique.length === 0;
  const status = failed ? 'failed' : 'done';
  await tx.sourcingSearch.update({
    where: { id: search.id },
    data: {
      status,
      resultCount: unique.length,
      costUnits: search.costUnits + input.costUnits,
      rawResultObjectId: input.rawResultObjectId ?? search.rawResultObjectId,
      error: input.error ?? null,
      executedAt: ctx.now,
      expiresAt: failed ? null : addDays(ctx.now, config.cacheTtlDays),
    },
  });
  emitPurchases(
    ctx,
    failed ? EV.failed : EV.completed,
    {
      searchId: search.id,
      query: search.queryText,
      status,
      candidates: unique.length,
      created,
      merged,
      knownSuppliers,
      costUnits: input.costUnits,
      error: input.error ?? null,
    },
    { objectType: OBJ.search, objectId: search.id }
  );
  if (!search.createdByUserId.includes(':')) {
    ctx.notify({
      userId: search.createdByUserId,
      category: purchaseNotificationCategory(),
      type: failed ? 'purchase_sourcing_failed' : 'purchase_sourcing_done',
      title: failed
        ? `No se pudo buscar "${truncate(search.queryText, 60)}"`
        : `Búsqueda lista: "${truncate(search.queryText, 60)}"`,
      body: failed
        ? (input.error ?? null)
        : `${unique.length} candidato(s)${knownSuppliers ? `, ${knownSuppliers} ya son proveedores` : ''}`,
      url: sourcingLabLink(search.id),
      entityType: OBJ.search,
      entityId: search.id,
    });
  }
  publishBoard(ctx, { searchId: search.id });
  return { searchId: search.id, status, candidateIds: unique, created, merged, knownSuppliers };
}

export async function setCandidateStatusInTx(
  tx: Db,
  input: z.output<typeof candidateStatusSchema>,
  ctx: CommandContext
): Promise<SourcingCandidate> {
  const candidate = assertFoundRow(
    await tx.sourcingCandidate.findUnique({ where: { id: input.candidateId } }),
    'No se encontró el candidato'
  );
  if (candidate.status === 'promoted') {
    throw new OperationsError('invalid_state', 'El candidato ya es proveedor');
  }
  const updated = await tx.sourcingCandidate.update({
    where: { id: candidate.id },
    data: { status: input.status },
  });
  emitPurchases(
    ctx,
    EV.candidateUpdated,
    {
      candidateId: candidate.id,
      status: input.status,
      previousStatus: candidate.status,
      note: input.note ?? null,
    },
    { objectType: OBJ.candidate, objectId: candidate.id }
  );
  publishBoard(ctx, { candidateId: candidate.id });
  return updated;
}

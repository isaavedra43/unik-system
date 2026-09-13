import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { ZohoApiError } from '@/modules/integrations/zoho/client';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import {
  createEstimate,
  updateEstimate,
  getEstimate,
  markEstimateStatus,
  emailEstimate,
  getEstimatePdf,
  type ZohoEstimateWriteInput,
  type ZohoEstimateLineItemInput,
} from '@/modules/integrations/zoho/estimates';
import { SOURCE, ESTIMATES_ENTITY_TYPE } from '@/modules/integrations/zoho/estimates-sync';
import {
  normalizeQuoteSnapshot,
  extractEstimatePayload,
  type EstimatePayload,
  type NormalizeQuoteOptions,
} from './quotes-normalizer';
import {
  quoteFormInputSchema,
  quoteEmailInputSchema,
  type QuoteFormInput,
  type QuoteFormValues,
  type QuoteStatusAction,
  type QuoteEmailInput,
} from './quotes-form-schema';
import { getQuoteById, type QuoteDetail } from './quotes-service';
import { isQuoteEditable, canMarkSent, canDecide } from './quotes-helpers';

/**
 * Quotes write service — the ONLY path that mutates quotes.
 *
 * Rules:
 * 1. Zoho Books is the source of truth. We never compute folios or totals:
 *    the estimate is created/updated in Zoho first, and the Zoho response is
 *    stored as an IntegrationSnapshot and normalized with the same code the
 *    background sync uses. What you see locally is exactly what Zoho has.
 * 2. Folios cannot collide: `estimate_number` is never sent, Zoho assigns it
 *    atomically from the organization sequence (same as the Zoho UI).
 * 3. Idempotency: every create/clone carries a `requestKey`. A retry of the
 *    same key returns the quote created the first time instead of creating a
 *    second estimate.
 * 4. Edits are optimistic-locked against Zoho's last_modified_time so two
 *    people (Zoho UI + UNIK) never overwrite each other silently.
 * 5. Mock mode (ZOHO_BOOKS_MOCK=true) simulates Zoho locally so the UI can be
 *    exercised before credentials exist.
 */

export class QuoteWriteError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 400) {
    super(message);
    this.name = 'QuoteWriteError';
  }
}

export class QuoteConflictError extends QuoteWriteError {
  constructor(public readonly quote: QuoteDetail | null) {
    super('La cotización fue modificada en Zoho después de que la abriste. Se recargaron los datos; revisa y vuelve a guardar.', 'CONFLICT', 409);
    this.name = 'QuoteConflictError';
  }
}

interface Actor { id: string }

const PENDING_REQUEST_TTL_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Zoho error → user message
// ---------------------------------------------------------------------------

function toWriteError(error: unknown, fallback: string): QuoteWriteError {
  if (error instanceof QuoteWriteError) return error;
  if (error instanceof ZohoApiError) {
    const detail = error.zohoMessage ? `Zoho: ${error.zohoMessage}` : fallback;
    if (error.httpStatus === 401 || error.zohoCode === 57) {
      return new QuoteWriteError('Zoho rechazó las credenciales o falta el scope ZohoBooks.estimates.ALL en el refresh token.', 'ZOHO_AUTH', 502);
    }
    if (error.httpStatus === 429) return new QuoteWriteError('Zoho limitó la cantidad de llamadas. Intenta de nuevo en un minuto.', 'ZOHO_RATE_LIMIT', 503);
    return new QuoteWriteError(detail, `ZOHO_${error.zohoCode ?? error.httpStatus ?? 'ERROR'}`, 502);
  }
  if (error instanceof Error && error.message.startsWith('Invalid or missing Zoho environment variables')) {
    return new QuoteWriteError('Zoho no está configurado (faltan variables ZOHO_*). Activa ZOHO_BOOKS_MOCK=true para probar sin credenciales.', 'ZOHO_NOT_CONFIGURED', 503);
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new QuoteWriteError('Zoho no respondió a tiempo. Verifica en Zoho antes de reintentar para no duplicar.', 'ZOHO_TIMEOUT', 504);
  }
  return new QuoteWriteError(fallback, 'UNEXPECTED', 500);
}

// ---------------------------------------------------------------------------
// Payload mapping (form → Zoho)
// ---------------------------------------------------------------------------

function formatDiscount(value: number | null | undefined, isPercent: boolean): number | string | undefined {
  if (value === null || value === undefined) return undefined;
  return isPercent ? `${value}%` : value;
}

async function buildZohoPayload(values: QuoteFormValues): Promise<ZohoEstimateWriteInput> {
  const customer = await prisma.contact.findUnique({ where: { zohoContactId: values.customerId }, select: { zohoContactId: true, contactType: true } });
  if (!customer) throw new QuoteWriteError('El cliente seleccionado no existe en el catálogo sincronizado de Zoho.', 'CUSTOMER_NOT_FOUND', 400);

  const itemIds = values.items.map((i) => i.itemId).filter((id): id is string => Boolean(id));
  const products = itemIds.length > 0
    ? await prisma.product.findMany({ where: { zohoItemId: { in: itemIds } }, select: { zohoItemId: true } })
    : [];
  const known = new Set(products.map((p) => p.zohoItemId));
  const missing = itemIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw new QuoteWriteError(`Productos no encontrados en el catálogo sincronizado: ${missing.join(', ')}`, 'PRODUCT_NOT_FOUND', 400);

  const lineItems: ZohoEstimateLineItemInput[] = values.items.map((line, index) => {
    const li: ZohoEstimateLineItemInput = {
      quantity: line.quantity,
      rate: line.rate,
      item_order: index + 1,
    };
    if (line.lineItemId) li.line_item_id = line.lineItemId;
    if (line.itemId) li.item_id = line.itemId;
    // Name/description always sent so free-text lines and overrides work.
    li.name = line.name;
    if (line.description) li.description = line.description;
    if (line.unit) li.unit = line.unit;
    if (line.taxId) li.tax_id = line.taxId;
    if (values.discountMode === 'item' && line.discountPercent) li.discount = `${line.discountPercent}%`;
    return li;
  });

  const payload: ZohoEstimateWriteInput = {
    customer_id: values.customerId,
    date: values.date,
    line_items: lineItems,
    is_discount_before_tax: values.isDiscountBeforeTax,
    discount_type: values.discountMode === 'item' ? 'item_level' : 'entity_level',
  };
  if (values.expiryDate) payload.expiry_date = values.expiryDate;
  if (values.referenceNumber) payload.reference_number = values.referenceNumber;
  if (values.salespersonId) payload.salesperson_id = values.salespersonId;
  if (values.salespersonName) payload.salesperson_name = values.salespersonName;
  if (values.notes !== undefined && values.notes !== null) payload.notes = values.notes;
  if (values.terms !== undefined && values.terms !== null) payload.terms = values.terms;
  if (values.discountMode === 'entity') payload.discount = formatDiscount(values.discountValue ?? 0, values.discountIsPercent);
  else payload.discount = 0;
  if (values.shippingCharge !== undefined && values.shippingCharge !== null) payload.shipping_charge = values.shippingCharge;
  if (values.adjustment !== undefined && values.adjustment !== null) payload.adjustment = values.adjustment;
  if (values.adjustmentDescription) payload.adjustment_description = values.adjustmentDescription;
  if (values.templateId) payload.template_id = values.templateId;
  return payload;
}

// ---------------------------------------------------------------------------
// Persistence: Zoho response → snapshot → normalizer
// ---------------------------------------------------------------------------

function extractEstimateOrThrow(raw: unknown): EstimatePayload {
  const extraction = extractEstimatePayload(raw);
  if (extraction.data === null) throw new QuoteWriteError(`Respuesta de Zoho no reconocida: ${extraction.error}`, 'ZOHO_SHAPE', 502);
  return extraction.data;
}

function remoteModifiedAtOf(estimate: EstimatePayload): Date {
  const d = estimate.last_modified_time ? new Date(estimate.last_modified_time) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date();
}

/**
 * Stores the estimate exactly as Zoho returned it and runs the normalizer.
 * Shared by create/update/status/email/refresh, so every path ends with the
 * same local representation the sync would produce.
 */
export async function persistEstimateFromZoho(
  rawResponse: unknown,
  options: NormalizeQuoteOptions
): Promise<{ quoteId: string; estimate: EstimatePayload }> {
  const estimate = extractEstimateOrThrow(rawResponse);
  const remoteModifiedAt = remoteModifiedAtOf(estimate);
  const now = new Date();

  const snapshot = await prisma.integrationSnapshot.upsert({
    where: {
      source_entityType_externalId_remoteModifiedAt: {
        source: SOURCE, entityType: ESTIMATES_ENTITY_TYPE, externalId: estimate.estimate_id, remoteModifiedAt,
      },
    },
    create: {
      source: SOURCE, entityType: ESTIMATES_ENTITY_TYPE, externalId: estimate.estimate_id, remoteModifiedAt,
      payload: { code: 0, estimate } as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
    },
    // A write always carries the freshest payload for this timestamp.
    update: { payload: { code: 0, estimate } as unknown as Prisma.InputJsonValue, fetchedAt: now, normalizedAt: null, normalizationVersion: 0, normalizationErrorCode: null },
  });

  await prisma.integrationEntityState.upsert({
    where: { source_entityType_externalId: { source: SOURCE, entityType: ESTIMATES_ENTITY_TYPE, externalId: estimate.estimate_id } },
    create: {
      source: SOURCE, entityType: ESTIMATES_ENTITY_TYPE, externalId: estimate.estimate_id, remoteModifiedAt,
      lastSyncedRemoteModifiedAt: remoteModifiedAt, needsSync: false, lastSeenAt: now, lastDetailFetchedAt: now,
    },
    update: { remoteModifiedAt, lastSyncedRemoteModifiedAt: remoteModifiedAt, needsSync: false, lastSeenAt: now, lastDetailFetchedAt: now },
  });

  const result = await normalizeQuoteSnapshot(
    { id: snapshot.id, source: SOURCE, entityType: ESTIMATES_ENTITY_TYPE, externalId: estimate.estimate_id, remoteModifiedAt, normalizationVersion: 0, payload: snapshot.payload },
    { ...options, force: true }
  );
  return { quoteId: result.quoteId, estimate };
}

// ---------------------------------------------------------------------------
// Mock Zoho (ZOHO_BOOKS_MOCK=true)
// ---------------------------------------------------------------------------

function round2(n: number): number { return Math.round(n * 100) / 100; }

async function mockEstimateResponse(
  payload: ZohoEstimateWriteInput,
  existing: EstimatePayload | null
): Promise<unknown> {
  const customer = await prisma.contact.findUnique({ where: { zohoContactId: payload.customer_id }, select: { contactName: true, companyName: true, currencyCode: true, billingAddress: true, billingCity: true, billingState: true, billingZip: true, billingCountry: true } });
  const itemIds = payload.line_items.map((l) => l.item_id).filter((v): v is string => Boolean(v));
  const products = itemIds.length > 0 ? await prisma.product.findMany({ where: { zohoItemId: { in: itemIds } }, select: { zohoItemId: true, sku: true, taxName: true, taxPercentage: true, unit: true } }) : [];
  const productMap = new Map(products.map((p) => [p.zohoItemId, p]));

  let subTotal = 0; let taxTotal = 0; let discountTotal = 0;
  const lineItems = payload.line_items.map((line, index) => {
    const product = line.item_id ? productMap.get(line.item_id) : undefined;
    const gross = line.quantity * line.rate;
    let lineDiscount = 0;
    if (typeof line.discount === 'string' && line.discount.endsWith('%')) lineDiscount = gross * (Number(line.discount.slice(0, -1)) / 100);
    else if (typeof line.discount === 'number') lineDiscount = line.discount;
    const net = gross - lineDiscount;
    const taxPct = product?.taxPercentage ? Number(product.taxPercentage) : 0;
    const taxAmount = net * (taxPct / 100);
    subTotal += net; discountTotal += lineDiscount; taxTotal += taxAmount;
    return {
      line_item_id: line.line_item_id ?? `${Date.now()}${index}`,
      item_id: line.item_id ?? null, sku: product?.sku ?? null, name: line.name ?? null, description: line.description ?? null,
      quantity: line.quantity, rate: line.rate, unit: line.unit ?? product?.unit ?? null,
      discount: line.discount ?? 0, discount_amount: round2(lineDiscount),
      tax_id: line.tax_id ?? null, tax_name: product?.taxName ?? null, tax_percentage: taxPct, tax_amount: round2(taxAmount),
      item_total: round2(net), item_order: index + 1,
    };
  });
  if (typeof payload.discount === 'string' && payload.discount.endsWith('%')) {
    const d = subTotal * (Number(payload.discount.slice(0, -1)) / 100);
    discountTotal += d; const ratio = subTotal > 0 ? (subTotal - d) / subTotal : 1; subTotal -= d; taxTotal *= ratio;
  } else if (typeof payload.discount === 'number' && payload.discount > 0) {
    const d = payload.discount; discountTotal += d; const ratio = subTotal > 0 ? (subTotal - d) / subTotal : 1; subTotal -= d; taxTotal *= ratio;
  }
  const total = subTotal + taxTotal + (payload.shipping_charge ?? 0) + (payload.adjustment ?? 0);

  let estimateId = existing?.estimate_id;
  let estimateNumber = existing?.estimate_number ?? null;
  if (!estimateId) {
    const count = await prisma.quote.count();
    estimateId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    estimateNumber = `MOCK-${String(count + 1).padStart(5, '0')}`;
  }
  const nowIso = new Date().toISOString();
  return {
    code: 0, message: 'mock',
    estimate: {
      estimate_id: estimateId, estimate_number: estimateNumber, reference_number: payload.reference_number ?? '',
      status: existing?.status ?? 'draft', date: payload.date, expiry_date: payload.expiry_date ?? '',
      customer_id: payload.customer_id, customer_name: customer?.contactName ?? customer?.companyName ?? 'Cliente',
      currency_code: customer?.currencyCode ?? 'MXN', exchange_rate: 1,
      discount: payload.discount ?? 0, is_discount_before_tax: payload.is_discount_before_tax ?? true,
      discount_type: payload.discount_type ?? 'entity_level', is_inclusive_tax: false,
      shipping_charge: payload.shipping_charge ?? 0, adjustment: payload.adjustment ?? 0,
      adjustment_description: payload.adjustment_description ?? '',
      sub_total: round2(subTotal), tax_total: round2(taxTotal), discount_total: round2(discountTotal), total: round2(total),
      salesperson_id: payload.salesperson_id ?? '', salesperson_name: payload.salesperson_name ?? '', template_id: payload.template_id ?? '', template_name: 'Mock',
      billing_address: { address: customer?.billingAddress ?? '', city: customer?.billingCity ?? '', state: customer?.billingState ?? '', zip: customer?.billingZip ?? '', country: customer?.billingCountry ?? '' },
      shipping_address: {},
      notes: payload.notes ?? '', terms: payload.terms ?? '',
      created_time: existing?.created_time ?? nowIso, last_modified_time: nowIso,
      line_items: lineItems,
    },
  };
}

// ---------------------------------------------------------------------------
// Idempotency ledger
// ---------------------------------------------------------------------------

async function claimWriteRequest(requestKey: string, operation: string, userId: string): Promise<{ replayQuoteId: string | null }> {
  try {
    await prisma.quoteWriteRequest.create({ data: { requestKey, operation, userId, status: 'pending' } });
    return { replayQuoteId: null };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
  }
  const existing = await prisma.quoteWriteRequest.findUnique({ where: { requestKey } });
  if (!existing) throw new QuoteWriteError('No se pudo registrar la solicitud.', 'REQUEST_RACE', 500);
  if (existing.status === 'completed' && existing.quoteId) return { replayQuoteId: existing.quoteId };
  if (existing.status === 'pending') {
    if (Date.now() - existing.createdAt.getTime() < PENDING_REQUEST_TTL_MS) {
      throw new QuoteWriteError('Esta cotización ya se está enviando a Zoho. Espera unos segundos y revisa la lista antes de reintentar.', 'REQUEST_IN_PROGRESS', 409);
    }
  }
  // failed or stale pending → allow retry under the same key
  await prisma.quoteWriteRequest.update({ where: { requestKey }, data: { status: 'pending', errorMessage: null, createdAt: new Date(), completedAt: null } });
  return { replayQuoteId: null };
}

async function completeWriteRequest(requestKey: string, quoteId: string, zohoEstimateId: string): Promise<void> {
  await prisma.quoteWriteRequest.update({ where: { requestKey }, data: { status: 'completed', quoteId, zohoEstimateId, completedAt: new Date() } });
}

async function failWriteRequest(requestKey: string, message: string): Promise<void> {
  try {
    await prisma.quoteWriteRequest.update({ where: { requestKey }, data: { status: 'failed', errorMessage: message.slice(0, 500), completedAt: new Date() } });
  } catch { /* ledger is best-effort on failure */ }
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export async function createQuote(actor: Actor, rawInput: QuoteFormInput): Promise<QuoteDetail> {
  const values = quoteFormInputSchema.parse(rawInput);
  const { replayQuoteId } = await claimWriteRequest(values.requestKey, 'create', actor.id);
  if (replayQuoteId) {
    const replay = await getQuoteById(replayQuoteId);
    if (replay) return replay;
  }

  try {
    const payload = await buildZohoPayload(values);
    const response = isZohoBooksMockEnabled()
      ? await mockEstimateResponse(payload, null)
      : await createEstimate(payload);
    const { quoteId, estimate } = await persistEstimateFromZoho(response, { actorUserId: actor.id, origin: 'created_in_unik', markCreatedInUnik: true });
    await completeWriteRequest(values.requestKey, quoteId, estimate.estimate_id);
    await recordAuditEvent({ actorUserId: actor.id, action: 'quotes.created', targetType: 'Quote', targetId: quoteId, metadata: { zohoEstimateId: estimate.estimate_id, estimateNumber: estimate.estimate_number ?? null, mock: isZohoBooksMockEnabled() } });
    const quote = await getQuoteById(quoteId);
    if (!quote) throw new QuoteWriteError('La cotización se creó en Zoho pero no se pudo leer localmente. Sincroniza la lista.', 'READ_BACK', 500);
    return quote;
  } catch (error) {
    const writeError = toWriteError(error, 'No se pudo crear la cotización en Zoho.');
    await failWriteRequest(values.requestKey, writeError.message);
    throw writeError;
  }
}

async function assertNoRemoteConflict(quote: QuoteDetail, expectedRemoteModifiedAt: string | null | undefined): Promise<EstimatePayload | null> {
  if (isZohoBooksMockEnabled()) return null;
  const fresh = extractEstimateOrThrow(await getEstimate(quote.zohoEstimateId));
  const remoteTs = remoteModifiedAtOf(fresh).getTime();
  const baseline = expectedRemoteModifiedAt ? new Date(expectedRemoteModifiedAt) : (quote.zohoLastModifiedTime ? new Date(quote.zohoLastModifiedTime) : null);
  const baselineTs = baseline && !Number.isNaN(baseline.getTime()) ? baseline.getTime() : null;
  if (baselineTs !== null && remoteTs > baselineTs) {
    const { quoteId } = await persistEstimateFromZoho({ code: 0, estimate: fresh }, { origin: 'refreshed_conflict' });
    throw new QuoteConflictError(await getQuoteById(quoteId));
  }
  return fresh;
}

export async function updateQuote(actor: Actor, quoteId: string, rawInput: QuoteFormInput): Promise<QuoteDetail> {
  const values = quoteFormInputSchema.parse(rawInput);
  const quote = await getQuoteById(quoteId);
  if (!quote) throw new QuoteWriteError('Cotización no encontrada.', 'NOT_FOUND', 404);
  if (!isQuoteEditable(quote.status)) throw new QuoteWriteError(`Zoho no permite editar cotizaciones en estado "${quote.status ?? '—'}".`, 'NOT_EDITABLE', 409);

  try {
    const fresh = await assertNoRemoteConflict(quote, values.expectedRemoteModifiedAt);
    if (fresh && !isQuoteEditable(fresh.status)) {
      await persistEstimateFromZoho({ code: 0, estimate: fresh }, { origin: 'refreshed_conflict' });
      throw new QuoteWriteError(`En Zoho la cotización ya está en estado "${fresh.status}", no se puede editar.`, 'NOT_EDITABLE', 409);
    }
    const payload = await buildZohoPayload(values);
    const response = isZohoBooksMockEnabled()
      ? await mockEstimateResponse(payload, extractEstimateOrThrow({ code: 0, estimate: { estimate_id: quote.zohoEstimateId, estimate_number: quote.estimateNumber, status: quote.status, created_time: quote.zohoCreatedTime } }))
      : await updateEstimate(quote.zohoEstimateId, payload);
    const { quoteId: persistedId, estimate } = await persistEstimateFromZoho(response, { actorUserId: actor.id, origin: 'edited_in_unik' });
    await recordAuditEvent({ actorUserId: actor.id, action: 'quotes.updated', targetType: 'Quote', targetId: persistedId, metadata: { zohoEstimateId: estimate.estimate_id, estimateNumber: estimate.estimate_number ?? null } });
    const updated = await getQuoteById(persistedId);
    if (!updated) throw new QuoteWriteError('No se pudo leer la cotización después de guardar.', 'READ_BACK', 500);
    return updated;
  } catch (error) {
    throw toWriteError(error, 'No se pudo actualizar la cotización en Zoho.');
  }
}

export async function changeQuoteStatus(actor: Actor, quoteId: string, action: QuoteStatusAction): Promise<QuoteDetail> {
  const quote = await getQuoteById(quoteId);
  if (!quote) throw new QuoteWriteError('Cotización no encontrada.', 'NOT_FOUND', 404);
  if (action === 'sent' && !canMarkSent(quote.status)) throw new QuoteWriteError('Solo las cotizaciones en borrador se pueden marcar como enviadas.', 'INVALID_TRANSITION', 409);
  if ((action === 'accepted' || action === 'declined') && !canDecide(quote.status)) throw new QuoteWriteError('Solo las cotizaciones enviadas (o vencidas) se pueden aceptar o rechazar.', 'INVALID_TRANSITION', 409);

  try {
    let response: unknown;
    if (isZohoBooksMockEnabled()) {
      response = await mockStatusResponse(quote, action);
    } else {
      await markEstimateStatus(quote.zohoEstimateId, action);
      response = await getEstimate(quote.zohoEstimateId);
    }
    const { quoteId: persistedId } = await persistEstimateFromZoho(response, { actorUserId: actor.id, origin: `status_${action}` });
    await recordAuditEvent({ actorUserId: actor.id, action: `quotes.status.${action}`, targetType: 'Quote', targetId: persistedId, metadata: { zohoEstimateId: quote.zohoEstimateId, estimateNumber: quote.estimateNumber } });
    const updated = await getQuoteById(persistedId);
    if (!updated) throw new QuoteWriteError('No se pudo leer la cotización después de cambiar el estado.', 'READ_BACK', 500);
    return updated;
  } catch (error) {
    throw toWriteError(error, 'No se pudo cambiar el estado en Zoho.');
  }
}

async function mockStatusResponse(quote: QuoteDetail, action: QuoteStatusAction): Promise<unknown> {
  const existing = await prisma.integrationSnapshot.findFirst({
    where: { source: SOURCE, entityType: ESTIMATES_ENTITY_TYPE, externalId: quote.zohoEstimateId },
    orderBy: { remoteModifiedAt: 'desc' },
  });
  const base = existing ? extractEstimateOrThrow(existing.payload) : null;
  if (!base) throw new QuoteWriteError('No hay snapshot local para simular el cambio de estado.', 'MOCK_NO_SNAPSHOT', 500);
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { status: action, last_modified_time: nowIso };
  if (action === 'accepted') patch.accepted_date = nowIso.slice(0, 10);
  if (action === 'declined') patch.declined_date = nowIso.slice(0, 10);
  return { code: 0, estimate: { ...base, ...patch } };
}

export async function emailQuote(actor: Actor, quoteId: string, rawInput: QuoteEmailInput): Promise<QuoteDetail> {
  const input = quoteEmailInputSchema.parse(rawInput);
  const quote = await getQuoteById(quoteId);
  if (!quote) throw new QuoteWriteError('Cotización no encontrada.', 'NOT_FOUND', 404);

  try {
    let response: unknown;
    if (isZohoBooksMockEnabled()) {
      response = quote.status === 'draft' ? await mockStatusResponse(quote, 'sent') : { code: 0, estimate: extractEstimateOrThrow((await prisma.integrationSnapshot.findFirst({ where: { source: SOURCE, entityType: ESTIMATES_ENTITY_TYPE, externalId: quote.zohoEstimateId }, orderBy: { remoteModifiedAt: 'desc' } }))?.payload) };
    } else {
      await emailEstimate(quote.zohoEstimateId, {
        to_mail_ids: input.to, cc_mail_ids: input.cc,
        subject: input.subject ?? undefined, body: input.body ?? undefined,
        send_from_org_email_id: true,
      });
      response = await getEstimate(quote.zohoEstimateId);
    }
    const { quoteId: persistedId } = await persistEstimateFromZoho(response, { actorUserId: actor.id, origin: 'emailed' });
    await recordAuditEvent({ actorUserId: actor.id, action: 'quotes.emailed', targetType: 'Quote', targetId: persistedId, metadata: { zohoEstimateId: quote.zohoEstimateId, estimateNumber: quote.estimateNumber, to: input.to, cc: input.cc } });
    const updated = await getQuoteById(persistedId);
    if (!updated) throw new QuoteWriteError('No se pudo leer la cotización después de enviarla.', 'READ_BACK', 500);
    return updated;
  } catch (error) {
    throw toWriteError(error, 'No se pudo enviar la cotización por correo desde Zoho.');
  }
}

/** Pulls the latest version from Zoho and normalizes it (manual refresh / conflict recovery). */
export async function refreshQuoteFromZoho(quoteId: string, actorUserId?: string | null): Promise<QuoteDetail> {
  const quote = await getQuoteById(quoteId);
  if (!quote) throw new QuoteWriteError('Cotización no encontrada.', 'NOT_FOUND', 404);
  if (isZohoBooksMockEnabled()) return quote;
  try {
    const response = await getEstimate(quote.zohoEstimateId);
    const { quoteId: persistedId } = await persistEstimateFromZoho(response, { actorUserId: actorUserId ?? null, origin: 'refreshed' });
    const updated = await getQuoteById(persistedId);
    return updated ?? quote;
  } catch (error) {
    throw toWriteError(error, 'No se pudo actualizar la cotización desde Zoho.');
  }
}

/** Builds a form input from an existing quote (used by clone and by the edit form). */
export function quoteToFormInput(quote: QuoteDetail, requestKey: string, options: { forClone?: boolean } = {}): QuoteFormInput {
  const today = new Date().toISOString().slice(0, 10);
  const isEntityDiscount = quote.discountType !== 'item_level' && Number(quote.discount ?? 0) > 0;
  const hasItemDiscount = quote.discountType === 'item_level' && quote.items.some((i) => i.discount && Number(String(i.discount).replace('%', '')) > 0);
  return {
    requestKey,
    customerId: quote.zohoCustomerId ?? '',
    date: options.forClone ? today : (quote.date?.slice(0, 10) ?? today),
    expiryDate: options.forClone ? null : (quote.expiryDate?.slice(0, 10) ?? null),
    referenceNumber: quote.referenceNumber,
    salespersonName: quote.salespersonName,
    salespersonId: quote.salespersonId,
    notes: quote.notes,
    terms: quote.terms,
    discountMode: isEntityDiscount ? 'entity' : hasItemDiscount ? 'item' : 'none',
    discountValue: isEntityDiscount ? Number(quote.discount) : null,
    discountIsPercent: true,
    isDiscountBeforeTax: quote.isDiscountBeforeTax ?? true,
    shippingCharge: quote.shippingCharge ? Number(quote.shippingCharge) : null,
    adjustment: quote.adjustment ? Number(quote.adjustment) : null,
    adjustmentDescription: quote.adjustmentDescription,
    templateId: quote.templateId,
    expectedRemoteModifiedAt: options.forClone ? null : quote.zohoLastModifiedTime,
    items: quote.items.map((i) => ({
      lineItemId: options.forClone ? null : i.zohoLineItemId,
      itemId: i.zohoItemId,
      name: i.name ?? '',
      description: i.description,
      quantity: Number(i.quantity ?? 1),
      rate: Number(i.rate ?? 0),
      unit: i.unit,
      discountPercent: i.discount ? Number(String(i.discount).replace('%', '')) || null : null,
      taxId: i.taxId,
    })),
  };
}

export async function cloneQuote(actor: Actor, quoteId: string, requestKey: string): Promise<QuoteDetail> {
  const source = await getQuoteById(quoteId);
  if (!source) throw new QuoteWriteError('Cotización no encontrada.', 'NOT_FOUND', 404);
  if (!source.zohoCustomerId) throw new QuoteWriteError('La cotización original no tiene cliente asociado.', 'NO_CUSTOMER', 400);
  const input = quoteToFormInput(source, requestKey, { forClone: true });
  input.referenceNumber = source.estimateNumber ? `Copia de ${source.estimateNumber}` : input.referenceNumber;
  const created = await createQuote(actor, input);
  await recordAuditEvent({ actorUserId: actor.id, action: 'quotes.cloned', targetType: 'Quote', targetId: created.id, metadata: { fromQuoteId: source.id, fromEstimateNumber: source.estimateNumber } });
  return created;
}

export async function getQuotePdfFromZoho(quoteId: string): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
  const quote = await getQuoteById(quoteId);
  if (!quote) throw new QuoteWriteError('Cotización no encontrada.', 'NOT_FOUND', 404);
  if (isZohoBooksMockEnabled()) throw new QuoteWriteError('El PDF oficial se genera en Zoho Books. Desactiva ZOHO_BOOKS_MOCK cuando las credenciales estén listas.', 'MOCK_NO_PDF', 503);
  try {
    const { bytes, contentType } = await getEstimatePdf(quote.zohoEstimateId);
    const filename = `${(quote.estimateNumber ?? quote.zohoEstimateId).replace(/[^\w.-]+/g, '_')}.pdf`;
    return { bytes, contentType: contentType.includes('pdf') ? 'application/pdf' : contentType, filename };
  } catch (error) {
    throw toWriteError(error, 'No se pudo obtener el PDF desde Zoho.');
  }
}

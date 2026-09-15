import { Prisma, type SalesOrderWriteRequest } from '@prisma/client';
import { ZodError, z } from 'zod';
import { prisma } from '@/lib/prisma';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { ZohoApiError } from '@/modules/integrations/zoho/client';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import { createSalesOrder, getSalesOrder } from '@/modules/integrations/zoho/sales-orders';
import {
  ENTITY_TYPE as SALES_ORDER_ENTITY_TYPE,
  SOURCE as ZOHO_SOURCE,
} from '@/modules/integrations/zoho/sales-orders-sync';
import {
  DEFAULT_PENDING_WRITE_TTL_MS,
  claimWriteRequest,
  ledgerErrorMessage,
  markWriteRequestFailed,
} from '@/modules/integrations/zoho/write-request-ledger';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { isOperationsError, registerCommand } from '@/modules/operations/commands';
import { httpStatusForCode } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import { QuoteWriteError, refreshQuoteFromZoho } from '@/modules/quotes/quotes-write-service';
import { normalizeSalesOrderSnapshot } from '@/modules/sales/sales-orders-normalizer';
import { CrmError, decimalString, isCrmError, runCrmSystemCommand } from './crm-helpers';
import { linkSalesOrderAsSystem, type LinkSalesOrderData } from './opportunities-service';
import { truncateText } from './opportunity-rules';
import {
  buildMockSalesOrderResponse,
  buildSalesOrderPayload,
  compareSalesOrderReadback,
  describeReadbackDifferences,
  expectedSalesOrderFromQuote,
  extractSalesOrderReadback,
  orderDateFor,
  quoteConversionBlocker,
  quoteFolio,
  readbackModifiedAt,
  type QuoteRow,
  type ReadbackDifference,
  type SalesOrderReadback,
} from './sales-order-rules';
import {
  ACTIVITY_REF_TYPES,
  CRM_AREA_KEY,
  CRM_COMMANDS,
  CRM_EVENTS,
  CRM_JOB_TYPES,
  CRM_LINK_CASES_DELAY_MS,
  CRM_OBJECT_TYPES,
  CRM_SALES_ORDER_READBACK_DELAY_MS,
} from './types';

/**
 * Accepted quote → sales order in Zoho (plan 6.5), the second writer of the
 * generic Zoho write ledger (`SalesOrderWriteRequest`, same rules as quotes).
 *
 * `createSalesOrderFromQuote(actor, {quoteId, requestKey, opportunityId?})`:
 * 1. `crm.create_sales_order` and the `crm` flag; the key is claimed (replay of a
 *    completed key, 409 while in flight, retry of a failed/stale one; the key
 *    cannot be reused for another quote or user).
 * 2. The quote is refreshed from Zoho (Zoho is the source of truth) and must be
 *    `accepted`; a quote already converted under another key, or with a synced
 *    order carrying its folio as reference, is rejected (never two orders).
 * 3. `POST /salesorders` (customer, reference = quote folio, salesperson, lines)
 *    or, with ZOHO_BOOKS_MOCK=true, a simulated order `SO-MOCK-00001`. Zoho's id
 *    is written to the ledger immediately: a retry after a local failure
 *    re-reads that order instead of creating another one.
 * 4. The response is stored as `IntegrationSnapshot` and normalized with the
 *    existing sales order normalizer (the same path as
 *    `persistEstimateFromZoho`), so the `SalesOrder` row fires the operations
 *    hook that opens the case.
 * 5. The opportunity is linked (created from the quote when there is none) and
 *    won, with an `order_created` activity; the ledger is completed; the job
 *    `crm.sales_order_readback` re-reads the order 5 seconds later.
 *
 * `runSalesOrderReadback(requestKey)` compares Zoho's copy with the quote
 * (customer, reference, lines, quantities, total ±1) and opens a
 * `sales_order_readback_mismatch` incident for Ventas when they differ or the
 * order is missing; with a real Zoho it also re-normalizes the fresh copy.
 */

export const SALES_ORDER_FROM_QUOTE_OPERATION = 'create_from_quote';
export const MOCK_SALES_ORDER_PREFIX = 'SO-MOCK-';
export const salesOrderReadbackDedupeKey = (zohoSalesOrderId: string) => `crm:so_readback:${zohoSalesOrderId}`;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'crm-sales-order-write', event, ...extra }));

export const createSalesOrderFromQuoteSchema = z.object({
  quoteId: z.string().trim().min(1).max(64),
  requestKey: z
    .string()
    .trim()
    .min(8)
    .max(160)
    .regex(/^[A-Za-z0-9:_.-]+$/, 'Llave de solicitud inválida'),
  opportunityId: z.string().trim().min(1).max(64).optional(),
});
export type CreateSalesOrderFromQuoteInput = z.input<typeof createSalesOrderFromQuoteSchema>;

export interface CreateSalesOrderFromQuoteResult {
  requestKey: string;
  salesOrderId: string;
  zohoSalesOrderId: string;
  salesOrderNumber: string | null;
  quoteId: string;
  estimateNumber: string | null;
  opportunityId: string | null;
  opportunityNumber: string | null;
  total: string | null;
  currencyCode: string | null;
  /** True when the key had already produced this order. */
  replayed: boolean;
  mock: boolean;
}

type QuoteWithItems = Prisma.QuoteGetPayload<{ include: { items: true } }>;

function loadQuote(quoteId: string): Promise<QuoteWithItems | null> {
  return prisma.quote.findUnique({ where: { id: quoteId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
}

function toCrmWriteError(error: unknown, fallback: string): CrmError {
  if (isCrmError(error)) return error;
  if (error instanceof QuoteWriteError) return new CrmError(error.message, error.code.toLowerCase(), error.status);
  if (isOperationsError(error)) return new CrmError(error.message, error.code, httpStatusForCode(error.code));
  if (error instanceof ZodError) {
    return new CrmError(`Datos inválidos: ${error.issues.map((issue) => issue.message).join('; ')}`, 'invalid_payload', 400);
  }
  if (error instanceof ZohoApiError) {
    if (error.httpStatus === 401 || error.zohoCode === 57) {
      return new CrmError(
        'Zoho rechazó las credenciales o falta el permiso ZohoInventory.salesorders.CREATE en el refresh token.',
        'zoho_auth',
        502
      );
    }
    if (error.httpStatus === 429) {
      return new CrmError('Zoho limitó la cantidad de llamadas. Intenta de nuevo en un minuto.', 'zoho_rate_limit', 503);
    }
    return new CrmError(
      error.zohoMessage ? `Zoho: ${error.zohoMessage}` : fallback,
      `zoho_${error.zohoCode ?? error.httpStatus ?? 'error'}`,
      502
    );
  }
  if (error instanceof Error && error.message.startsWith('Invalid or missing Zoho environment variables')) {
    return new CrmError(
      'Zoho no está configurado (faltan variables ZOHO_*). Activa ZOHO_BOOKS_MOCK=true para probar sin credenciales.',
      'zoho_not_configured',
      503
    );
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new CrmError(
      'Zoho no respondió a tiempo. Verifica en Zoho si la orden se creó antes de reintentar para no duplicarla.',
      'zoho_timeout',
      504
    );
  }
  return new CrmError(fallback, 'unexpected', 500);
}

// ---------------------------------------------------------------------------
// Zoho response → snapshot → normalizer
// ---------------------------------------------------------------------------

function rawSalesOrderObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const inner = 'salesorder' in obj ? obj.salesorder : obj;
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : null;
}

/**
 * Stores the sales order exactly as Zoho returned it and runs the existing
 * normalizer (the same representation the background sync produces).
 */
export async function persistSalesOrderFromZoho(
  raw: unknown,
  now: Date = new Date()
): Promise<{ salesOrderId: string; readback: SalesOrderReadback }> {
  const readback = extractSalesOrderReadback(raw);
  const salesorder = rawSalesOrderObject(raw);
  if (!readback || !salesorder) {
    throw new CrmError('Respuesta de Zoho no reconocida para la orden de venta', 'zoho_shape', 502);
  }
  const remoteModifiedAt = readbackModifiedAt(readback, now);
  const externalId = readback.salesorder_id;
  const payload = { code: 0, salesorder } as unknown as Prisma.InputJsonValue;
  const key = { source: ZOHO_SOURCE, entityType: SALES_ORDER_ENTITY_TYPE, externalId };
  const snapshot = await prisma.integrationSnapshot.upsert({
    where: { source_entityType_externalId_remoteModifiedAt: { ...key, remoteModifiedAt } },
    create: { ...key, remoteModifiedAt, payload, fetchedAt: now },
    update: { payload, fetchedAt: now, normalizedAt: null, normalizationVersion: 0, normalizationErrorCode: null },
  });
  await prisma.integrationEntityState.upsert({
    where: { source_entityType_externalId: key },
    create: {
      ...key,
      remoteModifiedAt,
      lastSyncedRemoteModifiedAt: remoteModifiedAt,
      needsSync: false,
      lastSeenAt: now,
      lastDetailFetchedAt: now,
    },
    update: { remoteModifiedAt, lastSyncedRemoteModifiedAt: remoteModifiedAt, needsSync: false, lastSeenAt: now, lastDetailFetchedAt: now },
  });
  const normalized = await normalizeSalesOrderSnapshot({
    id: snapshot.id,
    source: ZOHO_SOURCE,
    entityType: SALES_ORDER_ENTITY_TYPE,
    externalId,
    remoteModifiedAt,
    normalizationVersion: 0,
    payload: snapshot.payload,
  });
  return { salesOrderId: normalized.salesOrderId, readback };
}

// ---------------------------------------------------------------------------
// Mock Zoho (ZOHO_BOOKS_MOCK=true)
// ---------------------------------------------------------------------------

function mockSalesOrderId(): string {
  return `9${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
}

async function nextMockNumber(): Promise<string> {
  const count = await prisma.salesOrder.count({ where: { salesOrderNumber: { startsWith: MOCK_SALES_ORDER_PREFIX } } });
  return `${MOCK_SALES_ORDER_PREFIX}${String(count + 1).padStart(5, '0')}`;
}

async function latestSnapshotPayload(zohoSalesOrderId: string): Promise<Prisma.JsonValue | null> {
  const snapshot = await prisma.integrationSnapshot.findFirst({
    where: { source: ZOHO_SOURCE, entityType: SALES_ORDER_ENTITY_TYPE, externalId: zohoSalesOrderId },
    orderBy: { remoteModifiedAt: 'desc' },
    select: { payload: true },
  });
  return snapshot?.payload ?? null;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

async function buildResult(
  row: SalesOrderWriteRequest,
  flags: { replayed: boolean; mock: boolean }
): Promise<CreateSalesOrderFromQuoteResult> {
  const [order, quote, opportunity] = await Promise.all([
    row.salesOrderId
      ? prisma.salesOrder.findUnique({
          where: { id: row.salesOrderId },
          select: { salesOrderNumber: true, total: true, currencyCode: true },
        })
      : null,
    row.quoteId ? prisma.quote.findUnique({ where: { id: row.quoteId }, select: { estimateNumber: true } }) : null,
    row.opportunityId ? prisma.opportunity.findUnique({ where: { id: row.opportunityId }, select: { number: true } }) : null,
  ]);
  return {
    requestKey: row.requestKey,
    salesOrderId: row.salesOrderId ?? '',
    zohoSalesOrderId: row.zohoSalesOrderId ?? '',
    salesOrderNumber: order?.salesOrderNumber ?? null,
    quoteId: row.quoteId ?? '',
    estimateNumber: quote?.estimateNumber ?? null,
    opportunityId: row.opportunityId,
    opportunityNumber: opportunity?.number ?? null,
    total: decimalString(order?.total ?? null),
    currencyCode: order?.currencyCode ?? null,
    replayed: flags.replayed,
    mock: flags.mock,
  };
}

async function linkOpportunity(
  input: { opportunityId?: string; quoteId: string; salesOrderId: string; requestedByUserId: string; requestKey: string },
  now: Date
): Promise<LinkSalesOrderData | null> {
  try {
    const result = await linkSalesOrderAsSystem(
      {
        opportunityId: input.opportunityId,
        quoteId: input.quoteId,
        salesOrderId: input.salesOrderId,
        requestedByUserId: input.requestedByUserId,
        requestKey: input.requestKey,
        markWon: true,
        createIfMissing: true,
      },
      `crm:so_link:${input.requestKey}`,
      { now }
    );
    if (result.status === 'completed') return result.data ?? null;
    log('opportunity_link_rejected', { requestKey: input.requestKey, errorCode: result.errorCode ?? null, message: result.message ?? null });
    return null;
  } catch (error) {
    // Zoho already has the order: a CRM failure must not turn the write into an error.
    log('opportunity_link_failed', { requestKey: input.requestKey, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export interface SiblingWriteState {
  /** Zoho order already created for the quote by another request key (its local part failed). */
  zohoSalesOrderId: string | null;
  /** An older request of another key for the quote is still within its pending TTL. */
  inFlight: boolean;
}

/**
 * State of the other write requests of a quote, as seen by `requestKey`. Two
 * concurrent requests of different keys see each other's `pending` row; only
 * the older one (createdAt, then id) goes on, so exactly one POST happens.
 */
export async function siblingWriteState(quoteId: string, requestKey: string, now: Date): Promise<SiblingWriteState> {
  const [mine, others] = await Promise.all([
    prisma.salesOrderWriteRequest.findUnique({ where: { requestKey }, select: { id: true, createdAt: true } }),
    prisma.salesOrderWriteRequest.findMany({
      where: { quoteId, requestKey: { not: requestKey }, status: { not: 'completed' } },
      select: { id: true, status: true, createdAt: true, zohoSalesOrderId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const orphan = others.find((row) => row.zohoSalesOrderId);
  if (orphan) return { zohoSalesOrderId: orphan.zohoSalesOrderId, inFlight: false };
  const inFlight = others.some(
    (row) =>
      row.status === 'pending' &&
      now.getTime() - row.createdAt.getTime() < DEFAULT_PENDING_WRITE_TTL_MS &&
      (!mine ||
        row.createdAt.getTime() < mine.createdAt.getTime() ||
        (row.createdAt.getTime() === mine.createdAt.getTime() && row.id < mine.id))
  );
  return { zohoSalesOrderId: null, inFlight };
}

export async function createSalesOrderFromQuote(
  actor: CurrentUser,
  rawInput: CreateSalesOrderFromQuoteInput,
  options: { now?: Date } = {}
): Promise<CreateSalesOrderFromQuoteResult> {
  const parsed = createSalesOrderFromQuoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new CrmError(`Datos inválidos: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`, 'invalid_payload', 400);
  }
  const input = parsed.data;
  if (!hasPermission(actor, 'crm.create_sales_order')) {
    throw new CrmError('No tienes permiso para crear órdenes de venta en Zoho', 'forbidden', 403);
  }
  if (!(await isOpsFlagEnabled('crm'))) {
    throw new CrmError('El CRM está desactivado en la configuración de operaciones', 'module_disabled', 503);
  }
  const now = options.now ?? new Date();
  const mock = isZohoBooksMockEnabled();
  if (!mock && !(await isOpsFlagEnabled('crmSalesOrderWrite'))) {
    throw new CrmError(
      'Crear órdenes de venta en Zoho desde el CRM está apagado hasta validar los campos con la organización real: actívalo en la configuración de operaciones',
      'module_disabled',
      503
    );
  }
  const { requestKey } = input;

  const claim = await claimWriteRequest<SalesOrderWriteRequest>({
    insert: () =>
      prisma.salesOrderWriteRequest.create({
        data: {
          requestKey,
          operation: SALES_ORDER_FROM_QUOTE_OPERATION,
          userId: actor.id,
          quoteId: input.quoteId,
          opportunityId: input.opportunityId ?? null,
          status: 'pending',
        },
      }),
    find: () => prisma.salesOrderWriteRequest.findUnique({ where: { requestKey } }),
    // Conditional: two retries of the same key never both reach Zoho.
    reopen: async (row) =>
      (
        await prisma.salesOrderWriteRequest.updateMany({
          where: { requestKey, status: row.status, createdAt: row.createdAt },
          data: { status: 'pending', errorMessage: null, createdAt: new Date(), completedAt: null },
        })
      ).count === 1,
    isReplayable: (row) => row.status === 'completed' && Boolean(row.salesOrderId),
    assertSameRequest: (row) => {
      if (row.operation !== SALES_ORDER_FROM_QUOTE_OPERATION || row.quoteId !== input.quoteId || row.userId !== actor.id) {
        throw new CrmError('Esta llave de solicitud ya se usó para otra operación', 'request_key_conflict', 409);
      }
    },
    inProgressError: () =>
      new CrmError('Esta orden de venta ya se está creando en Zoho. Espera unos segundos antes de reintentar.', 'request_in_progress', 409),
    missingError: () => new CrmError('No se pudo registrar la solicitud.', 'request_race', 500),
  });
  if (claim.kind === 'replay') return buildResult(claim.row, { replayed: true, mock });
  let alreadyInZoho = claim.kind === 'retry' ? claim.previous.zohoSalesOrderId : null;

  try {
    if (!alreadyInZoho) {
      // Another key for the same quote: Zoho may already have its order (the local part failed), or its POST
      // may be in flight. Never POST a second order: reuse the first one, or let the oldest request win.
      const sibling = await siblingWriteState(input.quoteId, requestKey, now);
      if (sibling.zohoSalesOrderId) alreadyInZoho = sibling.zohoSalesOrderId;
      else if (sibling.inFlight) {
        throw new CrmError(
          'Esta cotización ya se está convirtiendo en orden de venta con otra solicitud. Espera unos segundos antes de reintentar.',
          'request_in_progress',
          409
        );
      }
    }
    let quote = await loadQuote(input.quoteId);
    if (!quote) throw new CrmError('No se encontró la cotización', 'not_found', 404);
    if (!mock && !alreadyInZoho) {
      await refreshQuoteFromZoho(quote.id, actor.id);
      quote = (await loadQuote(quote.id)) ?? quote;
    }
    const quoteRow: QuoteRow = quote;
    const folio = quoteFolio(quoteRow);
    if (!alreadyInZoho) {
      const blocker = quoteConversionBlocker(quoteRow);
      if (blocker) throw new CrmError(blocker, 'quote_not_accepted', 409);
      const converted = await prisma.salesOrderWriteRequest.findFirst({
        where: { quoteId: quote.id, status: 'completed', requestKey: { not: requestKey } },
        select: { id: true },
      });
      if (converted) {
        throw new CrmError(`La cotización ${folio} ya se convirtió en una orden de venta`, 'quote_already_converted', 409);
      }
      if (quote.estimateNumber && quote.zohoCustomerId) {
        const existingOrder = await prisma.salesOrder.findFirst({
          where: { referenceNumber: quote.estimateNumber, zohoCustomerId: quote.zohoCustomerId },
          select: { salesOrderNumber: true, zohoSalesOrderId: true },
        });
        if (existingOrder) {
          throw new CrmError(
            `Ya existe la orden ${existingOrder.salesOrderNumber ?? existingOrder.zohoSalesOrderId} con la referencia ${folio}; vincúlala a la oportunidad en lugar de crear otra`,
            'quote_already_converted',
            409
          );
        }
      }
    }

    const payload = buildSalesOrderPayload(quoteRow, orderDateFor(now));
    let response: unknown;
    if (alreadyInZoho) {
      response = mock
        ? ((await latestSnapshotPayload(alreadyInZoho)) ??
          buildMockSalesOrderResponse({ payload, quote: quoteRow, salesOrderId: alreadyInZoho, salesOrderNumber: await nextMockNumber(), now }))
        : await getSalesOrder(alreadyInZoho);
    } else if (mock) {
      response = buildMockSalesOrderResponse({
        payload,
        quote: quoteRow,
        salesOrderId: mockSalesOrderId(),
        salesOrderNumber: await nextMockNumber(),
        now,
      });
    } else {
      response = await createSalesOrder(payload);
    }
    const readback = extractSalesOrderReadback(response);
    if (!readback) throw new CrmError('Respuesta de Zoho no reconocida para la orden de venta', 'zoho_shape', 502);
    const zohoSalesOrderId = readback.salesorder_id;
    if (!alreadyInZoho) {
      // Before anything else can fail: a retry re-reads this order instead of creating another.
      await prisma.salesOrderWriteRequest.update({
        where: { requestKey },
        data: { zohoSalesOrderId, zohoEstimateId: quote.zohoEstimateId },
      });
    }

    const { salesOrderId } = await persistSalesOrderFromZoho(response, now);
    const link = await linkOpportunity(
      { opportunityId: input.opportunityId, quoteId: quote.id, salesOrderId, requestedByUserId: actor.id, requestKey },
      now
    );
    // The case may have started (and looked for opportunities) before the link above committed: re-link later.
    await enqueueJob({
      type: CRM_JOB_TYPES.linkCases,
      payload: { zohoSalesOrderId },
      runAt: new Date(now.getTime() + CRM_LINK_CASES_DELAY_MS),
      maxAttempts: 3,
      priority: JOB_PRIORITY.normal,
      dedupeKey: `${CRM_JOB_TYPES.linkCases}:${zohoSalesOrderId}`,
      createdBy: actor.id,
    }).catch((error: unknown) =>
      log('link_cases_enqueue_failed', { requestKey, message: error instanceof Error ? error.message : String(error) })
    );
    const completed = await prisma.salesOrderWriteRequest.update({
      where: { requestKey },
      data: {
        status: 'completed',
        salesOrderId,
        zohoSalesOrderId,
        zohoEstimateId: quote.zohoEstimateId,
        opportunityId: link?.opportunityId ?? input.opportunityId ?? null,
        errorMessage: null,
        completedAt: now,
      },
    });
    await enqueueJob({
      type: CRM_JOB_TYPES.salesOrderReadback,
      payload: { requestKey },
      runAt: new Date(now.getTime() + CRM_SALES_ORDER_READBACK_DELAY_MS),
      maxAttempts: 5,
      priority: JOB_PRIORITY.normal,
      dedupeKey: salesOrderReadbackDedupeKey(zohoSalesOrderId),
      createdBy: actor.id,
    }).catch((error: unknown) =>
      log('readback_enqueue_failed', { requestKey, message: error instanceof Error ? error.message : String(error) })
    );
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'crm.sales_order.created',
      targetType: 'SalesOrder',
      targetId: salesOrderId,
      metadata: {
        requestKey,
        zohoSalesOrderId,
        quoteId: quote.id,
        estimateNumber: quote.estimateNumber,
        opportunityId: completed.opportunityId,
        mock,
        retried: claim.kind === 'retry',
      },
    });
    return buildResult(completed, { replayed: false, mock });
  } catch (error) {
    const writeError = toCrmWriteError(error, 'No se pudo crear la orden de venta en Zoho.');
    await markWriteRequestFailed(() =>
      prisma.salesOrderWriteRequest.update({
        where: { requestKey },
        data: { status: 'failed', errorMessage: ledgerErrorMessage(writeError.message), completedAt: new Date() },
      })
    );
    throw writeError;
  }
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

const differenceValue = z.union([z.string(), z.number(), z.null()]);

const readbackMismatchSchema = z.object({
  requestKey: z.string().min(1).max(160),
  zohoSalesOrderId: z.string().min(1).max(40),
  salesOrderId: z.string().max(64).nullable(),
  quoteId: z.string().max(64).nullable(),
  opportunityId: z.string().max(64).nullable(),
  estimateNumber: z.string().max(80).nullable(),
  salesOrderNumber: z.string().max(80).nullable(),
  requestedByUserId: z.string().min(1).max(64),
  missing: z.boolean(),
  differences: z
    .array(
      z.object({
        field: z.string().max(40),
        label: z.string().max(120),
        expected: differenceValue,
        actual: differenceValue,
        line: z.number().int().optional(),
      })
    )
    .max(200),
});

registerCommand<z.output<typeof readbackMismatchSchema>, { incidentId: string; created: boolean }>(
  CRM_COMMANDS.salesOrderReadbackMismatch,
  {
    schema: readbackMismatchSchema,
    aggregate: 'none',
    actorTypes: ['system'],
    audit: 'always',
    async handler(tx, cmd, ctx) {
      const input = cmd.payload;
      const opCase = await tx.operationalCase.findFirst({
        where: { zohoSalesOrderId: input.zohoSalesOrderId },
        select: { id: true },
      });
      const owner = await tx.user.findUnique({ where: { id: input.requestedByUserId }, select: { isActive: true, isBot: true } });
      const folio = input.salesOrderNumber ?? input.zohoSalesOrderId;
      const summary = input.missing ? 'la orden no existe en Zoho' : describeReadbackDifferences(input.differences as ReadbackDifference[]);
      const title = input.missing
        ? `La orden ${folio} no se encontró en Zoho al releerla`
        : `La orden ${folio} en Zoho no coincide con la cotización ${input.estimateNumber ?? ''}`.trim();
      const { incident, created } = await ctx.openIncident({
        kind: 'sales_order_readback_mismatch',
        areaKey: CRM_AREA_KEY,
        title: truncateText(title, 200),
        dedupeKey: salesOrderReadbackDedupeKey(input.zohoSalesOrderId),
        severity: 'high',
        caseId: opCase?.id ?? null,
        ownerUserId: owner?.isActive && !owner.isBot ? input.requestedByUserId : null,
        detail: {
          requestKey: input.requestKey,
          zohoSalesOrderId: input.zohoSalesOrderId,
          salesOrderId: input.salesOrderId,
          quoteId: input.quoteId,
          estimateNumber: input.estimateNumber,
          missing: input.missing,
          differences: input.differences,
          summary,
        },
      });
      if (created && input.opportunityId) {
        const opportunity = await tx.opportunity.findUnique({ where: { id: input.opportunityId }, select: { id: true } });
        if (opportunity) {
          await tx.opportunityActivity.create({
            data: {
              opportunityId: opportunity.id,
              kind: 'note',
              summary: truncateText(`Zoho no confirmó la orden ${folio} tal como se pidió: ${summary}`, 1000),
              refType: input.salesOrderId ? ACTIVITY_REF_TYPES.salesOrder : null,
              refId: input.salesOrderId,
              payload: toOperationalJson({ incidentId: incident.id }),
              userId: null,
              at: ctx.now,
            },
          });
        }
      }
      ctx.emit(
        CRM_EVENTS.salesOrderReadbackMismatch,
        {
          requestKey: input.requestKey,
          zohoSalesOrderId: input.zohoSalesOrderId,
          incidentId: incident.id,
          missing: input.missing,
          differences: input.differences.length,
        },
        {
          areaKey: CRM_AREA_KEY,
          caseId: opCase?.id ?? null,
          objectType: CRM_OBJECT_TYPES.salesOrderWrite,
          objectId: input.requestKey,
        }
      );
      return { data: { incidentId: incident.id, created } };
    },
  }
);

export interface SalesOrderReadbackResult {
  status: 'ok' | 'mismatch' | 'skipped';
  reason?: string;
  zohoSalesOrderId?: string;
  differences?: ReadbackDifference[];
  incidentId?: string;
}

/** Job `crm.sales_order_readback`: re-reads and reconciles the order created from UNIK. */
export async function runSalesOrderReadback(requestKey: string, options: { now?: Date } = {}): Promise<SalesOrderReadbackResult> {
  const now = options.now ?? new Date();
  const row = await prisma.salesOrderWriteRequest.findUnique({ where: { requestKey } });
  if (!row || row.status !== 'completed' || !row.zohoSalesOrderId || !row.quoteId) {
    return { status: 'skipped', reason: 'not_completed' };
  }
  const quote = await loadQuote(row.quoteId);
  if (!quote) return { status: 'skipped', reason: 'quote_missing', zohoSalesOrderId: row.zohoSalesOrderId };

  const mock = isZohoBooksMockEnabled();
  let raw: unknown = null;
  if (mock) {
    raw = await latestSnapshotPayload(row.zohoSalesOrderId);
  } else {
    try {
      raw = await getSalesOrder(row.zohoSalesOrderId);
    } catch (error) {
      if (!(error instanceof ZohoApiError && error.httpStatus === 404)) throw error;
    }
  }
  const readback = raw ? extractSalesOrderReadback(raw) : null;
  if (readback && !mock) await persistSalesOrderFromZoho(raw, now);
  const differences = readback ? compareSalesOrderReadback(expectedSalesOrderFromQuote(quote), readback) : [];
  if (readback && differences.length === 0) {
    return { status: 'ok', zohoSalesOrderId: row.zohoSalesOrderId, differences };
  }

  const order = row.salesOrderId
    ? await prisma.salesOrder.findUnique({ where: { id: row.salesOrderId }, select: { salesOrderNumber: true } })
    : null;
  const result = await runCrmSystemCommand<{ incidentId: string; created: boolean }>(
    CRM_COMMANDS.salesOrderReadbackMismatch,
    { type: CRM_OBJECT_TYPES.salesOrderWrite, id: requestKey },
    {
      requestKey,
      zohoSalesOrderId: row.zohoSalesOrderId,
      salesOrderId: row.salesOrderId,
      quoteId: row.quoteId,
      opportunityId: row.opportunityId,
      estimateNumber: quote.estimateNumber,
      salesOrderNumber: order?.salesOrderNumber ?? readback?.salesorder_number ?? null,
      requestedByUserId: row.userId,
      missing: !readback,
      differences,
    },
    `crm:so_readback_mismatch:${row.zohoSalesOrderId}`,
    { now }
  );
  if (result.status !== 'completed') {
    throw new Error(`No se pudo registrar la discrepancia de la orden ${row.zohoSalesOrderId}: ${result.message ?? result.status}`);
  }
  log('readback_mismatch', { requestKey, zohoSalesOrderId: row.zohoSalesOrderId, differences: differences.length, missing: !readback });
  return { status: 'mismatch', zohoSalesOrderId: row.zohoSalesOrderId, differences, incidentId: result.data?.incidentId };
}

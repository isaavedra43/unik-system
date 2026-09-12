import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Prisma, type Quote } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { generatePdfReport, type PdfSection } from '@/modules/ai/generators/pdf-generator';
import { saveGeneratedFile } from '@/modules/storage/storage-service';
import { getStorageState, setStorageState } from '@/modules/storage/storage-settings-service';
import { createEstimate, getZohoBooksMode, type ZohoBooksMode } from './zoho-books-adapter';
import {
  applyScenario,
  computeQuoteContentHash,
  computeTotals,
  createQuoteSchema,
  DEFAULT_QUOTE_SETTINGS,
  parseStoredItems,
  QUOTE_SETTINGS_KEY,
  quoteSettingsSchema,
  toDecimal,
  updateQuoteSchema,
  type CreateQuoteInput,
  type QuoteItemInput,
  type QuoteScenario,
  type QuoteSettings,
  type QuoteStatus,
  type QuoteTotals,
  type UpdateQuoteInput,
} from './quotes-contract';
import './quotes-access';

/**
 * Quotes service — drafts, versioning, human approval bound to a content
 * hash, official creation in Zoho Books, commercial package (PDF) and
 * what-if scenarios.
 *
 * Rules:
 *  - Editing bumps `version`, recomputes `contentHash`, drops any previous
 *    approval and invalidates pending AI proposals that reference the quote.
 *  - `approveQuote` only succeeds when the hash the approver reviewed equals
 *    the current one. Nothing reaches Books without that human step.
 *  - A Books timeout leaves the quote in `pending_approval` with an explicit
 *    "verificar en Books" note: the estimate may exist remotely.
 */

export class QuoteError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'QuoteError';
  }
}

export interface QuoteDTO {
  id: string;
  number: string | null;
  customerName: string;
  contactId: string | null;
  zohoCustomerId: string | null;
  items: QuoteItemInput[];
  subtotal: string;
  tax: string;
  total: string;
  currency: string;
  status: QuoteStatus;
  version: number;
  contentHash: string | null;
  zohoEstimateId: string | null;
  documentId: string | null;
  proposalId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  syncedAt: string | null;
  invalidationReason: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function toQuoteDTO(quote: Quote): QuoteDTO {
  return {
    id: quote.id,
    number: quote.number,
    customerName: quote.customerName,
    contactId: quote.contactId,
    zohoCustomerId: quote.zohoCustomerId,
    items: parseStoredItems(quote.items),
    subtotal: toDecimal(quote.subtotal).toFixed(4),
    tax: toDecimal(quote.tax).toFixed(4),
    total: toDecimal(quote.total).toFixed(4),
    currency: quote.currency,
    status: quote.status as QuoteStatus,
    version: quote.version,
    contentHash: quote.contentHash,
    zohoEstimateId: quote.zohoEstimateId,
    documentId: quote.documentId,
    proposalId: quote.proposalId,
    approvedBy: quote.approvedBy,
    approvedAt: quote.approvedAt?.toISOString() ?? null,
    syncedAt: quote.syncedAt?.toISOString() ?? null,
    invalidationReason: quote.invalidationReason,
    notes: quote.notes,
    createdBy: quote.createdBy,
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Authorization (deny by default)                                    */
/* ------------------------------------------------------------------ */

function canUse(actor: CurrentUser): boolean {
  return hasPermission(actor, 'quotes.use') || hasPermission(actor, 'quotes.approve');
}

function assertUse(actor: CurrentUser): void {
  if (!canUse(actor)) throw new QuoteError('Sin permiso para cotizaciones', 403);
}

function assertApprover(actor: CurrentUser): void {
  if (!hasPermission(actor, 'quotes.approve')) {
    throw new QuoteError('Sin permiso para aprobar cotizaciones', 403);
  }
}

async function loadQuote(id: string): Promise<Quote> {
  const quote = await prisma.quote.findUnique({ where: { id } });
  if (!quote) throw new QuoteError('Cotización no encontrada', 404);
  return quote;
}

function contentOf(quote: Quote, items: QuoteItemInput[]) {
  return {
    customerName: quote.customerName,
    contactId: quote.contactId,
    zohoCustomerId: quote.zohoCustomerId,
    currency: quote.currency,
    items,
    notes: quote.notes,
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export async function getQuoteSettings(): Promise<QuoteSettings> {
  const stored = await getStorageState<Partial<QuoteSettings>>(QUOTE_SETTINGS_KEY);
  const parsed = quoteSettingsSchema.safeParse({ ...DEFAULT_QUOTE_SETTINGS, ...(stored ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_QUOTE_SETTINGS;
}

export async function updateQuoteSettings(
  actor: CurrentUser,
  patch: Partial<QuoteSettings>
): Promise<QuoteSettings> {
  assertApprover(actor);
  const current = await getQuoteSettings();
  const next = quoteSettingsSchema.parse({ ...current, ...patch });
  await setStorageState(QUOTE_SETTINGS_KEY, next);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'quotes.settings_updated',
    targetType: 'quote_settings',
    targetId: QUOTE_SETTINGS_KEY,
  });
  return next;
}

export function getBooksMode(): ZohoBooksMode {
  return getZohoBooksMode();
}

/* ------------------------------------------------------------------ */
/* Queries                                                            */
/* ------------------------------------------------------------------ */

export async function listQuotes(
  actor: CurrentUser,
  options: { status?: string; search?: string; limit?: number } = {}
): Promise<QuoteDTO[]> {
  assertUse(actor);
  const rows = await prisma.quote.findMany({
    where: {
      ...(options.status ? { status: options.status } : {}),
      ...(options.search
        ? { customerName: { contains: options.search.slice(0, 100), mode: 'insensitive' } }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(Math.max(options.limit ?? 100, 1), 500),
  });
  return rows.map(toQuoteDTO);
}

export async function getQuote(actor: CurrentUser, id: string): Promise<QuoteDTO> {
  assertUse(actor);
  return toQuoteDTO(await loadQuote(id));
}

/* ------------------------------------------------------------------ */
/* Drafting                                                           */
/* ------------------------------------------------------------------ */

export async function createQuote(actor: CurrentUser, rawInput: unknown): Promise<QuoteDTO> {
  assertUse(actor);
  const input: CreateQuoteInput = createQuoteSchema.parse(rawInput);
  const totals = computeTotals(input.items);
  const contentHash = computeQuoteContentHash({
    customerName: input.customerName,
    contactId: input.contactId ?? null,
    zohoCustomerId: input.zohoCustomerId ?? null,
    currency: input.currency,
    items: input.items,
    notes: input.notes ?? null,
  });
  const quote = await prisma.quote.create({
    data: {
      customerName: input.customerName,
      contactId: input.contactId ?? null,
      zohoCustomerId: input.zohoCustomerId ?? null,
      currency: input.currency,
      items: toJson(input.items),
      subtotal: new Prisma.Decimal(totals.subtotal),
      tax: new Prisma.Decimal(totals.tax),
      total: new Prisma.Decimal(totals.total),
      notes: input.notes ?? null,
      status: 'draft',
      version: 1,
      contentHash,
      createdBy: actor.id,
    },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'quotes.created',
    targetType: 'quote',
    targetId: quote.id,
    metadata: { total: totals.total, currency: input.currency, items: input.items.length },
  });
  return toQuoteDTO(quote);
}

/** Invalidates pending AI proposals bound to this quote (by file id or `quoteId` argument). */
async function invalidateQuoteProposals(quoteId: string, reason: string): Promise<number> {
  const res = await prisma.aiProposal.updateMany({
    where: {
      status: 'pending',
      OR: [{ fileIds: { has: quoteId } }, { args: { path: ['quoteId'], equals: quoteId } }],
    },
    data: { status: 'invalidated', error: reason },
  });
  return res.count;
}

export async function updateQuote(
  actor: CurrentUser,
  id: string,
  rawPatch: unknown
): Promise<QuoteDTO> {
  assertUse(actor);
  const patch: UpdateQuoteInput = updateQuoteSchema.parse(rawPatch);
  const quote = await loadQuote(id);
  if (quote.status === 'synced' || quote.status === 'sent') {
    throw new QuoteError('La cotización ya fue creada en Books; crea una nueva versión', 409);
  }
  const items = patch.items ?? parseStoredItems(quote.items);
  const next = {
    customerName: patch.customerName ?? quote.customerName,
    contactId: patch.contactId === undefined ? quote.contactId : patch.contactId,
    zohoCustomerId:
      patch.zohoCustomerId === undefined ? quote.zohoCustomerId : patch.zohoCustomerId,
    currency: patch.currency ?? quote.currency,
    notes: patch.notes === undefined ? quote.notes : patch.notes,
    items,
  };
  const totals = computeTotals(items);
  const contentHash = computeQuoteContentHash(next);
  const changed = contentHash !== quote.contentHash;
  const hadApproval = quote.status === 'pending_approval' || quote.status === 'approved';
  const invalidates = changed && hadApproval;

  const updated = await prisma.quote.update({
    where: { id },
    data: {
      ...next,
      items: toJson(items),
      subtotal: new Prisma.Decimal(totals.subtotal),
      tax: new Prisma.Decimal(totals.tax),
      total: new Prisma.Decimal(totals.total),
      contentHash,
      ...(changed ? { version: { increment: 1 } } : {}),
      ...(invalidates
        ? {
            status: 'draft',
            invalidationReason: 'Contenido modificado',
            approvedBy: null,
            approvedAt: null,
            proposalId: null,
          }
        : {}),
      ...(changed && quote.status === 'rejected'
        ? { status: 'draft', invalidationReason: null }
        : {}),
    },
  });
  if (invalidates) {
    const count = await invalidateQuoteProposals(
      id,
      'La cotización fue modificada después de proponer su aprobación'
    );
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'quotes.approval_invalidated',
      targetType: 'quote',
      targetId: id,
      metadata: {
        reason: 'Contenido modificado',
        proposalsInvalidated: count,
        version: updated.version,
      },
    });
  }
  return toQuoteDTO(updated);
}

/* ------------------------------------------------------------------ */
/* Approval flow                                                      */
/* ------------------------------------------------------------------ */

export async function requestApproval(actor: CurrentUser, id: string): Promise<QuoteDTO> {
  assertUse(actor);
  const quote = await loadQuote(id);
  if (quote.status !== 'draft' && quote.status !== 'rejected') {
    throw new QuoteError(`La cotización está en estado ${quote.status}`, 409);
  }
  if (parseStoredItems(quote.items).length === 0) {
    throw new QuoteError('Agrega al menos una partida antes de solicitar aprobación', 400);
  }
  const updated = await prisma.quote.update({
    where: { id },
    data: { status: 'pending_approval', invalidationReason: null },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'quotes.approval_requested',
    targetType: 'quote',
    targetId: id,
    metadata: { version: quote.version, contentHash: quote.contentHash },
  });
  return toQuoteDTO(updated);
}

export interface ApproveQuoteResult {
  quote: QuoteDTO;
  books: { mock: boolean; estimateId: string; estimateNumber: string; url: string | null } | null;
  uncertain: boolean;
}

/**
 * Human approval: verifies the reviewed hash, claims the quote atomically and
 * creates the official estimate in Zoho Books.
 */
export async function approveQuote(
  actor: CurrentUser,
  id: string,
  options: { expectedContentHash: string; proposalId?: string }
): Promise<ApproveQuoteResult> {
  assertApprover(actor);
  if (!options.expectedContentHash) {
    throw new QuoteError('Falta el hash del contenido revisado', 400);
  }
  const quote = await loadQuote(id);
  if (quote.status === 'synced' || quote.status === 'sent') {
    throw new QuoteError('La cotización ya está creada en Books', 409);
  }
  if (quote.status !== 'pending_approval' && quote.status !== 'approved') {
    throw new QuoteError(
      `La cotización debe estar pendiente de aprobación (estado: ${quote.status})`,
      409
    );
  }
  const items = parseStoredItems(quote.items);
  if (items.length === 0) throw new QuoteError('La cotización no tiene partidas', 400);
  const currentHash = computeQuoteContentHash(contentOf(quote, items));
  if (currentHash !== quote.contentHash) {
    throw new QuoteError(
      'El contenido almacenado no coincide con su hash; revisa la cotización',
      409
    );
  }
  if (options.expectedContentHash !== quote.contentHash) {
    throw new QuoteError(
      'El contenido de la cotización cambió desde que fue revisado; vuelve a revisarla antes de aprobar',
      409
    );
  }

  // Atomic claim: two approvers (or a double click) never create two estimates.
  const claimed = await prisma.quote.updateMany({
    where: { id, status: quote.status, contentHash: quote.contentHash, version: quote.version },
    data: {
      status: 'approved',
      approvedBy: actor.id,
      approvedAt: new Date(),
      proposalId: options.proposalId ?? quote.proposalId,
      invalidationReason: null,
    },
  });
  if (claimed.count === 0) {
    throw new QuoteError('La cotización cambió o ya fue procesada por otro usuario', 409);
  }

  const result = await createEstimate({
    quoteId: quote.id,
    customerName: quote.customerName,
    zohoCustomerId: quote.zohoCustomerId,
    currency: quote.currency,
    notes: quote.notes,
    reference: quote.number ?? quote.id,
    items: items.map((item) => ({
      name: item.name,
      description: item.description,
      quantity: item.quantity,
      rate: item.unitPrice,
    })),
  });

  if (result.ok) {
    const updated = await prisma.quote.update({
      where: { id },
      data: {
        status: 'synced',
        zohoEstimateId: result.estimateId,
        number: quote.number ?? result.estimateNumber,
        syncedAt: new Date(),
        invalidationReason: null,
      },
    });
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'quotes.approved',
      targetType: 'quote',
      targetId: id,
      metadata: {
        contentHash: quote.contentHash,
        version: quote.version,
        total: toDecimal(quote.total).toFixed(4),
        currency: quote.currency,
        mock: result.mock,
        estimateId: result.estimateId,
        proposalId: options.proposalId ?? null,
      },
    });
    return {
      quote: toQuoteDTO(updated),
      books: {
        mock: result.mock,
        estimateId: result.estimateId,
        estimateNumber: result.estimateNumber,
        url: result.url,
      },
      uncertain: false,
    };
  }

  if (result.uncertain) {
    const updated = await prisma.quote.update({
      where: { id },
      data: {
        status: 'pending_approval',
        invalidationReason:
          'Pendiente de revisión: verificar en Books. La creación pudo completarse (tiempo de espera agotado); no reintentar sin comprobar.',
      },
    });
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'quotes.approval_uncertain',
      targetType: 'quote',
      targetId: id,
      metadata: { contentHash: quote.contentHash, error: result.error },
    });
    return { quote: toQuoteDTO(updated), books: null, uncertain: true };
  }

  await prisma.quote.update({
    where: { id },
    data: { status: 'approved', invalidationReason: `No se pudo crear en Books: ${result.error}` },
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'quotes.books_error',
    targetType: 'quote',
    targetId: id,
    metadata: { error: result.error, httpStatus: result.httpStatus ?? null },
  });
  throw new QuoteError(`Aprobada, pero Zoho Books rechazó la creación: ${result.error}`, 502);
}

export async function rejectQuote(
  actor: CurrentUser,
  id: string,
  reason?: string
): Promise<QuoteDTO> {
  assertApprover(actor);
  const quote = await loadQuote(id);
  if (quote.status !== 'pending_approval' && quote.status !== 'approved') {
    throw new QuoteError(`La cotización no está pendiente (estado: ${quote.status})`, 409);
  }
  const updated = await prisma.quote.update({
    where: { id },
    data: {
      status: 'rejected',
      invalidationReason: reason?.trim().slice(0, 500) || 'Rechazada',
      approvedBy: null,
      approvedAt: null,
    },
  });
  await invalidateQuoteProposals(id, 'La cotización fue rechazada');
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'quotes.rejected',
    targetType: 'quote',
    targetId: id,
    metadata: { reason: reason ?? null },
  });
  return toQuoteDTO(updated);
}

/* ------------------------------------------------------------------ */
/* Scenarios (never persisted)                                        */
/* ------------------------------------------------------------------ */

export interface ScenarioComparison {
  base: QuoteTotals & { name: string };
  scenarios: Array<
    QuoteTotals & {
      name: string;
      scenario: QuoteScenario;
      deltaTotal: string;
      deltaPct: string;
    }
  >;
  currency: string;
}

export async function simulateScenarios(
  actor: CurrentUser,
  id: string,
  scenarios: QuoteScenario[]
): Promise<ScenarioComparison> {
  assertUse(actor);
  const quote = await loadQuote(id);
  const items = parseStoredItems(quote.items);
  const base = computeTotals(items);
  const baseTotal = toDecimal(base.total);
  return {
    currency: quote.currency,
    base: { name: 'Actual', ...base },
    scenarios: scenarios.map((scenario) => {
      const totals = applyScenario(items, scenario);
      const delta = toDecimal(totals.total).minus(baseTotal);
      const pct = baseTotal.isZero() ? new Prisma.Decimal(0) : delta.div(baseTotal).mul(100);
      return {
        name: scenario.name,
        scenario,
        ...totals,
        deltaTotal: delta.toFixed(4),
        deltaPct: pct.toFixed(2),
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Commercial package (PDF)                                           */
/* ------------------------------------------------------------------ */

export interface ProductCard {
  itemName: string;
  sku: string | null;
  found: boolean;
  name: string | null;
  description: string | null;
  brand: string | null;
  unit: string | null;
  categoryName: string | null;
  satProductCode: string | null;
  satUnitCode: string | null;
  availableStock: string | null;
}

export interface CommercialPackageResult {
  quoteId: string;
  documentId: string;
  fileName: string;
  sizeBytes: number;
  pageCount: number;
  products: ProductCard[];
  protectedRetention: boolean;
}

async function lookupProductCards(items: QuoteItemInput[]): Promise<ProductCard[]> {
  const skus = [...new Set(items.map((i) => i.sku?.trim()).filter((s): s is string => Boolean(s)))];
  const names = [...new Set(items.map((i) => i.name.trim()))];
  const products =
    skus.length + names.length === 0
      ? []
      : await prisma.product.findMany({
          where: {
            OR: [
              ...(skus.length ? [{ sku: { in: skus } }] : []),
              ...(names.length ? [{ name: { in: names, mode: 'insensitive' as const } }] : []),
            ],
          },
          take: 400,
        });
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku!.toLowerCase(), p]));
  const byName = new Map(products.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]));
  return items.map((item) => {
    const product =
      (item.sku ? bySku.get(item.sku.trim().toLowerCase()) : undefined) ??
      byName.get(item.name.trim().toLowerCase());
    return {
      itemName: item.name,
      sku: item.sku ?? product?.sku ?? null,
      found: Boolean(product),
      name: product?.name ?? null,
      description: product?.description ?? null,
      brand: product?.brand ?? null,
      unit: product?.unit ?? null,
      categoryName: product?.categoryName ?? null,
      satProductCode: product?.satProductCode ?? null,
      satUnitCode: product?.satUnitCode ?? null,
      availableStock: product?.availableStock ? toDecimal(product.availableStock).toFixed(2) : null,
    };
  });
}

function money(value: string | number, currency: string): string {
  return `${new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} ${currency}`;
}

/**
 * Builds the complete commercial package: quote + product cards + conditions,
 * rendered as a PDF in a temporary directory and stored through the object
 * storage (protected retention once approved).
 */
export async function buildCommercialPackage(
  actor: CurrentUser,
  id: string
): Promise<CommercialPackageResult> {
  assertUse(actor);
  const quote = await loadQuote(id);
  const items = parseStoredItems(quote.items);
  if (items.length === 0) throw new QuoteError('La cotización no tiene partidas', 400);
  const [settings, products] = await Promise.all([getQuoteSettings(), lookupProductCards(items)]);
  const totals = computeTotals(items);
  const approved =
    quote.status === 'approved' || quote.status === 'synced' || quote.status === 'sent';
  const validUntil = new Date(Date.now() + settings.validityDays * 86_400_000);

  const itemRows = items.map((item, index) => ({
    n: index + 1,
    name: item.name,
    description: item.description ?? '',
    quantity: item.quantity,
    unitPrice: money(item.unitPrice, quote.currency),
    taxRate: `${toDecimal(item.taxRate ?? 0)
      .mul(100)
      .toFixed(2)} %`,
    lineTotal: money(totals.lines[index]?.lineTotal ?? '0', quote.currency),
  }));

  const sections: PdfSection[] = [
    {
      title: 'Fichas de producto',
      columns: [
        { header: 'Partida', key: 'itemName', width: 3 },
        { header: 'SKU', key: 'sku', width: 2, nowrap: true },
        { header: 'Marca', key: 'brand', width: 2 },
        { header: 'Unidad', key: 'unit', width: 1.2 },
        { header: 'Categoría', key: 'categoryName', width: 2 },
        { header: 'Clave SAT', key: 'satProductCode', width: 1.5, nowrap: true },
        { header: 'Unidad SAT', key: 'satUnitCode', width: 1.2, nowrap: true },
        { header: 'Ficha', key: 'found', width: 1.2 },
        { header: 'Descripción', key: 'description', detail: true },
      ],
      rows: products.map((p) => ({
        itemName: p.itemName,
        sku: p.sku ?? '—',
        brand: p.brand ?? '—',
        unit: p.unit ?? '—',
        categoryName: p.categoryName ?? '—',
        satProductCode: p.satProductCode ?? '—',
        satUnitCode: p.satUnitCode ?? '—',
        found: p.found ? 'Catálogo' : 'Sin ficha',
        description: p.description ?? '',
      })),
    },
    {
      title: 'Totales',
      columns: [
        { header: 'Concepto', key: 'label', width: 3 },
        { header: 'Importe', key: 'value', width: 2, align: 'right', nowrap: true },
      ],
      rows: [
        { label: 'Subtotal', value: money(totals.subtotal, quote.currency) },
        { label: 'Impuestos', value: money(totals.tax, quote.currency) },
      ],
      totalsRow: { label: 'TOTAL', value: money(totals.total, quote.currency) },
    },
    {
      title: 'Condiciones comerciales',
      columns: [{ header: 'Condiciones', key: 'text', detail: true }],
      rows: [
        { text: settings.conditions || DEFAULT_QUOTE_SETTINGS.conditions },
        {
          text: `Vigencia: ${settings.validityDays} días (hasta ${validUntil.toLocaleDateString('es-MX')}).`,
        },
        ...(quote.notes ? [{ text: `Notas: ${quote.notes}` }] : []),
      ],
    },
  ];

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unik-quote-'));
  const filePath = path.join(dir, 'paquete.pdf');
  try {
    const generated = await generatePdfReport(filePath, {
      title: `Cotización ${quote.number ?? quote.id.slice(-8).toUpperCase()}`,
      subtitle: `${settings.companyName} · ${quote.customerName} · versión ${quote.version}`,
      author: settings.companyName,
      logoText: settings.companyName,
      orientation: 'portrait',
      summaryCards: [
        { label: 'Cliente', value: quote.customerName },
        { label: 'Total', value: money(totals.total, quote.currency) },
        { label: 'Vigencia', value: `${settings.validityDays} días` },
        { label: 'Estado', value: approved ? 'Aprobada' : 'Borrador (no oficial)' },
      ],
      metadata: {
        Cotización: quote.number ?? quote.id,
        Versión: String(quote.version),
        Moneda: quote.currency,
        'Hash de contenido': (quote.contentHash ?? '').slice(0, 16),
        ...(quote.zohoEstimateId ? { 'Zoho Books': quote.zohoEstimateId } : {}),
      },
      columns: [
        { header: '#', key: 'n', width: 0.5, nowrap: true },
        { header: 'Producto', key: 'name', width: 3 },
        { header: 'Cantidad', key: 'quantity', width: 1, align: 'right', nowrap: true },
        { header: 'Precio unitario', key: 'unitPrice', width: 1.6, align: 'right', nowrap: true },
        { header: 'Impuesto', key: 'taxRate', width: 1, align: 'right', nowrap: true },
        { header: 'Importe', key: 'lineTotal', width: 1.6, align: 'right', nowrap: true },
        { header: 'Descripción', key: 'description', detail: true },
      ],
      rows: itemRows,
      sections,
    });
    const fileName = `cotizacion-${(quote.number ?? quote.id.slice(-8)).replace(/[^a-zA-Z0-9_-]/g, '')}-v${quote.version}.pdf`;
    const object = await saveGeneratedFile({
      createdBy: actor.id,
      purpose: 'document',
      fileName,
      mimeType: 'application/pdf',
      source: { filePath },
      retentionPolicy: approved ? 'protected' : 'default',
      restricted: true,
      metadata: {
        kind: 'quote_commercial_package',
        quoteId: quote.id,
        quoteVersion: quote.version,
        contentHash: quote.contentHash,
        pageCount: generated.pageCount,
        subtotal: totals.subtotal,
        tax: totals.tax,
        total: totals.total,
      },
    });
    await prisma.quote.update({ where: { id }, data: { documentId: object.id } });
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'quotes.package_built',
      targetType: 'quote',
      targetId: id,
      metadata: { documentId: object.id, version: quote.version, protected: approved },
    });
    return {
      quoteId: id,
      documentId: object.id,
      fileName,
      sizeBytes: generated.sizeBytes,
      pageCount: generated.pageCount,
      products,
      protectedRetention: approved,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ENTITY_TYPE as INVOICE_ENTITY_TYPE, SOURCE } from '@/modules/integrations/zoho/invoices-sync';
import {
  ENTITY_TYPE as PAYMENT_ENTITY_TYPE,
  SOURCE as PAYMENT_SOURCE,
} from '@/modules/integrations/zoho/payments-sync';

export const CURRENT_INVOICE_NORMALIZER_VERSION = 1;

export const NORMALIZATION_ERROR_CODE = {
  SNAPSHOT_SHAPE_INVALID: 'SNAPSHOT_SHAPE_INVALID',
  MAPPING_ERROR: 'MAPPING_ERROR',
  PERSISTENCE_ERROR: 'PERSISTENCE_ERROR',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
} as const;

class NormalizationError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly snapshotId: string,
    message: string
  ) {
    super(message);
    this.name = 'NormalizationError';
  }
}

export class NormalizationAlreadyRunningError extends Error {
  constructor() {
    super('An invoice normalization batch is already running in this instance');
    this.name = 'NormalizationAlreadyRunningError';
  }
}

type SnapshotInput = {
  id: string;
  source: string;
  entityType: string;
  externalId: string;
  remoteModifiedAt: Date;
  normalizationVersion: number;
  payload: Prisma.JsonValue;
};

const NORMALIZER_STATE_KEY = '__unikZohoInvoicesNormalizerState' as const;

interface NormalizerState {
  batchInProgress: boolean;
}

type GlobalWithNormalizerState = typeof globalThis & {
  [NORMALIZER_STATE_KEY]?: NormalizerState;
};

function getNormalizerState(): NormalizerState {
  const scope = globalThis as GlobalWithNormalizerState;
  scope[NORMALIZER_STATE_KEY] ??= { batchInProgress: false };
  return scope[NORMALIZER_STATE_KEY];
}

const invoicePaymentSchema = z
  .object({
    payment_id: z.string().nullish(),
    payment_number: z.string().nullish(),
    payment_mode: z.string().nullish(),
    date: z.string().nullish(),
    amount: z.number().nullish(),
    reference_number: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_name: z.string().nullish(),
    last_modified_time: z.string().nullish(),
  })
  .passthrough();

const invoiceItemSchema = z
  .object({
    line_item_id: z.string().nullish(),
    item_id: z.string().nullish(),
    sku: z.string().nullish(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    quantity: z.number().nullish(),
    unit: z.string().nullish(),
    rate: z.number().nullish(),
    discount_amount: z.number().nullish(),
    tax_name: z.string().nullish(),
    tax_percentage: z.union([z.string(), z.number()]).nullish(),
    tax_amount: z.number().nullish(),
    item_total: z.number().nullish(),
    item_order: z.number().nullish(),
  })
  .passthrough();

const invoicePayloadSchema = z
  .object({
    invoice_id: z.string().min(1),
    invoice_number: z.string().nullish(),
    salesorder_id: z.string().nullish(),
    salesorder_number: z.string().nullish(),
    date: z.string().nullish(),
    due_date: z.string().nullish(),
    status: z.string().nullish(),
    payment_status: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_name: z.string().nullish(),
    contact_persons: z
      .array(
        z
          .object({
            phone: z.string().nullish(),
            mobile: z.string().nullish(),
            email: z.string().nullish(),
          })
          .passthrough()
      )
      .nullish(),
    salesperson_id: z.string().nullish(),
    salesperson_name: z.string().nullish(),
    currency_code: z.string().nullish(),
    sub_total: z.number().nullish(),
    total: z.number().nullish(),
    tax_total: z.number().nullish(),
    discount_total: z.number().nullish(),
    shipping_charge: z.number().nullish(),
    adjustment: z.number().nullish(),
    balance: z.number().nullish(),
    amount_paid: z.number().nullish(),
    line_items: z.array(invoiceItemSchema).nullish(),
    payments: z.array(invoicePaymentSchema).nullish(),
  })
  .passthrough();

const customerPaymentInvoiceSchema = z
  .object({
    invoice_id: z.string().nullish(),
    invoice_number: z.string().nullish(),
    amount_applied: z.number().nullish(),
  })
  .passthrough();

const customerPaymentPayloadSchema = z
  .object({
    payment_id: z.string().min(1),
    payment_number: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_name: z.string().nullish(),
    payment_mode: z.string().nullish(),
    date: z.string().nullish(),
    amount: z.number().nullish(),
    reference_number: z.string().nullish(),
    last_modified_time: z.string().nullish(),
    invoices: z.array(customerPaymentInvoiceSchema).nullish(),
  })
  .passthrough();

function log(payload: Record<string, unknown>) {
  console.info(JSON.stringify(payload));
}

function parseZohoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseZohoCommercialDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Prisma.Decimal(value) : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\,/g, '');
  if (cleaned.length === 0) return null;
  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return null;
  }
}

function extractCustomerContact(
  contacts: z.infer<typeof invoicePayloadSchema>['contact_persons']
): { phone: string | null; email: string | null } {
  if (!contacts || contacts.length === 0) return { phone: null, email: null };
  const firstWithPhone = contacts.find((c) => typeof c.phone === 'string' && c.phone.length > 0);
  const firstWithMobile = contacts.find((c) => typeof c.mobile === 'string' && c.mobile.length > 0);
  const firstWithEmail = contacts.find((c) => typeof c.email === 'string' && c.email.length > 0);
  return {
    phone: firstWithPhone?.phone ?? firstWithMobile?.mobile ?? null,
    email: firstWithEmail?.email ?? null,
  };
}

async function persistNormalizedInvoice(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  zohoInvoiceId: string,
  invoiceData: Omit<Prisma.InvoiceCreateInput, 'items' | 'payments'>,
  items: Omit<Prisma.InvoiceItemCreateManyInput, 'invoiceId'>[],
  payments: Omit<Prisma.InvoicePaymentCreateManyInput, 'invoiceId'>[]
): Promise<{ invoiceId: string }> {
  const invoice = await tx.invoice.upsert({
    where: { zohoInvoiceId },
    create: invoiceData,
    update: invoiceData,
  });

  await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } });
  await tx.invoicePayment.deleteMany({ where: { invoiceId: invoice.id } });

  if (items.length > 0) {
    await tx.invoiceItem.createMany({
      data: items.map((item) => ({ ...item, invoiceId: invoice.id })),
      skipDuplicates: true,
    });
  }

  if (payments.length > 0) {
    await tx.invoicePayment.createMany({
      data: payments.map((payment) => ({ ...payment, invoiceId: invoice.id })),
      skipDuplicates: true,
    });
  }

  return { invoiceId: invoice.id };
}

function buildInvoiceData(
  snapshotId: string,
  remoteModifiedAt: Date,
  payload: z.infer<typeof invoicePayloadSchema>
): Omit<Prisma.InvoiceCreateInput, 'items' | 'payments'> {
  const contact = extractCustomerContact(payload.contact_persons);

  return {
    zohoInvoiceId: payload.invoice_id,
    invoiceNumber: payload.invoice_number ?? null,
    zohoSalesOrderId: payload.salesorder_id ?? null,
    salesOrderNumber: payload.salesorder_number ?? null,
    invoiceDate: parseZohoCommercialDate(payload.date),
    dueDate: parseZohoCommercialDate(payload.due_date),
    status: payload.status ?? null,
    paymentStatus: payload.payment_status ?? null,
    zohoCustomerId: payload.customer_id ?? null,
    customerName: payload.customer_name ?? null,
    customerEmail: contact.email,
    customerPhone: contact.phone,
    zohoSalespersonId: payload.salesperson_id ?? null,
    salespersonName: payload.salesperson_name ?? null,
    currencyCode: payload.currency_code ?? null,
    subtotal: toDecimal(payload.sub_total),
    discountTotal: toDecimal(payload.discount_total),
    taxTotal: toDecimal(payload.tax_total),
    shippingCharge: toDecimal(payload.shipping_charge),
    adjustment: toDecimal(payload.adjustment),
    total: toDecimal(payload.total),
    balance: toDecimal(payload.balance),
    amountPaid: toDecimal(payload.amount_paid),
    sourceRemoteModifiedAt: remoteModifiedAt,
    sourceSnapshotId: snapshotId,
    normalizedAt: new Date(),
  };
}

function buildInvoiceItems(
  lineItems: z.infer<typeof invoiceItemSchema>[]
): Omit<Prisma.InvoiceItemCreateManyInput, 'invoiceId'>[] {
  return lineItems.map((item, index) => ({
    zohoLineItemId: item.line_item_id ?? null,
    zohoItemId: item.item_id ?? null,
    sku: item.sku ?? null,
    name: item.name ?? null,
    description: item.description ?? null,
    quantity: toDecimal(item.quantity),
    unit: item.unit ?? null,
    rate: toDecimal(item.rate),
    discountAmount: toDecimal(item.discount_amount),
    taxName: item.tax_name ?? null,
    taxPercentage: toDecimal(item.tax_percentage),
    taxAmount: toDecimal(item.tax_amount),
    lineTotal: toDecimal(item.item_total),
    sortOrder: typeof item.item_order === 'number' ? item.item_order : index + 1,
  }));
}

function buildInvoicePayments(
  invoiceRemoteModifiedAt: Date,
  payments: z.infer<typeof invoicePaymentSchema>[]
): Omit<Prisma.InvoicePaymentCreateManyInput, 'invoiceId'>[] {
  return payments.map((payment) => ({
    zohoPaymentId: payment.payment_id ?? null,
    paymentNumber: payment.payment_number ?? null,
    paymentDate: parseZohoCommercialDate(payment.date),
    paymentMode: payment.payment_mode ?? null,
    referenceNumber: payment.reference_number ?? null,
    amount: toDecimal(payment.amount),
    customerName: payment.customer_name ?? null,
    zohoCustomerId: payment.customer_id ?? null,
    sourceRemoteModifiedAt:
      typeof payment.last_modified_time === 'string'
        ? parseZohoDate(payment.last_modified_time) ?? invoiceRemoteModifiedAt
        : invoiceRemoteModifiedAt,
  }));
}

async function markSnapshotProcessed(
  tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  snapshotId: string,
  normalizationVersion: number,
  errorCode: string | null
): Promise<void> {
  await tx.integrationSnapshot.update({
    where: { id: snapshotId },
    data: {
      normalizedAt: errorCode === null ? new Date() : null,
      normalizationVersion,
      normalizationErrorCode: errorCode,
    },
  });
}

async function markSnapshotFailed(
  snapshotId: string,
  existingVersion: number,
  errorCode: string
): Promise<void> {
  await prisma.integrationSnapshot.update({
    where: { id: snapshotId },
    data: {
      normalizedAt: null,
      normalizationVersion: existingVersion,
      normalizationErrorCode: errorCode,
    },
  });
}

function logFailure(snapshotId: string, externalId: string, errorCode: string, prefix = 'invoices') {
  log({
    event: `zoho.${prefix}.normalization.failed`,
    snapshotId,
    externalId,
    normalizerVersion: CURRENT_INVOICE_NORMALIZER_VERSION,
    errorCode,
  });
}

type ExtractInvoiceResult =
  | { data: z.infer<typeof invoicePayloadSchema>; error: null }
  | { data: null; error: string };

function extractInvoicePayload(raw: unknown): ExtractInvoiceResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.invoice_id === 'string' && obj.invoice_id.length > 0) {
    const parse = invoicePayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct invoice shape' };
    return { data: parse.data, error: null };
  }

  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (typeof obj.invoice !== 'object' || obj.invoice === null || Array.isArray(obj.invoice)) {
      return { data: null, error: 'Missing or invalid invoice in Zoho wrapper' };
    }
    const parse = invoicePayloadSchema.safeParse(obj.invoice);
    if (!parse.success) return { data: null, error: 'Invalid wrapped invoice shape' };
    return { data: parse.data, error: null };
  }

  return { data: null, error: 'Unrecognized snapshot payload shape' };
}

export async function normalizeInvoiceSnapshot(
  snapshot: SnapshotInput
): Promise<{ invoiceId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== SOURCE || snapshot.entityType !== INVOICE_ENTITY_TYPE) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      snapshot.id,
      'Snapshot source/entity type does not match Zoho invoices'
    );
  }

  const extraction = extractInvoicePayload(snapshot.payload);
  if (extraction.data === null) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    throw new NormalizationError(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      snapshot.id,
      extraction.error ?? 'Invalid snapshot payload shape'
    );
  }

  const payload = extraction.data;
  const invoiceData = buildInvoiceData(snapshot.id, snapshot.remoteModifiedAt, payload);
  const items = buildInvoiceItems(payload.line_items ?? []);
  const payments = buildInvoicePayments(snapshot.remoteModifiedAt, payload.payments ?? []);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.invoice.findUnique({
      where: { zohoInvoiceId: payload.invoice_id },
      select: { id: true, sourceRemoteModifiedAt: true },
    });

    if (existing && existing.sourceRemoteModifiedAt.getTime() > snapshot.remoteModifiedAt.getTime()) {
      await markSnapshotProcessed(tx, snapshot.id, CURRENT_INVOICE_NORMALIZER_VERSION, null);
      return { invoiceId: existing.id, status: 'skipped' };
    }

    const invoice = await persistNormalizedInvoice(tx, payload.invoice_id, invoiceData, items, payments);
    await markSnapshotProcessed(tx, snapshot.id, CURRENT_INVOICE_NORMALIZER_VERSION, null);

    log({
      event: 'zoho.invoices.normalization.completed',
      snapshotId: snapshot.id,
      externalId: snapshot.externalId,
      normalizerVersion: CURRENT_INVOICE_NORMALIZER_VERSION,
      invoiceId: invoice.invoiceId,
    });

    return { invoiceId: invoice.invoiceId, status: 'normalized' };
  });
}

export interface NormalizePendingSnapshotsResult {
  seen: number;
  normalized: number;
  skipped: number;
  failed: number;
  alreadyRunning: boolean;
}

export async function normalizePendingInvoiceSnapshots(options: {
  limit: number;
}): Promise<NormalizePendingSnapshotsResult> {
  const state = getNormalizerState();
  if (state.batchInProgress) {
    throw new NormalizationAlreadyRunningError();
  }

  state.batchInProgress = true;

  try {
    const pending = await prisma.integrationSnapshot.findMany({
      where: {
        source: SOURCE,
        entityType: INVOICE_ENTITY_TYPE,
        normalizationVersion: { lt: CURRENT_INVOICE_NORMALIZER_VERSION },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizeInvoiceSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') normalized += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        const errorCode =
          error instanceof NormalizationError ? error.errorCode : NORMALIZATION_ERROR_CODE.UNEXPECTED_ERROR;
        const snapshotId = error instanceof NormalizationError ? error.snapshotId : snapshot.id;

        try {
          await markSnapshotFailed(
            snapshotId,
            'normalizationVersion' in snapshot ? snapshot.normalizationVersion : 0,
            errorCode
          );
        } catch {
          // ignore
        }

        logFailure(snapshotId, snapshot.externalId, errorCode);
      }
    }

    log({
      event: 'zoho.invoices.normalization.batch_completed',
      seen: pending.length,
      normalized,
      skipped,
      failed,
      normalizerVersion: CURRENT_INVOICE_NORMALIZER_VERSION,
    });

    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Customer payment normalization
// ---------------------------------------------------------------------------

type ExtractPaymentResult =
  | { data: z.infer<typeof customerPaymentPayloadSchema>; error: null }
  | { data: null; error: string };

function extractCustomerPaymentPayload(raw: unknown): ExtractPaymentResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, error: 'Snapshot payload is not an object' };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.payment_id === 'string' && obj.payment_id.length > 0) {
    const parse = customerPaymentPayloadSchema.safeParse(raw);
    if (!parse.success) return { data: null, error: 'Invalid direct customer payment shape' };
    return { data: parse.data, error: null };
  }

  if ('code' in obj) {
    if (typeof obj.code !== 'number' || obj.code !== 0) {
      return { data: null, error: `Zoho API error code: ${obj.code}` };
    }
    if (
      typeof obj.customerpayment !== 'object' ||
      obj.customerpayment === null ||
      Array.isArray(obj.customerpayment)
    ) {
      return { data: null, error: 'Missing or invalid customerpayment in Zoho wrapper' };
    }
    const parse = customerPaymentPayloadSchema.safeParse(obj.customerpayment);
    if (!parse.success) return { data: null, error: 'Invalid wrapped customer payment shape' };
    return { data: parse.data, error: null };
  }

  return { data: null, error: 'Unrecognized snapshot payload shape' };
}

function buildPaymentRemoteModifiedAt(payload: z.infer<typeof customerPaymentPayloadSchema>): Date {
  const date = typeof payload.last_modified_time === 'string'
    ? parseZohoDate(payload.last_modified_time)
    : null;
  return date ?? parseZohoCommercialDate(payload.date) ?? new Date();
}

export async function normalizePaymentSnapshot(
  snapshot: SnapshotInput
): Promise<{ paymentId: string; status: 'normalized' | 'skipped' }> {
  if (snapshot.source !== PAYMENT_SOURCE || snapshot.entityType !== PAYMENT_ENTITY_TYPE) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID, 'customerpayments');
    throw new NormalizationError(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      snapshot.id,
      'Snapshot source/entity type does not match Zoho customer payments'
    );
  }

  const extraction = extractCustomerPaymentPayload(snapshot.payload);
  if (extraction.data === null) {
    await markSnapshotFailed(snapshot.id, snapshot.normalizationVersion, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID);
    logFailure(snapshot.id, snapshot.externalId, NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID, 'customerpayments');
    throw new NormalizationError(
      NORMALIZATION_ERROR_CODE.SNAPSHOT_SHAPE_INVALID,
      snapshot.id,
      extraction.error ?? 'Invalid snapshot payload shape'
    );
  }

  const payload = extraction.data;
  const remoteModifiedAt = buildPaymentRemoteModifiedAt(payload);

  // Every customer payment snapshot is normalized against its applied invoices.
  const invoiceRefs = payload.invoices ?? [];
  const affectedInvoiceIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const invoiceRef of invoiceRefs) {
      const zohoInvoiceId = invoiceRef.invoice_id;
      if (!zohoInvoiceId) continue;

      const invoice = await tx.invoice.findUnique({
        where: { zohoInvoiceId },
        select: { id: true },
      });
      if (!invoice) continue;

      const existing = await tx.invoicePayment.findFirst({
        where: { invoiceId: invoice.id, zohoPaymentId: payload.payment_id },
        select: { id: true },
      });

      const baseData = {
        zohoPaymentId: payload.payment_id,
        paymentNumber: payload.payment_number ?? null,
        paymentDate: parseZohoCommercialDate(payload.date),
        paymentMode: payload.payment_mode ?? null,
        referenceNumber: payload.reference_number ?? null,
        amount: toDecimal(invoiceRef.amount_applied ?? payload.amount),
        customerName: payload.customer_name ?? null,
        zohoCustomerId: payload.customer_id ?? null,
        sourceRemoteModifiedAt: remoteModifiedAt,
      };

      const createData: Prisma.InvoicePaymentCreateInput = {
        ...baseData,
        invoice: { connect: { id: invoice.id } },
      };

      if (existing) {
        const updateData: Prisma.InvoicePaymentUpdateInput = {
          ...baseData,
          invoice: { connect: { id: invoice.id } },
        };
        await tx.invoicePayment.update({ where: { id: existing.id }, data: updateData });
      } else {
        await tx.invoicePayment.create({ data: createData });
      }

      affectedInvoiceIds.push(invoice.id);
    }

    await markSnapshotProcessed(tx, snapshot.id, CURRENT_INVOICE_NORMALIZER_VERSION, null);
  });

  log({
    event: 'zoho.customerpayments.normalization.completed',
    snapshotId: snapshot.id,
    externalId: snapshot.externalId,
    normalizerVersion: CURRENT_INVOICE_NORMALIZER_VERSION,
    affectedInvoices: affectedInvoiceIds,
  });

  return { paymentId: snapshot.id, status: 'normalized' };
}

export async function normalizePendingPaymentSnapshots(options: {
  limit: number;
}): Promise<NormalizePendingSnapshotsResult> {
  const state = getNormalizerState();
  if (state.batchInProgress) {
    throw new NormalizationAlreadyRunningError();
  }

  state.batchInProgress = true;

  try {
    const pending = await prisma.integrationSnapshot.findMany({
      where: {
        source: PAYMENT_SOURCE,
        entityType: PAYMENT_ENTITY_TYPE,
        normalizationVersion: { lt: CURRENT_INVOICE_NORMALIZER_VERSION },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(options.limit, 500)),
    });

    let normalized = 0;
    let skipped = 0;
    let failed = 0;

    for (const snapshot of pending) {
      try {
        const result = await normalizePaymentSnapshot(snapshot as SnapshotInput);
        if (result.status === 'normalized') normalized += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        const errorCode =
          error instanceof NormalizationError ? error.errorCode : NORMALIZATION_ERROR_CODE.UNEXPECTED_ERROR;
        const snapshotId = error instanceof NormalizationError ? error.snapshotId : snapshot.id;

        try {
          await markSnapshotFailed(
            snapshotId,
            'normalizationVersion' in snapshot ? snapshot.normalizationVersion : 0,
            errorCode
          );
        } catch {
          // ignore
        }

        logFailure(snapshotId, snapshot.externalId, errorCode, 'customerpayments');
      }
    }

    log({
      event: 'zoho.customerpayments.normalization.batch_completed',
      seen: pending.length,
      normalized,
      skipped,
      failed,
      normalizerVersion: CURRENT_INVOICE_NORMALIZER_VERSION,
    });

    return { seen: pending.length, normalized, skipped, failed, alreadyRunning: false };
  } finally {
    state.batchInProgress = false;
  }
}

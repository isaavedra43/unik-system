import {
  Prisma,
  type SourcingCandidate,
  type Supplier,
  type SupplierEvaluation,
  type SupplierProduct,
} from '@prisma/client';
import { z } from 'zod';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import {
  D,
  assertFoundRow,
  emitPurchases,
  nextFolio,
  parseChannels,
  publishBoard,
  recordActorId,
  type Db,
  type SupplierChannel,
} from './purchases-helpers';
import {
  currencyCode,
  idText,
  moneyAmount,
  optionalText,
  positiveQty,
  requiredText,
} from './purchases-schemas';
import {
  PAYMENT_MODES,
  PURCHASES_EVENTS,
  PURCHASES_OBJECT_TYPES,
  SUPPLIER_CHANNEL_TYPES,
  SUPPLIER_PRODUCT_SOURCES,
  SUPPLIER_STATUSES,
} from './purchases-types';
import {
  extractDomain,
  matchExistingSupplier,
  matchVendorContact,
  normalizeCompanyName,
  normalizePhone,
  type CandidateIdentity,
} from './sourcing-dedupe';
import { computeSupplierRating } from './supplier-rating';

/**
 * Suppliers of UNIK (plan 6.1, `suppliers-service`): creation with duplicate
 * detection (RFC, Zoho vendor, domain, phone, name), edition, link to a Zoho
 * vendor (`Contact`), products with last price and lead time, evaluations that
 * recompute the rating, and promotion of a Sourcing Lab candidate.
 *
 * Functions run inside purchases commands (`purchases-commands.ts`).
 */

const OBJ = PURCHASES_OBJECT_TYPES;
const EV = PURCHASES_EVENTS.supplier;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const supplierChannelSchema = z.object({
  type: z.enum(SUPPLIER_CHANNEL_TYPES),
  value: z.string().trim().min(3).max(300),
});

const rfcSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/, 'RFC inválido');

const supplierFields = {
  name: requiredText(200, 'Indica el nombre del proveedor').pipe(
    z.string().min(2, 'Nombre muy corto')
  ),
  legalName: optionalText(300),
  taxRegNo: rfcSchema.nullish(),
  zohoContactId: idText.nullish(),
  channels: z.array(supplierChannelSchema).max(20),
  primaryPhone: optionalText(40),
  primaryEmail: z.string().trim().email('Correo inválido').max(200).nullish(),
  website: optionalText(300),
  paymentMode: z.enum(PAYMENT_MODES),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
  currency: currencyCode,
  leadTimeDaysDefault: z.number().int().min(0).max(365).nullish(),
  freightTerms: optionalText(500),
  tags: z.array(z.string().trim().min(1).max(40)).max(30),
  notes: optionalText(2000),
};

export const createSupplierSchema = z.object({
  ...supplierFields,
  channels: supplierFields.channels.default([]),
  paymentMode: supplierFields.paymentMode.default('prepaid'),
  currency: supplierFields.currency.default('MXN'),
  tags: supplierFields.tags.default([]),
  /** Create even when another supplier has the same name (never with the same RFC, Zoho vendor, domain or phone). */
  allowSimilarName: z.boolean().default(false),
});
export type CreateSupplierInput = z.output<typeof createSupplierSchema>;

export const updateSupplierSchema = z.object({
  supplierId: idText,
  name: supplierFields.name.optional(),
  legalName: supplierFields.legalName.optional(),
  taxRegNo: supplierFields.taxRegNo.optional(),
  channels: supplierFields.channels.optional(),
  primaryPhone: supplierFields.primaryPhone.optional(),
  primaryEmail: supplierFields.primaryEmail.optional(),
  website: supplierFields.website.optional(),
  paymentMode: supplierFields.paymentMode.optional(),
  paymentTermsDays: supplierFields.paymentTermsDays.optional(),
  currency: supplierFields.currency.optional(),
  leadTimeDaysDefault: supplierFields.leadTimeDaysDefault.optional(),
  freightTerms: supplierFields.freightTerms.optional(),
  tags: supplierFields.tags.optional(),
  notes: supplierFields.notes.optional(),
  status: z.enum(SUPPLIER_STATUSES).optional(),
});
export type UpdateSupplierInput = z.output<typeof updateSupplierSchema>;

export const linkZohoContactSchema = z.object({
  supplierId: idText,
  zohoContactId: idText.nullable(),
});

export const upsertSupplierProductSchema = z.object({
  supplierId: idText,
  zohoItemId: idText.nullish(),
  supplierSku: z.string().trim().max(120).nullish(),
  description: requiredText(300, 'Describe el producto'),
  unit: requiredText(40, 'Indica la unidad'),
  unitFactorToBase: positiveQty.default(1),
  lastPrice: moneyAmount.nullish(),
  currency: currencyCode.default('MXN'),
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  minOrderQty: positiveQty.nullish(),
  source: z.enum(SUPPLIER_PRODUCT_SOURCES).default('manual'),
});
export type UpsertSupplierProductInput = z.output<typeof upsertSupplierProductSchema>;

const score = z.number().int().min(1, 'Califica de 1 a 5').max(5, 'Califica de 1 a 5');

export const evaluateSupplierSchema = z.object({
  supplierId: idText,
  orderId: idText.nullish(),
  receiptId: idText.nullish(),
  onTime: score,
  quality: score,
  price: score,
  communication: score,
  comment: optionalText(1000),
});
export type EvaluateSupplierInput = z.output<typeof evaluateSupplierSchema>;

export const promoteCandidateSchema = z.object({
  candidateId: idText,
  name: supplierFields.name.optional(),
  paymentMode: supplierFields.paymentMode.optional(),
  paymentTermsDays: supplierFields.paymentTermsDays.optional(),
  leadTimeDaysDefault: supplierFields.leadTimeDaysDefault.optional(),
  channels: supplierFields.channels.optional(),
});
export type PromoteCandidateInput = z.output<typeof promoteCandidateSchema>;

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

function primaryPhoneOf(
  channels: readonly SupplierChannel[],
  explicit: string | null | undefined
): string | null {
  if (explicit) return explicit;
  return channels.find((c) => ['whatsapp', 'phone', 'sms'].includes(c.type))?.value ?? null;
}

function primaryEmailOf(
  channels: readonly SupplierChannel[],
  explicit: string | null | undefined
): string | null {
  if (explicit) return explicit;
  return channels.find((c) => c.type === 'email')?.value ?? null;
}

function websiteOf(
  channels: readonly SupplierChannel[],
  explicit: string | null | undefined
): string | null {
  if (explicit) return explicit;
  return channels.find((c) => c.type === 'web')?.value ?? null;
}

/**
 * Suppliers that may be the same company (RFC, Zoho vendor, domain, phone,
 * name) — bounded queries. INTERNAL to this service: it is not a second
 * implementation of the deduplication, it is the DB side of the pure rule
 * `matchExistingSupplier` (`sourcing-dedupe.ts`), which it calls for every
 * candidate row. Both callers (creating a supplier and promoting a sourcing
 * candidate) live in this file.
 */
async function findSimilarSuppliers(
  db: Db,
  identity: CandidateIdentity & { taxRegNo?: string | null; zohoContactId?: string | null },
  options: { excludeId?: string } = {}
): Promise<
  Array<{ supplier: Supplier; reason: 'tax_reg_no' | 'zoho_contact' | 'domain' | 'phone' | 'name' }>
> {
  const out: Array<{
    supplier: Supplier;
    reason: 'tax_reg_no' | 'zoho_contact' | 'domain' | 'phone' | 'name';
  }> = [];
  const push = (supplier: Supplier, reason: (typeof out)[number]['reason']) => {
    if (supplier.id === options.excludeId || out.some((o) => o.supplier.id === supplier.id)) return;
    out.push({ supplier, reason });
  };
  if (identity.taxRegNo) {
    for (const row of await db.supplier.findMany({
      where: { taxRegNo: identity.taxRegNo },
      take: 5,
    }))
      push(row, 'tax_reg_no');
  }
  if (identity.zohoContactId) {
    const row = await db.supplier.findUnique({ where: { zohoContactId: identity.zohoContactId } });
    if (row) push(row, 'zoho_contact');
  }
  const normalizedName = normalizeCompanyName(identity.name);
  const firstWord = normalizedName.split(' ')[0] ?? '';
  const domain =
    extractDomain(identity.domain) ?? extractDomain(identity.url) ?? extractDomain(identity.email);
  const phone = normalizePhone(identity.phone);
  const or: Prisma.SupplierWhereInput[] = [];
  if (firstWord.length >= 3) or.push({ name: { contains: firstWord, mode: 'insensitive' } });
  if (domain) {
    or.push({ website: { contains: domain, mode: 'insensitive' } });
    or.push({ primaryEmail: { contains: domain, mode: 'insensitive' } });
  }
  if (phone) or.push({ primaryPhone: { contains: phone.slice(-8) } });
  if (or.length > 0) {
    const rows = await db.supplier.findMany({
      where: { OR: or },
      take: 200,
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) {
      const match = matchExistingSupplier(identity, [
        { ...row, channels: parseChannels(row.channels) },
      ]);
      if (match) push(row, match.reason);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function createSupplierInTx(
  tx: Db,
  input: CreateSupplierInput,
  ctx: CommandContext,
  options: { sourceCandidateId?: string | null } = {}
): Promise<Supplier> {
  const channels = parseChannels(input.channels);
  const primaryPhone = primaryPhoneOf(channels, input.primaryPhone);
  const primaryEmail = primaryEmailOf(channels, input.primaryEmail ?? null);
  const website = websiteOf(channels, input.website);
  if (input.zohoContactId) {
    const contact = await tx.contact.findUnique({
      where: { zohoContactId: input.zohoContactId },
      select: { id: true },
    });
    if (!contact) throw new OperationsError('not_found', 'No se encontró el proveedor en Zoho');
  }
  const similar = await findSimilarSuppliers(tx, {
    name: input.name,
    url: website,
    email: primaryEmail,
    phone: primaryPhone,
    taxRegNo: input.taxRegNo ?? null,
    zohoContactId: input.zohoContactId ?? null,
  });
  const blocking = similar.find((s) => s.reason !== 'name' || !input.allowSimilarName);
  if (blocking) {
    const reasons: Record<string, string> = {
      tax_reg_no: 'el mismo RFC',
      zoho_contact: 'el mismo proveedor de Zoho',
      domain: 'el mismo sitio o dominio de correo',
      phone: 'el mismo teléfono',
      name: 'un nombre muy parecido',
    };
    throw new OperationsError(
      'duplicate',
      `Ya existe el proveedor ${blocking.supplier.number} (${blocking.supplier.name}) con ${reasons[blocking.reason]}`,
      { details: { supplierId: blocking.supplier.id, reason: blocking.reason } }
    );
  }
  const number = await nextFolio(tx, 'supplier');
  const supplier = await tx.supplier.create({
    data: {
      number,
      name: input.name,
      legalName: input.legalName ?? null,
      taxRegNo: input.taxRegNo ?? null,
      zohoContactId: input.zohoContactId ?? null,
      status: 'active',
      channels: channels as unknown as Prisma.InputJsonValue,
      primaryPhone,
      primaryEmail,
      website,
      paymentMode: input.paymentMode,
      paymentTermsDays: input.paymentTermsDays ?? null,
      currency: input.currency,
      leadTimeDaysDefault: input.leadTimeDaysDefault ?? null,
      freightTerms: input.freightTerms ?? null,
      sourceCandidateId: options.sourceCandidateId ?? null,
      tags: [...new Set(input.tags)],
      notes: input.notes ?? null,
      createdByUserId: recordActorId(ctx),
    },
  });
  emitPurchases(
    ctx,
    EV.created,
    {
      supplierId: supplier.id,
      number,
      name: supplier.name,
      sourceCandidateId: supplier.sourceCandidateId,
    },
    { objectType: OBJ.supplier, objectId: supplier.id }
  );
  if (supplier.zohoContactId) {
    await ctx.relate(
      { type: OBJ.supplier, id: supplier.id },
      { type: 'zoho_contact', id: supplier.zohoContactId },
      'same_as'
    );
  }
  publishBoard(ctx, { supplierId: supplier.id });
  return supplier;
}

export async function updateSupplierInTx(
  tx: Db,
  input: UpdateSupplierInput,
  ctx: CommandContext
): Promise<Supplier> {
  const current = assertFoundRow(
    await tx.supplier.findUnique({ where: { id: input.supplierId } }),
    'No se encontró el proveedor'
  );
  const channels =
    input.channels !== undefined ? parseChannels(input.channels) : parseChannels(current.channels);
  if (input.taxRegNo && input.taxRegNo !== current.taxRegNo) {
    const other = await tx.supplier.findFirst({
      where: { taxRegNo: input.taxRegNo, id: { not: current.id } },
    });
    if (other)
      throw new OperationsError(
        'duplicate',
        `El RFC ya pertenece al proveedor ${other.number} (${other.name})`
      );
  }
  const data: Prisma.SupplierUpdateInput = {};
  const assign = <K extends keyof UpdateSupplierInput>(
    key: K,
    column: keyof Prisma.SupplierUpdateInput = key as never
  ) => {
    if (input[key] !== undefined)
      (data as Record<string, unknown>)[column as string] = input[key] ?? null;
  };
  assign('name');
  assign('legalName');
  assign('taxRegNo');
  assign('paymentMode');
  assign('paymentTermsDays');
  assign('currency');
  assign('leadTimeDaysDefault');
  assign('freightTerms');
  assign('notes');
  assign('status');
  if (input.tags !== undefined) data.tags = [...new Set(input.tags)];
  if (input.channels !== undefined) data.channels = channels as unknown as Prisma.InputJsonValue;
  if (input.primaryPhone !== undefined || input.channels !== undefined) {
    data.primaryPhone = primaryPhoneOf(
      channels,
      input.primaryPhone === undefined ? current.primaryPhone : input.primaryPhone
    );
  }
  if (input.primaryEmail !== undefined || input.channels !== undefined) {
    data.primaryEmail = primaryEmailOf(
      channels,
      input.primaryEmail === undefined ? current.primaryEmail : input.primaryEmail
    );
  }
  if (input.website !== undefined || input.channels !== undefined) {
    data.website = websiteOf(
      channels,
      input.website === undefined ? current.website : input.website
    );
  }
  const updated = await tx.supplier.update({ where: { id: current.id }, data });
  const fields = Object.keys(data);
  emitPurchases(
    ctx,
    EV.updated,
    { supplierId: updated.id, fields, status: updated.status, previousStatus: current.status },
    { objectType: OBJ.supplier, objectId: updated.id }
  );
  publishBoard(ctx, { supplierId: updated.id });
  return updated;
}

export async function linkSupplierToZohoContactInTx(
  tx: Db,
  input: z.output<typeof linkZohoContactSchema>,
  ctx: CommandContext
): Promise<Supplier> {
  const supplier = assertFoundRow(
    await tx.supplier.findUnique({ where: { id: input.supplierId } }),
    'No se encontró el proveedor'
  );
  if (input.zohoContactId) {
    const contact = await tx.contact.findUnique({
      where: { zohoContactId: input.zohoContactId },
      select: { zohoContactId: true, contactType: true, contactName: true },
    });
    if (!contact) throw new OperationsError('not_found', 'No se encontró el contacto en Zoho');
    if (contact.contactType && contact.contactType !== 'vendor') {
      throw new OperationsError('invalid_payload', 'El contacto de Zoho no es un proveedor');
    }
    const other = await tx.supplier.findUnique({ where: { zohoContactId: input.zohoContactId } });
    if (other && other.id !== supplier.id) {
      throw new OperationsError(
        'duplicate',
        `Ese proveedor de Zoho ya está ligado a ${other.number} (${other.name})`
      );
    }
  }
  const updated = await tx.supplier.update({
    where: { id: supplier.id },
    data: { zohoContactId: input.zohoContactId },
  });
  if (input.zohoContactId) {
    await ctx.relate(
      { type: OBJ.supplier, id: supplier.id },
      { type: 'zoho_contact', id: input.zohoContactId },
      'same_as'
    );
  }
  emitPurchases(
    ctx,
    EV.linkedZoho,
    {
      supplierId: supplier.id,
      zohoContactId: input.zohoContactId,
      previous: supplier.zohoContactId,
    },
    { objectType: OBJ.supplier, objectId: supplier.id }
  );
  return updated;
}

export async function upsertSupplierProductInTx(
  tx: Db,
  input: UpsertSupplierProductInput,
  ctx: CommandContext
): Promise<SupplierProduct> {
  const supplier = assertFoundRow(
    await tx.supplier.findUnique({ where: { id: input.supplierId } }),
    'No se encontró el proveedor'
  );
  const zohoItemId = input.zohoItemId ?? '';
  const supplierSku = input.supplierSku ?? '';
  const data = {
    description: input.description,
    unit: input.unit,
    unitFactorToBase: D(input.unitFactorToBase),
    currency: input.currency,
    leadTimeDays: input.leadTimeDays ?? null,
    minOrderQty:
      input.minOrderQty === null || input.minOrderQty === undefined ? null : D(input.minOrderQty),
    source: input.source,
    ...(input.lastPrice !== null && input.lastPrice !== undefined
      ? { lastPrice: D(input.lastPrice), lastQuotedAt: ctx.now }
      : {}),
  };
  const existing = await tx.supplierProduct.findFirst({
    where: { supplierId: supplier.id, zohoItemId, supplierSku },
  });
  const product = existing
    ? await tx.supplierProduct.update({ where: { id: existing.id }, data })
    : await tx.supplierProduct.create({
        data: { supplierId: supplier.id, zohoItemId, supplierSku, ...data },
      });
  emitPurchases(
    ctx,
    EV.productUpserted,
    {
      supplierId: supplier.id,
      supplierProductId: product.id,
      zohoItemId: product.zohoItemId || null,
      lastPrice: product.lastPrice?.toString() ?? null,
      created: !existing,
    },
    { objectType: OBJ.supplierProduct, objectId: product.id }
  );
  return product;
}

/**
 * Records the last known price of an item for a supplier (from an approved
 * order or a selected quote) without overwriting a newer quote.
 */
export async function touchSupplierProductPrice(
  tx: Db,
  input: {
    supplierId: string;
    zohoItemId: string | null;
    description: string;
    unit: string;
    price: Prisma.Decimal.Value;
    currency: string;
    leadTimeDays?: number | null;
    source: 'rfq' | 'receipt' | 'manual';
    at: Date;
  }
): Promise<SupplierProduct | null> {
  if (!input.zohoItemId) return null;
  const existing = await tx.supplierProduct.findFirst({
    where: { supplierId: input.supplierId, zohoItemId: input.zohoItemId, supplierSku: '' },
  });
  if (existing?.lastQuotedAt && existing.lastQuotedAt.getTime() > input.at.getTime())
    return existing;
  const data = {
    description: input.description.slice(0, 300),
    unit: input.unit,
    lastPrice: D(input.price),
    currency: input.currency,
    lastQuotedAt: input.at,
    source: input.source,
    ...(input.leadTimeDays !== undefined && input.leadTimeDays !== null
      ? { leadTimeDays: input.leadTimeDays }
      : {}),
  };
  return existing
    ? tx.supplierProduct.update({ where: { id: existing.id }, data })
    : tx.supplierProduct.create({
        data: {
          supplierId: input.supplierId,
          zohoItemId: input.zohoItemId,
          supplierSku: '',
          ...data,
        },
      });
}

export async function recordSupplierEvaluationInTx(
  tx: Db,
  input: EvaluateSupplierInput,
  ctx: CommandContext
): Promise<{ evaluation: SupplierEvaluation; supplier: Supplier }> {
  const supplier = assertFoundRow(
    await tx.supplier.findUnique({ where: { id: input.supplierId } }),
    'No se encontró el proveedor'
  );
  if (input.orderId) {
    const order = await tx.procurementOrder.findUnique({
      where: { id: input.orderId },
      select: { supplierId: true },
    });
    if (!order || order.supplierId !== supplier.id) {
      throw new OperationsError('invalid_payload', 'La orden no es de este proveedor');
    }
  }
  if (input.receiptId) {
    const receipt = await tx.goodsReceipt.findUnique({
      where: { id: input.receiptId },
      select: { orderId: true },
    });
    const order = receipt
      ? await tx.procurementOrder.findUnique({
          where: { id: receipt.orderId },
          select: { supplierId: true },
        })
      : null;
    if (!order || order.supplierId !== supplier.id) {
      throw new OperationsError('invalid_payload', 'La recepción no es de este proveedor');
    }
  }
  const evaluatedBy = recordActorId(ctx);
  if (input.orderId) {
    const repeated = await tx.supplierEvaluation.findFirst({
      where: { supplierId: supplier.id, orderId: input.orderId, evaluatedByUserId: evaluatedBy },
      select: { id: true },
    });
    if (repeated)
      throw new OperationsError('duplicate', 'Ya evaluaste a este proveedor por esta orden');
  }
  const evaluation = await tx.supplierEvaluation.create({
    data: {
      supplierId: supplier.id,
      orderId: input.orderId ?? null,
      receiptId: input.receiptId ?? null,
      onTime: input.onTime,
      quality: input.quality,
      price: input.price,
      communication: input.communication,
      comment: input.comment ?? null,
      evaluatedByUserId: evaluatedBy,
    },
  });
  const history = await tx.supplierEvaluation.findMany({
    where: { supplierId: supplier.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { onTime: true, quality: true, price: true, communication: true, createdAt: true },
  });
  const rating = computeSupplierRating(history, ctx.now);
  const dec = (value: number | null) => (value === null ? null : new Prisma.Decimal(value));
  const updated = await tx.supplier.update({
    where: { id: supplier.id },
    data: {
      ratingOverall: dec(rating.overall),
      ratingOnTime: dec(rating.onTime),
      ratingQuality: dec(rating.quality),
      ratingPrice: dec(rating.price),
      evaluationsCount: rating.count,
      lastEvaluatedAt: rating.lastEvaluatedAt,
      version: { increment: 1 },
    },
  });
  emitPurchases(
    ctx,
    EV.evaluated,
    {
      supplierId: supplier.id,
      evaluationId: evaluation.id,
      orderId: evaluation.orderId,
      ratingOverall: rating.overall,
      evaluationsCount: rating.count,
    },
    { objectType: OBJ.supplier, objectId: supplier.id }
  );
  return { evaluation, supplier: updated };
}

// ---------------------------------------------------------------------------
// Promotion of a sourcing candidate
// ---------------------------------------------------------------------------

/**
 * Turns a candidate into a supplier. When the candidate already matches a
 * supplier (same domain/phone/name) the existing one is linked instead of
 * creating a duplicate; a matching Zoho vendor is linked on creation.
 * `bumpCandidateVersion` is for callers whose command aggregate is not the candidate.
 */
export async function promoteCandidateToSupplierInTx(
  tx: Db,
  input: PromoteCandidateInput,
  ctx: CommandContext,
  options: { bumpCandidateVersion?: boolean } = {}
): Promise<{ supplier: Supplier; created: boolean; candidate: SourcingCandidate }> {
  const candidate = assertFoundRow(
    await tx.sourcingCandidate.findUnique({ where: { id: input.candidateId } }),
    'No se encontró el candidato'
  );
  if (candidate.status === 'rejected') {
    throw new OperationsError(
      'invalid_state',
      'El candidato fue descartado; reactívalo antes de promoverlo'
    );
  }
  let supplier: Supplier | null = null;
  let created = false;
  if (candidate.supplierId) {
    supplier = await tx.supplier.findUnique({ where: { id: candidate.supplierId } });
  }
  if (!supplier) {
    supplier = await tx.supplier.findUnique({ where: { sourceCandidateId: candidate.id } });
  }
  const identity: CandidateIdentity = {
    name: input.name ?? candidate.name,
    url: candidate.url,
    domain: candidate.domain,
    email: candidate.email,
    phone: candidate.phone,
  };
  if (!supplier) {
    const similar = await findSimilarSuppliers(tx, identity);
    const strong = similar.find((s) => s.reason !== 'name');
    if (strong) supplier = strong.supplier;
  }
  if (!supplier) {
    const channels: SupplierChannel[] = input.channels
      ? parseChannels(input.channels)
      : parseChannels([
          ...(candidate.phone ? [{ type: 'whatsapp', value: candidate.phone }] : []),
          ...(candidate.email ? [{ type: 'email', value: candidate.email }] : []),
          ...(candidate.url ? [{ type: 'web', value: candidate.url }] : []),
        ]);
    const vendorWhere: Prisma.ContactWhereInput[] = [];
    const domain = extractDomain(candidate.domain) ?? extractDomain(candidate.url);
    const phone = normalizePhone(candidate.phone);
    if (domain) vendorWhere.push({ website: { contains: domain, mode: 'insensitive' } });
    if (phone)
      vendorWhere.push(
        { primaryPhone: { contains: phone.slice(-8) } },
        { mobile: { contains: phone.slice(-8) } }
      );
    const firstWord = normalizeCompanyName(identity.name).split(' ')[0] ?? '';
    if (firstWord.length >= 3)
      vendorWhere.push({ companyName: { contains: firstWord, mode: 'insensitive' } });
    const vendors = vendorWhere.length
      ? await tx.contact.findMany({
          where: { contactType: 'vendor', OR: vendorWhere },
          take: 50,
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
    const vendor = matchVendorContact(identity, vendors);
    const linkedVendor =
      vendor &&
      !(await tx.supplier.findUnique({
        where: { zohoContactId: vendor.zohoContactId },
        select: { id: true },
      }))
        ? vendor.zohoContactId
        : null;
    supplier = await createSupplierInTx(
      tx,
      {
        name: identity.name,
        legalName: null,
        taxRegNo: null,
        zohoContactId: linkedVendor,
        channels,
        primaryPhone: candidate.phone,
        primaryEmail: candidate.email,
        website: candidate.url,
        paymentMode: input.paymentMode ?? 'prepaid',
        paymentTermsDays: input.paymentTermsDays ?? null,
        currency: 'MXN',
        leadTimeDaysDefault: input.leadTimeDaysDefault ?? null,
        freightTerms: null,
        tags: ['sourcing'],
        notes: candidate.productsSummary
          ? `Encontrado en el laboratorio de sourcing: ${candidate.productsSummary}`.slice(0, 2000)
          : null,
        allowSimilarName: true,
      },
      ctx,
      { sourceCandidateId: candidate.id }
    );
    created = true;
  }
  const updatedCandidate = await tx.sourcingCandidate.update({
    where: { id: candidate.id },
    data: {
      status: 'promoted',
      supplierId: supplier.id,
      ...(options.bumpCandidateVersion ? { version: { increment: 1 } } : {}),
    },
  });
  await ctx.relate(
    { type: OBJ.candidate, id: candidate.id },
    { type: OBJ.supplier, id: supplier.id },
    'promoted_to'
  );
  emitPurchases(
    ctx,
    EV.promoted,
    {
      candidateId: candidate.id,
      supplierId: supplier.id,
      supplierNumber: supplier.number,
      created,
    },
    { objectType: OBJ.supplier, objectId: supplier.id }
  );
  publishBoard(ctx, { supplierId: supplier.id, candidateId: candidate.id });
  return { supplier, created, candidate: updatedCandidate };
}

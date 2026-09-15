import type { Prisma, Rfq, RfqLine, RfqResponse, RfqResponseLine } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { chatCompletion } from '@/modules/ai/ai-client';
import { wrapUntrusted } from '@/modules/ai/ai-guardrails';
import { modelForTask } from '@/modules/ai/model-policy';
import type { CurrentUser } from '@/modules/auth/authorization';
import { startConversation } from '@/modules/comms/comms-service';
import { toUnitProfile } from '@/modules/inventory/profiles-service';
import { enqueueJob, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { executeCommand, type CommandContext, type CommandResult } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';
import { completeWorkItemInTx } from '@/modules/operations/work-items-service';
import { hasMessagingConsent, whatsappWindowOpen } from './messaging-eligibility';
import { createOrderInTx } from './orders-service';
import {
  D,
  addDays,
  assertFoundRow,
  emitPurchases,
  isoDay,
  nextFolio,
  num,
  numOrNull,
  parseChannels,
  publishBoard,
  purchaseNotificationCategory,
  recordActorId,
  round4,
  truncate,
  type Db,
} from './purchases-helpers';
import {
  currencyCode,
  idText,
  isoDateText,
  moneyAmount,
  optionalText,
  positiveQty,
  rateFraction,
  requiredText,
  toDate,
} from './purchases-schemas';
import {
  CHANNEL_PROVIDER,
  MESSAGING_CHANNEL_TYPES,
  ORDER_DELIVERY_MODES,
  PURCHASES_COMMANDS,
  PURCHASES_EVENTS,
  PURCHASES_JOB_TYPES,
  PURCHASES_OBJECT_TYPES,
  RFQ_CONVERSATION_TAG_PREFIX,
  RFQ_RESPONSE_STATUS_LABELS,
  SUPPLIER_CHANNEL_LABELS,
  type MessagingChannelType,
} from './purchases-types';
import { markRequestsStage, recomputeRequestStatuses } from './requests-service';
import { DEFAULT_TAX_RATE, computeLandedCosts, scoreRfqResponses, type ResponseScore, type ScoringResponse, type ScoringRfqLine } from './rfq-scoring';
import {
  buildRfqInterpretationPrompt,
  decideResponseStatus,
  extractJsonObject,
  mapInterpretationLines,
  renderRfqMessage,
  rfqInterpretationSchema,
  rfqLineRef,
  rfqTemplateVariables,
  type RfqInterpretation,
} from './rfq-rules';
import { loadSourcingConfig } from './sourcing-config';
import { promoteCandidateToSupplierInTx, touchSupplierProductPrice } from './suppliers-service';
import { baseUnitsPer, canonicalUnit, resolveUnitFactor, type UnitProfileLike } from './unit-normalizer';

/**
 * RFQ by messaging (plan 6.1, flow "RFQ por WhatsApp").
 *
 * createRfq (lines from purchase requests or free) → inviteSuppliers (one
 * invitation per supplier/candidate and channel, rendered with the configurable
 * template; the send goes through `startConversation` — consent, account
 * access and adapter idempotency — and the conversation is tagged `rfq:{id}`) →
 * the messaging fan-out calls `interpretRfqReplyIfTagged(messageId)` →
 * `purchases.rfq_interpret` (utility model, JSON validated by
 * `rfqInterpretationSchema`, units normalized) → response `parsed` or
 * `needs_review` → confirmResponse / manual response → compareRfq (landed cost
 * scoring) → selectResponse creates the draft procurement order.
 */

const OBJ = PURCHASES_OBJECT_TYPES;
const EV = PURCHASES_EVENTS.rfq;
const INTERPRET_DELAY_MS = 45_000;
const TRANSCRIPT_MAX_CHARS = 8_000;
const RFQ_REVIEW_OBJECT = OBJ.rfqResponse;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'purchases-rfq', event, ...extra }));

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const rfqLineInputSchema = z.object({
  requestLineId: idText.nullish(),
  zohoItemId: idText.nullish(),
  description: optionalText(300),
  qty: positiveQty.nullish(),
  unit: optionalText(40),
  specs: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).nullish(),
  /** Request lines consolidated in this line (each keeps its demand when the order is created). */
  sources: z.array(z.object({ requestLineId: idText, qty: positiveQty })).max(100).optional(),
});

export const createRfqSchema = z.object({
  title: requiredText(200, 'Indica el título de la cotización'),
  dueAt: isoDateText.nullish(),
  sourcingSearchId: idText.nullish(),
  lines: z.array(rfqLineInputSchema).min(1, 'Agrega al menos una línea').max(100),
});
export type CreateRfqInput = z.output<typeof createRfqSchema>;

export const inviteeSchema = z
  .object({
    supplierId: idText.nullish(),
    candidateId: idText.nullish(),
    channel: z.enum(MESSAGING_CHANNEL_TYPES).nullish(),
  })
  .refine((value) => Boolean(value.supplierId) !== Boolean(value.candidateId), {
    message: 'Indica un proveedor o un candidato (no ambos)',
  });

export const inviteSuppliersSchema = z.object({
  rfqId: idText,
  invitees: z.array(inviteeSchema).min(1, 'Elige al menos un proveedor').max(30),
});
export type InviteSuppliersInput = z.output<typeof inviteSuppliersSchema>;

export const recordSendsSchema = z.object({
  rfqId: idText,
  results: z
    .array(
      z.object({
        invitationId: idText,
        status: z.enum(['sent', 'failed']),
        conversationId: idText.nullish(),
        messageId: idText.nullish(),
        error: optionalText(500),
      })
    )
    .min(1)
    .max(30),
});

export const recordInterpretationSchema = z.object({
  invitationId: idText,
  messageIds: z.array(idText).max(100),
  interpretation: z.record(z.unknown()).nullable(),
  error: optionalText(500),
  model: optionalText(120),
});

const responseTerms = {
  currency: currencyCode,
  exchangeRate: positiveQty.nullish(),
  taxIncluded: z.boolean(),
  taxRate: rateFraction.nullish(),
  freight: moneyAmount,
  otherCosts: moneyAmount,
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  validUntil: isoDateText.nullish(),
  paymentTerms: optionalText(200),
};

export const responseLineInputSchema = z.object({
  rfqLineId: idText,
  unitPrice: moneyAmount,
  qty: positiveQty.nullish(),
  unit: optionalText(40),
  /** Quoted units that make one unit of the RFQ line (when the units cannot be converted automatically). */
  unitsPerRfqUnit: positiveQty.nullish(),
});
export type ResponseLineInput = z.output<typeof responseLineInputSchema>;

export const manualResponseSchema = z
  .object({
    rfqId: idText,
    supplierId: idText.nullish(),
    candidateId: idText.nullish(),
    currency: responseTerms.currency.default('MXN'),
    exchangeRate: responseTerms.exchangeRate,
    taxIncluded: responseTerms.taxIncluded.default(false),
    taxRate: responseTerms.taxRate,
    freight: responseTerms.freight.default(0),
    otherCosts: responseTerms.otherCosts.default(0),
    leadTimeDays: responseTerms.leadTimeDays,
    validUntil: responseTerms.validUntil,
    paymentTerms: responseTerms.paymentTerms,
    lines: z.array(responseLineInputSchema).min(1, 'Captura al menos un precio').max(100),
  })
  .refine((value) => Boolean(value.supplierId) !== Boolean(value.candidateId), {
    message: 'Indica el proveedor o el candidato que cotizó',
  });
export type ManualResponseInput = z.output<typeof manualResponseSchema>;

export const confirmResponseSchema = z.object({
  responseId: idText,
  currency: responseTerms.currency.optional(),
  exchangeRate: responseTerms.exchangeRate,
  taxIncluded: responseTerms.taxIncluded.optional(),
  taxRate: responseTerms.taxRate,
  freight: responseTerms.freight.optional(),
  otherCosts: responseTerms.otherCosts.optional(),
  leadTimeDays: responseTerms.leadTimeDays,
  validUntil: responseTerms.validUntil,
  paymentTerms: responseTerms.paymentTerms,
  lines: z.array(responseLineInputSchema).min(1).max(100).optional(),
});
export type ConfirmResponseInput = z.output<typeof confirmResponseSchema>;

export const rejectResponseSchema = z.object({
  responseId: idText,
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});

export const rfqIdSchema = z.object({ rfqId: idText });

export const selectResponseSchema = z.object({
  responseId: idText,
  deliveryMode: z.enum(ORDER_DELIVERY_MODES).optional(),
  warehouseId: idText.nullish(),
  directDeliveryCaseId: idText.nullish(),
  expectedAt: isoDateText.nullish(),
  notes: optionalText(2000),
});

export const cancelRfqSchema = z.object({
  rfqId: idText,
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});

// ---------------------------------------------------------------------------
// Units of a response line
// ---------------------------------------------------------------------------

async function profilesFor(db: Db, zohoItemIds: Iterable<string | null>): Promise<Map<string, UnitProfileLike>> {
  const ids = [...new Set([...zohoItemIds].filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await db.productInventoryProfile.findMany({ where: { zohoItemId: { in: ids } } });
  return new Map(rows.map((row) => [row.zohoItemId, toUnitProfile(row)]));
}

/**
 * Base of an RFQ line: the item profile base unit when the RFQ unit converts
 * to it, else the RFQ line unit itself. `RfqResponseLine.unitFactorToBase` is
 * always "base units per quoted unit" in that base.
 */
export function rfqLineBase(line: Pick<RfqLine, 'unit'>, profile: UnitProfileLike | null): { unit: string; perRfqUnit: number } {
  if (profile) {
    const factor = baseUnitsPer(line.unit, profile);
    if (factor !== null) return { unit: profile.baseUnit, perRfqUnit: factor };
  }
  return { unit: line.unit, perRfqUnit: 1 };
}

/** Quoted units per RFQ unit from the stored factor. */
export function unitsPerRfqUnitOf(line: Pick<RfqLine, 'unit'>, responseLine: Pick<RfqResponseLine, 'unitFactorToBase'>, profile: UnitProfileLike | null): number | null {
  const factor = num(responseLine.unitFactorToBase);
  if (!(factor > 0)) return null;
  return rfqLineBase(line, profile).perRfqUnit / factor;
}

/** Quoted units per RFQ unit from the unit names (null when they do not convert). */
export function resolveQuotedUnits(rfqLine: Pick<RfqLine, 'unit'>, quotedUnit: string | null, profile: UnitProfileLike | null): number | null {
  if (!quotedUnit || canonicalUnit(quotedUnit) === canonicalUnit(rfqLine.unit)) return 1;
  return resolveUnitFactor(rfqLine.unit, quotedUnit, profile);
}

interface PreparedResponseLine {
  rfqLineId: string;
  unitPrice: number;
  qty: number;
  unit: string;
  unitFactorToBase: number;
  unitsPerRfqUnit: number;
}

function prepareResponseLines(
  rfqLines: readonly RfqLine[],
  inputs: readonly ResponseLineInput[],
  profiles: Map<string, UnitProfileLike>
): PreparedResponseLine[] {
  const seen = new Set<string>();
  return inputs.map((input) => {
    const rfqLine = rfqLines.find((l) => l.id === input.rfqLineId);
    if (!rfqLine) throw new OperationsError('invalid_payload', 'Algún precio es de una línea que no está en la cotización');
    if (seen.has(rfqLine.id)) throw new OperationsError('invalid_payload', 'Una línea tiene dos precios');
    seen.add(rfqLine.id);
    const profile = rfqLine.zohoItemId ? (profiles.get(rfqLine.zohoItemId) ?? null) : null;
    const unit = input.unit ?? rfqLine.unit;
    const units = input.unitsPerRfqUnit ?? resolveQuotedUnits(rfqLine, unit, profile);
    if (units === null || !(units > 0)) {
      throw new OperationsError(
        'invalid_unit',
        `No se puede convertir ${unit} a ${rfqLine.unit} en "${truncate(rfqLine.description, 60)}": indica cuántas ${unit} hacen un ${rfqLine.unit}`
      );
    }
    const base = rfqLineBase(rfqLine, profile);
    return {
      rfqLineId: rfqLine.id,
      unitPrice: input.unitPrice,
      qty: input.qty ?? round4(num(rfqLine.qty) * units),
      unit,
      unitFactorToBase: base.perRfqUnit / units,
      unitsPerRfqUnit: units,
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring inputs (compare command and read side)
// ---------------------------------------------------------------------------

export interface RfqScoringInputs {
  rfq: Rfq;
  lines: RfqLine[];
  scoringLines: ScoringRfqLine[];
  responses: Array<{ row: RfqResponse; lines: RfqResponseLine[]; name: string | null; scoring: ScoringResponse }>;
}

export async function loadRfqScoringInputs(db: Db, rfqId: string): Promise<RfqScoringInputs> {
  const rfq = assertFoundRow(await db.rfq.findUnique({ where: { id: rfqId } }), 'No se encontró la cotización');
  const lines = await db.rfqLine.findMany({ where: { rfqId }, orderBy: { sortOrder: 'asc' } });
  const rows = await db.rfqResponse.findMany({ where: { rfqId, status: { not: 'rejected' } }, orderBy: { createdAt: 'asc' } });
  const responseLines = rows.length
    ? await db.rfqResponseLine.findMany({ where: { responseId: { in: rows.map((r) => r.id) } } })
    : [];
  const suppliers = await db.supplier.findMany({
    where: { id: { in: rows.map((r) => r.supplierId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, name: true, ratingOverall: true, evaluationsCount: true },
  });
  const candidates = await db.sourcingCandidate.findMany({
    where: { id: { in: rows.map((r) => r.candidateId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, name: true, supplierId: true },
  });
  const profiles = await profilesFor(db, lines.map((l) => l.zohoItemId));
  return {
    rfq,
    lines,
    scoringLines: lines.map((line) => ({ id: line.id, qty: num(line.qty), unit: line.unit, description: line.description })),
    responses: rows.map((row) => {
      const supplier = suppliers.find((s) => s.id === row.supplierId);
      const candidate = candidates.find((c) => c.id === row.candidateId);
      const own = responseLines.filter((l) => l.responseId === row.id);
      return {
        row,
        lines: own,
        name: supplier?.name ?? candidate?.name ?? null,
        scoring: {
          id: row.id,
          currency: row.currency,
          exchangeRate: numOrNull(row.exchangeRate),
          taxIncluded: row.taxIncluded,
          taxRate: numOrNull(row.taxRate),
          freight: num(row.freight),
          otherCosts: num(row.otherCosts),
          leadTimeDays: row.leadTimeDays,
          validUntil: row.validUntil,
          confidence: row.status === 'confirmed' || row.receivedVia === 'manual' ? null : numOrNull(row.confidence),
          supplierRating: numOrNull(supplier?.ratingOverall),
          evaluationsCount: supplier?.evaluationsCount ?? 0,
          isCandidate: !row.supplierId && !candidate?.supplierId,
          lines: own.map((line) => {
            const rfqLine = lines.find((l) => l.id === line.rfqLineId);
            const profile = rfqLine?.zohoItemId ? (profiles.get(rfqLine.zohoItemId) ?? null) : null;
            return {
              rfqLineId: line.rfqLineId,
              unitPrice: num(line.unitPrice),
              qty: num(line.qty),
              unit: line.unit,
              unitsPerRfqUnit: rfqLine ? unitsPerRfqUnitOf(rfqLine, line, profile) : null,
            };
          }),
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createRfqInTx(tx: Db, input: CreateRfqInput, ctx: CommandContext): Promise<{ rfq: Rfq; lines: RfqLine[] }> {
  if (input.sourcingSearchId) {
    assertFoundRow(await tx.sourcingSearch.findUnique({ where: { id: input.sourcingSearchId }, select: { id: true } }), 'No se encontró la búsqueda del laboratorio');
  }
  const config = await loadSourcingConfig(tx);
  const prepared: Array<{ requestLineId: string | null; zohoItemId: string | null; description: string; qty: number; unit: string; specs: Record<string, unknown> | null }> = [];
  const requestIds = new Set<string>();
  for (const line of input.lines) {
    const sources = [];
    for (const source of line.sources ?? []) {
      const sourceLine = await tx.purchaseRequestLine.findUnique({ where: { id: source.requestLineId } });
      if (!sourceLine || sourceLine.status === 'cancelled' || sourceLine.status === 'received') {
        throw new OperationsError('invalid_state', 'Alguna partida consolidada ya no está pendiente');
      }
      requestIds.add(sourceLine.requestId);
      sources.push({ line: sourceLine, qty: source.qty });
    }
    if (line.requestLineId && sources.length > 0) {
      throw new OperationsError('invalid_payload', 'Una línea viene de una solicitud o de varias consolidadas, no de ambas');
    }
    const requestLine = line.requestLineId ? await tx.purchaseRequestLine.findUnique({ where: { id: line.requestLineId } }) : sources[0]?.line ?? null;
    if (line.requestLineId) {
      if (!requestLine || requestLine.status === 'cancelled' || requestLine.status === 'received') {
        throw new OperationsError('invalid_state', 'Alguna partida de solicitud ya no está pendiente');
      }
      requestIds.add(requestLine.requestId);
    }
    const remaining = requestLine ? Math.max(0, num(requestLine.qty) - num(requestLine.qtyOrdered)) : 0;
    const description = line.description ?? requestLine?.description ?? null;
    const unit = line.unit ?? requestLine?.unit ?? null;
    const qty = line.qty ?? (remaining > 0 ? remaining : requestLine ? num(requestLine.qty) : null);
    if (!description) throw new OperationsError('invalid_payload', 'Describe cada línea de la cotización');
    if (!unit) throw new OperationsError('invalid_payload', `Indica la unidad de "${truncate(description, 60)}"`);
    if (!qty || qty <= 0) throw new OperationsError('invalid_payload', `Indica la cantidad de "${truncate(description, 60)}"`);
    const sourceTotal = sources.reduce((sum, source) => sum + source.qty, 0);
    prepared.push({
      requestLineId: sources.length > 0 ? null : (requestLine?.id ?? null),
      zohoItemId: line.zohoItemId ?? requestLine?.zohoItemId ?? null,
      description,
      qty: sources.length > 0 && !line.qty ? round4(sourceTotal) : qty,
      unit,
      specs:
        sources.length > 0
          ? { ...(line.specs ?? {}), requestSources: sources.map((source) => ({ requestLineId: source.line.id, qty: source.qty })) }
          : (line.specs ?? null),
    });
  }
  const dueAt = toDate(input.dueAt ?? null) ?? addDays(ctx.now, config.rfqDefaultDueDays);
  if (dueAt.getTime() <= ctx.now.getTime()) throw new OperationsError('invalid_payload', 'La fecha límite debe ser futura');
  const number = await nextFolio(tx, 'rfq');
  const rfq = await tx.rfq.create({
    data: {
      number,
      title: input.title,
      status: 'draft',
      dueAt,
      sourcingSearchId: input.sourcingSearchId ?? null,
      createdByUserId: recordActorId(ctx),
    },
  });
  const lines: RfqLine[] = [];
  for (const [index, line] of prepared.entries()) {
    lines.push(
      await tx.rfqLine.create({
        data: {
          rfqId: rfq.id,
          requestLineId: line.requestLineId,
          zohoItemId: line.zohoItemId,
          description: line.description,
          qty: D(line.qty),
          unit: line.unit,
          specs: line.specs ? (line.specs as Prisma.InputJsonValue) : undefined,
          sortOrder: index,
        },
      })
    );
  }
  await markRequestsStage(tx, requestIds, 'sourcing', ctx);
  for (const requestId of requestIds) {
    await ctx.relate({ type: OBJ.request, id: requestId }, { type: OBJ.rfq, id: rfq.id }, 'quoted_in');
  }
  emitPurchases(
    ctx,
    EV.created,
    { rfqId: rfq.id, number, title: rfq.title, lines: lines.length, dueAt: dueAt.toISOString(), requestIds: [...requestIds] },
    { objectType: OBJ.rfq, objectId: rfq.id }
  );
  publishBoard(ctx, { rfqId: rfq.id });
  return { rfq, lines };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface InvitationToSend {
  invitationId: string;
  name: string;
  channel: MessagingChannelType;
  accountId: string;
  to: string;
  body: string;
  templateKey: string | null;
  /** Parameters of the approved WhatsApp template ({{1}}…{{6}}), with `templateKey`. */
  templateVariables: Record<string, string> | null;
}

export interface InviteSuppliersData {
  rfqId: string;
  number: string;
  toSend: InvitationToSend[];
  failed: Array<{ invitationId: string; name: string; error: string }>;
  skipped: Array<{ supplierId: string | null; candidateId: string | null; reason: string }>;
}

function destinationFor(
  channels: ReadonlyArray<{ type: string; value: string }>,
  fallbackPhone: string | null,
  preferred: MessagingChannelType | null | undefined
): { channel: MessagingChannelType; to: string } | null {
  const order: MessagingChannelType[] = preferred ? [preferred] : ['whatsapp', 'sms', 'telegram'];
  for (const type of order) {
    const explicit = channels.find((c) => c.type === type)?.value;
    if (explicit) return { channel: type, to: explicit };
    if ((type === 'whatsapp' || type === 'sms') && fallbackPhone) {
      const phone = channels.find((c) => c.type === 'phone')?.value ?? fallbackPhone;
      return { channel: type, to: phone };
    }
  }
  return null;
}

async function accountFor(tx: Db, configuredId: string | null, channel: MessagingChannelType) {
  const provider = CHANNEL_PROVIDER[channel];
  if (configuredId) {
    const configured = await tx.commAccount.findUnique({ where: { id: configuredId } });
    if (configured && configured.provider === provider && configured.status === 'active') return configured;
  }
  return tx.commAccount.findFirst({ where: { provider, status: 'active' }, orderBy: { createdAt: 'asc' } });
}

export async function inviteSuppliersInTx(tx: Db, input: InviteSuppliersInput, ctx: CommandContext): Promise<InviteSuppliersData> {
  const rfq = assertFoundRow(await tx.rfq.findUnique({ where: { id: input.rfqId } }), 'No se encontró la cotización');
  if (!['draft', 'sent', 'collecting'].includes(rfq.status)) {
    throw new OperationsError('invalid_state', 'La cotización ya no recibe proveedores');
  }
  const lines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { sortOrder: 'asc' } });
  if (lines.length === 0) throw new OperationsError('invalid_state', 'La cotización no tiene líneas');
  const config = await loadSourcingConfig(tx);
  const existing = await tx.rfqInvitation.findMany({ where: { rfqId: rfq.id } });
  const data: InviteSuppliersData = { rfqId: rfq.id, number: rfq.number, toSend: [], failed: [], skipped: [] };

  for (const invitee of input.invitees) {
    let name: string;
    let channels: ReadonlyArray<{ type: string; value: string }> = [];
    let phone: string | null = null;
    if (invitee.supplierId) {
      const supplier = await tx.supplier.findUnique({ where: { id: invitee.supplierId } });
      if (!supplier) {
        data.skipped.push({ supplierId: invitee.supplierId, candidateId: null, reason: 'No se encontró el proveedor' });
        continue;
      }
      if (supplier.status !== 'active') {
        data.skipped.push({ supplierId: supplier.id, candidateId: null, reason: `${supplier.name} está bloqueado o archivado` });
        continue;
      }
      name = supplier.name;
      channels = parseChannels(supplier.channels);
      phone = supplier.primaryPhone;
    } else {
      const candidate = await tx.sourcingCandidate.findUnique({ where: { id: invitee.candidateId! } });
      if (!candidate) {
        data.skipped.push({ supplierId: null, candidateId: invitee.candidateId ?? null, reason: 'No se encontró el candidato' });
        continue;
      }
      if (candidate.status === 'rejected') {
        data.skipped.push({ supplierId: null, candidateId: candidate.id, reason: `${candidate.name} fue descartado` });
        continue;
      }
      name = candidate.name;
      phone = candidate.phone;
    }
    const destination = destinationFor(channels, phone, invitee.channel);
    if (!destination) {
      data.skipped.push({
        supplierId: invitee.supplierId ?? null,
        candidateId: invitee.candidateId ?? null,
        reason: `${name} no tiene ${invitee.channel ? SUPPLIER_CHANNEL_LABELS[invitee.channel] : 'WhatsApp, SMS ni Telegram'}`,
      });
      continue;
    }
    const duplicate = existing.find(
      (row) =>
        row.channel === destination.channel &&
        (invitee.supplierId ? row.supplierId === invitee.supplierId : row.candidateId === invitee.candidateId) &&
        !['failed', 'expired'].includes(row.status)
    );
    if (duplicate) {
      data.skipped.push({ supplierId: invitee.supplierId ?? null, candidateId: invitee.candidateId ?? null, reason: `${name} ya fue invitado` });
      continue;
    }
    const account = await accountFor(tx, config.rfqAccountId, destination.channel);
    if (account && invitee.candidateId && !(await hasMessagingConsent(tx, { channel: destination.channel, to: destination.to }))) {
      // Found on the web: never messaged cold. Contact it by phone or e-mail, record its consent or promote it.
      data.skipped.push({
        supplierId: null,
        candidateId: invitee.candidateId,
        reason: `${name} es un candidato sin consentimiento para recibir mensajes: pídeselo por teléfono o correo y regístralo, o promuévelo a proveedor`,
      });
      continue;
    }
    const templateKey = destination.channel === 'whatsapp' ? config.rfqTemplateKey : null;
    if (
      account &&
      destination.channel === 'whatsapp' &&
      !templateKey &&
      !(await whatsappWindowOpen(tx, { accountId: account.id, to: destination.to, now: ctx.now }))
    ) {
      data.skipped.push({
        supplierId: invitee.supplierId ?? null,
        candidateId: invitee.candidateId ?? null,
        reason: `WhatsApp sólo permite escribir primero a ${name} con una plantilla aprobada: configura la plantilla de cotización del laboratorio o invítalo por SMS`,
      });
      continue;
    }
    const error = account ? null : `No hay una cuenta de ${SUPPLIER_CHANNEL_LABELS[destination.channel]} activa en la bandeja`;
    const invitation = await tx.rfqInvitation.create({
      data: {
        rfqId: rfq.id,
        supplierId: invitee.supplierId ?? null,
        candidateId: invitee.candidateId ?? null,
        channel: destination.channel,
        accountId: account?.id ?? null,
        status: account ? 'pending' : 'failed',
        error,
      },
    });
    existing.push(invitation);
    if (!account) {
      data.failed.push({ invitationId: invitation.id, name, error: error! });
      continue;
    }
    const messageInput = {
      template: config.rfqMessageTemplate,
      supplierName: name,
      companyName: config.companyName,
      folio: rfq.number,
      title: rfq.title,
      lines: lines.map((line) => ({
        description: line.description,
        qty: num(line.qty),
        unit: line.unit,
        specs: line.specs && typeof line.specs === 'object' && !Array.isArray(line.specs) ? (line.specs as Record<string, unknown>) : null,
      })),
      dueAt: rfq.dueAt,
    };
    data.toSend.push({
      invitationId: invitation.id,
      name,
      channel: destination.channel,
      accountId: account.id,
      to: destination.to,
      body: renderRfqMessage(messageInput),
      templateKey,
      templateVariables: templateKey ? rfqTemplateVariables(messageInput) : null,
    });
  }
  if (rfq.status === 'draft' && (data.toSend.length > 0 || data.failed.length > 0)) {
    await tx.rfq.update({ where: { id: rfq.id }, data: { status: 'sent' } });
  }
  publishBoard(ctx, { rfqId: rfq.id });
  return data;
}

/**
 * Tags the conversation `rfq:{id}` inside the command (a system write: the
 * sender may lack inbox permissions), so replies are always routed to the
 * interpretation of the invitation.
 */
async function tagRfqConversation(tx: Db, conversationId: string, rfqId: string): Promise<void> {
  const conversation = await tx.commConversation.findUnique({ where: { id: conversationId }, select: { tags: true } });
  if (!conversation) return;
  const tag = `${RFQ_CONVERSATION_TAG_PREFIX}${rfqId}`;
  if (conversation.tags.includes(tag)) return;
  await tx.commConversation.update({ where: { id: conversationId }, data: { tags: [...conversation.tags, tag].slice(-30) } });
}

/** Invitations claimed for sending (`sentAt`) that never got their result recorded after this long are reconciled. */
export const STALE_INVITATION_MS = 10 * 60_000;

export const reconcileSendsSchema = z.object({ rfqId: idText, staleBefore: isoDateText });

/**
 * System sweep of invitations left `pending` with `sentAt` (the message may
 * have gone out but the process died before recording it): the outbound
 * message of the conversation on the account, if any, records it as sent (so
 * replies are interpreted); otherwise it is marked failed so it can be
 * invited again.
 */
export async function reconcileStaleInvitationsInTx(
  tx: Db,
  input: z.output<typeof reconcileSendsSchema>,
  ctx: CommandContext
): Promise<{ sent: number; failed: number }> {
  const staleBefore = toDate(input.staleBefore) ?? ctx.now;
  const stale = await tx.rfqInvitation.findMany({
    where: { rfqId: input.rfqId, status: 'pending', sentAt: { not: null, lt: staleBefore } },
    take: 30,
  });
  if (stale.length === 0) return { sent: 0, failed: 0 };
  const results: z.output<typeof recordSendsSchema>['results'] = [];
  for (const invitation of stale) {
    let to: string | null = null;
    if (invitation.supplierId) {
      const supplier = await tx.supplier.findUnique({ where: { id: invitation.supplierId } });
      if (supplier) to = destinationFor(parseChannels(supplier.channels), supplier.primaryPhone, invitation.channel as MessagingChannelType)?.to ?? null;
    } else if (invitation.candidateId) {
      const candidate = await tx.sourcingCandidate.findUnique({ where: { id: invitation.candidateId } });
      if (candidate) to = destinationFor([], candidate.phone, invitation.channel as MessagingChannelType)?.to ?? null;
    }
    const contact =
      to && invitation.accountId
        ? await (await import('./messaging-eligibility')).contactForAddress(tx, invitation.channel as MessagingChannelType, to)
        : null;
    const conversation =
      contact && invitation.accountId
        ? await tx.commConversation.findFirst({ where: { accountId: invitation.accountId, contactId: contact.id }, orderBy: { lastMessageAt: 'desc' } })
        : null;
    const message =
      conversation && invitation.sentAt
        ? await tx.commMessage.findFirst({
            where: { conversationId: conversation.id, direction: 'outbound', createdAt: { gte: new Date(invitation.sentAt.getTime() - 60_000) } },
            orderBy: { createdAt: 'asc' },
          })
        : null;
    if (conversation && message && message.status !== 'failed' && message.status !== 'undelivered') {
      results.push({ invitationId: invitation.id, status: 'sent', conversationId: conversation.id, messageId: message.id, error: null });
    } else {
      results.push({
        invitationId: invitation.id,
        status: 'failed',
        conversationId: conversation?.id ?? null,
        messageId: message?.id ?? null,
        error: message?.error ?? 'No se confirmó el envío de la invitación: vuelve a invitar al proveedor',
      });
    }
  }
  return recordSendsInTx(tx, { rfqId: input.rfqId, results }, ctx);
}

export async function recordSendsInTx(
  tx: Db,
  input: z.output<typeof recordSendsSchema>,
  ctx: CommandContext
): Promise<{ sent: number; failed: number }> {
  const rfq = assertFoundRow(await tx.rfq.findUnique({ where: { id: input.rfqId } }), 'No se encontró la cotización');
  let sent = 0;
  let failed = 0;
  for (const result of input.results) {
    const invitation = await tx.rfqInvitation.findUnique({ where: { id: result.invitationId } });
    if (!invitation || invitation.rfqId !== rfq.id || invitation.status !== 'pending') continue;
    await tx.rfqInvitation.update({
      where: { id: invitation.id },
      data: {
        status: result.status,
        conversationId: result.conversationId ?? null,
        messageId: result.messageId ?? null,
        error: result.error ?? null,
        sentAt: invitation.sentAt ?? ctx.now,
      },
    });
    if (result.status === 'sent') {
      sent += 1;
      if (invitation.candidateId) {
        await tx.sourcingCandidate.updateMany({
          where: { id: invitation.candidateId, status: { in: ['new', 'contacted'] } },
          data: { status: 'rfq_sent', version: { increment: 1 } },
        });
      }
      if (result.conversationId) {
        await ctx.relate({ type: OBJ.rfq, id: rfq.id }, { type: 'comm_conversation', id: result.conversationId }, 'negotiated_in');
      }
    } else {
      failed += 1;
    }
    if (result.conversationId) await tagRfqConversation(tx, result.conversationId, rfq.id);
  }
  if (rfq.status === 'draft' && sent > 0) await tx.rfq.update({ where: { id: rfq.id }, data: { status: 'sent' } });
  emitPurchases(
    ctx,
    EV.sent,
    { rfqId: rfq.id, number: rfq.number, sent, failed, invitationIds: input.results.map((r) => r.invitationId) },
    { objectType: OBJ.rfq, objectId: rfq.id }
  );
  publishBoard(ctx, { rfqId: rfq.id });
  return { sent, failed };
}

/**
 * Sends the pending invitations through the inbox (outside any transaction)
 * and records the outcome. Each invitation is claimed first (`sentAt`), so a
 * retry never sends it twice.
 */
export async function sendRfqInvitations(
  actor: CurrentUser,
  rfqId: string,
  toSend: readonly InvitationToSend[],
  options: { actorType?: 'user' | 'ai'; commandId?: string; now?: Date } = {}
): Promise<{ sent: number; failed: number; results: Array<{ invitationId: string; status: 'sent' | 'failed'; error: string | null }> }> {
  const results: Array<z.input<typeof recordSendsSchema>['results'][number]> = [];
  for (const item of toSend) {
    const claim = await prisma.rfqInvitation.updateMany({
      where: { id: item.invitationId, status: 'pending', sentAt: null },
      data: { sentAt: options.now ?? new Date() },
    });
    if (claim.count !== 1) continue;
    try {
      const { conversation, message } = await startConversation(actor, {
        accountId: item.accountId,
        to: item.to,
        contactName: item.name.slice(0, 120),
        body: item.body,
        ...(item.templateKey ? { templateKey: item.templateKey, templateVariables: item.templateVariables ?? undefined } : {}),
      });
      // The `rfq:{id}` tag is written by the record_sends command (system write inside the transaction).
      const ok = Boolean(message) && message!.status !== 'failed';
      results.push({
        invitationId: item.invitationId,
        status: ok ? 'sent' : 'failed',
        conversationId: conversation.id,
        messageId: message?.id ?? null,
        error: ok ? null : (message?.error ?? 'El canal rechazó el mensaje'),
      });
    } catch (err) {
      results.push({
        invitationId: item.invitationId,
        status: 'failed',
        error: truncate(err instanceof Error ? err.message : 'No se pudo enviar', 500),
      });
    }
  }
  if (results.length === 0) return { sent: 0, failed: 0, results: [] };
  await import('./purchases-commands');
  const recorded = await executeCommand<{ sent: number; failed: number }>(
    {
      commandId: options.commandId ?? `purchases:rfq_sends:${rfqId}:${results.map((r) => r.invitationId).join(',')}`.slice(0, 160),
      type: PURCHASES_COMMANDS.rfqRecordSends,
      actor: { type: options.actorType ?? 'user', id: actor.id },
      aggregate: { type: OBJ.rfq, id: rfqId },
      payload: { rfqId, results },
    },
    actor,
    { now: options.now }
  );
  if (recorded.status === 'rejected') log('record_sends_rejected', { rfqId, errorCode: recorded.errorCode, message: recorded.message });
  return {
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results: results.map((r) => ({ invitationId: r.invitationId, status: r.status, error: r.error ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Supplier replies
// ---------------------------------------------------------------------------

/**
 * Contract with the messaging fan-out (`comms.message_fanout`): when an inbound
 * message belongs to a conversation tagged `rfq:{id}`, queue its
 * interpretation (debounced per invitation so a burst of messages is read once).
 */
export async function interpretRfqReplyIfTagged(messageId: string): Promise<{ enqueued: number }> {
  const message = await prisma.commMessage.findUnique({
    where: { id: messageId },
    select: { id: true, direction: true, conversationId: true },
  });
  if (!message || message.direction !== 'inbound') return { enqueued: 0 };
  const conversation = await prisma.commConversation.findUnique({ where: { id: message.conversationId }, select: { tags: true } });
  const rfqIds = (conversation?.tags ?? [])
    .filter((tag) => tag.startsWith(RFQ_CONVERSATION_TAG_PREFIX))
    .map((tag) => tag.slice(RFQ_CONVERSATION_TAG_PREFIX.length))
    .filter(Boolean);
  if (rfqIds.length === 0) return { enqueued: 0 };
  const invitations = await prisma.rfqInvitation.findMany({
    where: { conversationId: message.conversationId, rfqId: { in: rfqIds }, status: { in: ['sent', 'replied'] } },
    select: { id: true, rfqId: true },
  });
  const openRfqs = await prisma.rfq.findMany({
    where: { id: { in: [...new Set(invitations.map((i) => i.rfqId))] }, status: { in: ['sent', 'collecting', 'compared'] } },
    select: { id: true },
  });
  const open = new Set(openRfqs.map((r) => r.id));
  let enqueued = 0;
  for (const invitation of invitations) {
    if (!open.has(invitation.rfqId)) continue;
    // One job per inbound message: a message that arrives while an earlier job is running is never
    // swallowed by the dedupe; an older job whose message is no longer the latest skips itself.
    await enqueueJob({
      type: PURCHASES_JOB_TYPES.rfqInterpret,
      payload: { invitationId: invitation.id, messageId: message.id },
      dedupeKey: `${PURCHASES_JOB_TYPES.rfqInterpret}:${invitation.id}:${message.id}`,
      groupKey: `rfq:${invitation.rfqId}`,
      runAt: new Date(Date.now() + INTERPRET_DELAY_MS),
      priority: JOB_PRIORITY.normal,
      maxAttempts: 3,
      createdBy: 'purchases',
    });
    enqueued += 1;
  }
  return { enqueued };
}

/** Reads the conversation of an invitation with the utility model and records the response (job `purchases.rfq_interpret`). */
export async function runRfqInterpretation(
  invitationId: string,
  options: { now?: Date; messageId?: string | null } = {}
): Promise<{ status: 'skipped'; reason: string } | CommandResult<RecordInterpretationData>> {
  const invitation = await prisma.rfqInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation?.conversationId) return { status: 'skipped', reason: 'no_conversation' };
  const rfq = await prisma.rfq.findUnique({ where: { id: invitation.rfqId } });
  if (!rfq || !['sent', 'collecting', 'compared'].includes(rfq.status)) return { status: 'skipped', reason: 'rfq_closed' };
  const since = new Date((invitation.sentAt ?? rfq.createdAt).getTime() - 60_000);
  const messages = await prisma.commMessage.findMany({
    where: { conversationId: invitation.conversationId, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    take: 60,
    select: { id: true, direction: true, body: true, mediaObjectIds: true, createdAt: true },
  });
  const inbound = messages.filter((m) => m.direction === 'inbound');
  if (inbound.length === 0) return { status: 'skipped', reason: 'no_reply' };
  if (options.messageId) {
    const index = inbound.findIndex((m) => m.id === options.messageId);
    // A newer reply has its own job, which reads the whole conversation again.
    if (index >= 0 && index < inbound.length - 1) return { status: 'skipped', reason: 'superseded' };
  }
  const lines = await prisma.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { sortOrder: 'asc' } });
  const supplier = invitation.supplierId ? await prisma.supplier.findUnique({ where: { id: invitation.supplierId }, select: { name: true } }) : null;
  const candidate = invitation.candidateId ? await prisma.sourcingCandidate.findUnique({ where: { id: invitation.candidateId }, select: { name: true } }) : null;
  const name = supplier?.name ?? candidate?.name ?? 'Proveedor';
  const transcriptText = messages
    .map((m) => {
      const when = m.createdAt.toISOString().slice(0, 16).replace('T', ' ');
      const who = m.direction === 'inbound' ? name : 'UNIK';
      const body = m.body?.trim() || (m.mediaObjectIds.length > 0 ? '[adjunto]' : '[sin texto]');
      return `[${when}] ${who}: ${body}`;
    })
    .join('\n');
  const transcript = wrapUntrusted(transcriptText.slice(-TRANSCRIPT_MAX_CHARS), 'respuesta_proveedor');
  const prompt = buildRfqInterpretationPrompt({
    rfqNumber: rfq.number,
    supplierName: name,
    lines: lines.map((line, index) => ({
      ref: rfqLineRef(index),
      description: line.description,
      qty: num(line.qty),
      unit: line.unit,
      specs: line.specs && typeof line.specs === 'object' && !Array.isArray(line.specs) ? (line.specs as Record<string, unknown>) : null,
    })),
    transcript,
  });
  let interpretation: RfqInterpretation | null = null;
  let error: string | null = null;
  let model: string | null = null;
  try {
    model = modelForTask(await getAiSettings(), 'utility');
    const completion = await chatCompletion({
      model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: 0,
      maxTokens: 1200,
    });
    const parsed = rfqInterpretationSchema.safeParse(extractJsonObject(completion.content));
    if (parsed.success) interpretation = parsed.data;
    else error = 'La IA devolvió una interpretación inválida';
  } catch (err) {
    error = truncate(`No se pudo interpretar con IA: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  await import('./purchases-commands');
  const lastInbound = inbound[inbound.length - 1];
  return executeCommand<RecordInterpretationData>(
    {
      commandId: `purchases:rfq_interpret:${invitation.id}:${lastInbound.id}`.slice(0, 160),
      type: PURCHASES_COMMANDS.rfqRecordInterpretation,
      actor: { type: 'system', id: 'purchases.rfq_interpret' },
      aggregate: { type: OBJ.rfqInvitation, id: invitation.id },
      payload: {
        invitationId: invitation.id,
        messageIds: inbound.map((m) => m.id),
        interpretation: interpretation as unknown as Record<string, unknown> | null,
        error,
        model,
      },
    },
    null,
    { now: options.now }
  );
}

export interface RecordInterpretationData {
  responseId: string | null;
  status: string;
  reasons: string[];
  unchanged: boolean;
}

async function closeReviewItems(tx: Db, responseId: string, result: Record<string, unknown>): Promise<void> {
  const items = await tx.workItem.findMany({
    where: { objectType: RFQ_REVIEW_OBJECT, objectId: responseId, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
  });
  for (const item of items) await completeWorkItemInTx(tx, item, { result, skipEvidenceCheck: true });
}

async function writeResponseLines(tx: Db, responseId: string, lines: readonly PreparedResponseLine[], landed: Map<string, number | null>): Promise<void> {
  await tx.rfqResponseLine.deleteMany({ where: { responseId } });
  for (const line of lines) {
    const cost = landed.get(line.rfqLineId);
    await tx.rfqResponseLine.create({
      data: {
        responseId,
        rfqLineId: line.rfqLineId,
        unitPrice: D(line.unitPrice),
        qty: D(line.qty),
        unit: line.unit,
        unitFactorToBase: D(round4(line.unitFactorToBase * 100) / 100),
        landedUnitCost: cost === null || cost === undefined ? null : D(cost),
      },
    });
  }
}

function landedFor(rfqLines: readonly RfqLine[], terms: Omit<ScoringResponse, 'id' | 'lines' | 'supplierRating' | 'evaluationsCount' | 'isCandidate' | 'confidence' | 'validUntil'> & { validUntil: Date | null }, lines: readonly PreparedResponseLine[]) {
  return computeLandedCosts(
    rfqLines.map((l) => ({ id: l.id, qty: num(l.qty), unit: l.unit })),
    {
      id: 'draft',
      ...terms,
      confidence: null,
      supplierRating: null,
      evaluationsCount: 0,
      isCandidate: false,
      lines: lines.map((l) => ({ rfqLineId: l.rfqLineId, unitPrice: l.unitPrice, qty: l.qty, unit: l.unit, unitsPerRfqUnit: l.unitsPerRfqUnit })),
    }
  );
}

export async function recordInterpretationInTx(
  tx: Db,
  input: z.output<typeof recordInterpretationSchema>,
  ctx: CommandContext
): Promise<RecordInterpretationData> {
  const invitation = assertFoundRow(await tx.rfqInvitation.findUnique({ where: { id: input.invitationId } }), 'No se encontró la invitación');
  const rfq = assertFoundRow(await tx.rfq.findUnique({ where: { id: invitation.rfqId } }), 'No se encontró la cotización');
  if (!['sent', 'collecting', 'compared'].includes(rfq.status)) {
    return { responseId: null, status: 'skipped', reasons: ['La cotización ya está cerrada'], unchanged: true };
  }
  const existing = await tx.rfqResponse.findFirst({ where: { invitationId: invitation.id }, orderBy: { createdAt: 'desc' } });
  if (existing && ['confirmed', 'selected', 'rejected'].includes(existing.status)) {
    const merged = [...new Set([...existing.sourceMessageIds, ...input.messageIds])];
    if (merged.length !== existing.sourceMessageIds.length) {
      await tx.rfqResponse.update({ where: { id: existing.id }, data: { sourceMessageIds: merged } });
    }
    return { responseId: existing.id, status: existing.status, reasons: [], unchanged: true };
  }
  const rfqLines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { sortOrder: 'asc' } });
  const refs = rfqLines.map((line, index) => ({ id: line.id, ref: rfqLineRef(index), unit: line.unit, qty: num(line.qty) }));
  const parsed = input.interpretation ? rfqInterpretationSchema.safeParse(input.interpretation) : null;

  let status: 'parsed' | 'needs_review' = 'needs_review';
  let reasons: string[];
  let data: Prisma.RfqResponseUncheckedCreateInput;
  let prepared: PreparedResponseLine[] = [];
  let landedCosts = new Map<string, number | null>();
  const base = {
    rfqId: rfq.id,
    invitationId: invitation.id,
    supplierId: invitation.supplierId,
    candidateId: invitation.candidateId,
    receivedVia: 'conversation',
    sourceMessageIds: [...new Set([...(existing?.sourceMessageIds ?? []), ...input.messageIds])],
  };
  if (!parsed?.success) {
    reasons = [input.error ?? 'La respuesta no se pudo interpretar; léela en la conversación'];
    data = {
      ...base,
      currency: 'MXN',
      taxIncluded: false,
      confidence: D(0),
      interpretation: { error: input.error ?? 'invalid_interpretation', reviewReasons: reasons, model: input.model ?? null },
      status,
    };
  } else {
    const interpretation = parsed.data;
    const mapped = mapInterpretationLines(interpretation, refs);
    const profiles = await profilesFor(tx, rfqLines.map((l) => l.zohoItemId));
    const unitsPerRfqUnit = new Map<string, number | null>();
    for (const line of mapped.lines) {
      const rfqLine = rfqLines.find((l) => l.id === line.rfqLineId)!;
      const profile = rfqLine.zohoItemId ? (profiles.get(rfqLine.zohoItemId) ?? null) : null;
      unitsPerRfqUnit.set(line.rfqLineId, resolveQuotedUnits(rfqLine, line.unit, profile));
    }
    const decision = decideResponseStatus({ interpretation, rfqLines: refs, mapped: mapped.lines, unknownRefs: mapped.unknownRefs, unitsPerRfqUnit });
    status = decision.status;
    reasons = decision.reasons;
    prepared = mapped.lines.flatMap((line) => {
      const rfqLine = rfqLines.find((l) => l.id === line.rfqLineId)!;
      const units = unitsPerRfqUnit.get(line.rfqLineId) ?? null;
      const profile = rfqLine.zohoItemId ? (profiles.get(rfqLine.zohoItemId) ?? null) : null;
      const baseInfo = rfqLineBase(rfqLine, profile);
      return [
        {
          rfqLineId: line.rfqLineId,
          unitPrice: line.unitPrice,
          qty: line.qty ?? (units ? round4(num(rfqLine.qty) * units) : num(rfqLine.qty)),
          unit: line.unit ?? rfqLine.unit,
          unitFactorToBase: units ? baseInfo.perRfqUnit / units : 1,
          unitsPerRfqUnit: units ?? 0,
        },
      ];
    });
    const terms = {
      currency: interpretation.currency,
      exchangeRate: null,
      taxIncluded: interpretation.taxIncluded ?? false,
      taxRate: interpretation.taxRate,
      freight: interpretation.freight ?? 0,
      otherCosts: interpretation.otherCosts ?? 0,
      leadTimeDays: interpretation.leadTimeDays,
      validUntil: toDate(interpretation.validUntil),
    };
    const landed = landedFor(
      rfqLines,
      terms,
      prepared.map((p) => ({ ...p, unitsPerRfqUnit: p.unitsPerRfqUnit > 0 ? p.unitsPerRfqUnit : (null as unknown as number) }))
    );
    landedCosts = new Map(landed.lines.map((l) => [l.rfqLineId, l.landedUnitCost]));
    data = {
      ...base,
      currency: terms.currency,
      exchangeRate: null,
      taxIncluded: terms.taxIncluded,
      taxRate: terms.taxRate === null ? null : D(terms.taxRate),
      freight: D(terms.freight),
      otherCosts: D(terms.otherCosts),
      leadTimeDays: terms.leadTimeDays,
      validUntil: terms.validUntil,
      paymentTerms: interpretation.paymentTerms,
      landedTotal: landed.landedTotal === null ? null : D(landed.landedTotal),
      confidence: D(interpretation.confidence),
      interpretation: { ...interpretation, reviewReasons: reasons, model: input.model ?? null } as unknown as Prisma.InputJsonValue,
      status,
    };
    await tx.rfqInvitation.update({
      where: { id: invitation.id },
      data: { status: interpretation.declined ? 'declined' : 'replied', repliedAt: ctx.now },
    });
  }
  if (!parsed?.success && invitation.status === 'sent') {
    await tx.rfqInvitation.update({ where: { id: invitation.id }, data: { status: 'replied', repliedAt: ctx.now } });
  }
  const { rfqId: _rfqId, invitationId: _invitationId, ...updatable } = data;
  void _rfqId;
  void _invitationId;
  const response = existing
    ? await tx.rfqResponse.update({ where: { id: existing.id }, data: { ...updatable, version: { increment: 1 } } })
    : await tx.rfqResponse.create({ data });
  await writeResponseLines(tx, response.id, prepared, landedCosts);
  if (rfq.status === 'sent') await tx.rfq.update({ where: { id: rfq.id }, data: { status: 'collecting', version: { increment: 1 } } });
  if (invitation.candidateId) {
    await tx.sourcingCandidate.updateMany({
      where: { id: invitation.candidateId, status: { in: ['new', 'contacted', 'rfq_sent'] } },
      data: { status: 'quoted', version: { increment: 1 } },
    });
  }
  const creator = rfq.createdByUserId.includes(':') ? null : rfq.createdByUserId;
  if (status === 'needs_review') {
    const open = await tx.workItem.findFirst({
      where: { objectType: RFQ_REVIEW_OBJECT, objectId: response.id, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
      select: { id: true },
    });
    if (!open) {
      await ctx.createWorkItem({
        areaKey: 'compras',
        kind: 'verification',
        title: truncate(`Revisar la respuesta de ${invitation.supplierId || invitation.candidateId ? 'proveedor' : 'la cotización'} a ${rfq.number}`, 200),
        description: truncate(reasons.join(' · '), 1000),
        objectType: RFQ_REVIEW_OBJECT,
        objectId: response.id,
        ownerUserId: creator ?? undefined,
        notify: false,
      });
    }
  } else {
    await closeReviewItems(tx, response.id, { status });
  }
  emitPurchases(
    ctx,
    EV.responseParsed,
    { rfqId: rfq.id, number: rfq.number, responseId: response.id, invitationId: invitation.id, status, reasons, confidence: response.confidence?.toString() ?? null },
    { objectType: OBJ.rfqResponse, objectId: response.id }
  );
  if (creator) {
    ctx.notify({
      userId: creator,
      category: purchaseNotificationCategory(),
      type: 'purchase_rfq_response',
      title: `Respuesta a ${rfq.number}: ${RFQ_RESPONSE_STATUS_LABELS[status]}`,
      body: truncate(reasons.join(' · ') || 'Lista para comparar', 300),
      url: `/app/purchases/rfqs/${rfq.id}`,
      entityType: OBJ.rfqResponse,
      entityId: response.id,
    });
  }
  publishBoard(ctx, { rfqId: rfq.id, responseId: response.id });
  return { responseId: response.id, status, reasons, unchanged: false };
}

export async function recordManualResponseInTx(tx: Db, input: ManualResponseInput, ctx: CommandContext): Promise<RfqResponse> {
  const rfq = assertFoundRow(await tx.rfq.findUnique({ where: { id: input.rfqId } }), 'No se encontró la cotización');
  if (rfq.status === 'closed' || rfq.status === 'cancelled') throw new OperationsError('invalid_state', 'La cotización ya está cerrada');
  if (input.supplierId) assertFoundRow(await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true } }), 'No se encontró el proveedor');
  if (input.candidateId) assertFoundRow(await tx.sourcingCandidate.findUnique({ where: { id: input.candidateId }, select: { id: true } }), 'No se encontró el candidato');
  if (input.currency !== 'MXN' && !input.exchangeRate) {
    throw new OperationsError('invalid_payload', `Indica el tipo de cambio de ${input.currency} a MXN`);
  }
  const rfqLines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { sortOrder: 'asc' } });
  const profiles = await profilesFor(tx, rfqLines.map((l) => l.zohoItemId));
  const prepared = prepareResponseLines(rfqLines, input.lines, profiles);
  const terms = {
    currency: input.currency,
    exchangeRate: input.exchangeRate ?? null,
    taxIncluded: input.taxIncluded,
    taxRate: input.taxRate ?? null,
    freight: input.freight,
    otherCosts: input.otherCosts,
    leadTimeDays: input.leadTimeDays ?? null,
    validUntil: toDate(input.validUntil ?? null),
  };
  const landed = landedFor(rfqLines, terms, prepared);
  const invitation = await tx.rfqInvitation.findFirst({
    where: { rfqId: rfq.id, ...(input.supplierId ? { supplierId: input.supplierId } : { candidateId: input.candidateId }) },
    orderBy: { createdAt: 'desc' },
  });
  const response = await tx.rfqResponse.create({
    data: {
      rfqId: rfq.id,
      invitationId: invitation?.id ?? null,
      supplierId: input.supplierId ?? null,
      candidateId: input.candidateId ?? null,
      receivedVia: 'manual',
      currency: terms.currency,
      exchangeRate: terms.exchangeRate === null ? null : D(terms.exchangeRate),
      taxIncluded: terms.taxIncluded,
      taxRate: terms.taxRate === null ? null : D(terms.taxRate),
      freight: D(terms.freight),
      otherCosts: D(terms.otherCosts),
      leadTimeDays: terms.leadTimeDays,
      validUntil: terms.validUntil,
      paymentTerms: input.paymentTerms ?? null,
      landedTotal: landed.landedTotal === null ? null : D(landed.landedTotal),
      status: 'confirmed',
      reviewedByUserId: recordActorId(ctx),
    },
  });
  await writeResponseLines(tx, response.id, prepared, new Map(landed.lines.map((l) => [l.rfqLineId, l.landedUnitCost])));
  if (invitation && ['pending', 'sent'].includes(invitation.status)) {
    await tx.rfqInvitation.update({ where: { id: invitation.id }, data: { status: 'replied', repliedAt: ctx.now } });
  }
  if (['draft', 'sent'].includes(rfq.status)) await tx.rfq.update({ where: { id: rfq.id }, data: { status: 'collecting', version: { increment: 1 } } });
  if (input.candidateId) {
    await tx.sourcingCandidate.updateMany({
      where: { id: input.candidateId, status: { in: ['new', 'contacted', 'rfq_sent'] } },
      data: { status: 'quoted', version: { increment: 1 } },
    });
  }
  emitPurchases(
    ctx,
    EV.responseConfirmed,
    { rfqId: rfq.id, number: rfq.number, responseId: response.id, manual: true, landedTotal: response.landedTotal?.toString() ?? null },
    { objectType: OBJ.rfqResponse, objectId: response.id }
  );
  publishBoard(ctx, { rfqId: rfq.id, responseId: response.id });
  return response;
}

export async function confirmResponseInTx(tx: Db, input: ConfirmResponseInput, ctx: CommandContext): Promise<RfqResponse> {
  const response = assertFoundRow(await tx.rfqResponse.findUnique({ where: { id: input.responseId } }), 'No se encontró la respuesta');
  if (!['parsed', 'needs_review', 'confirmed'].includes(response.status)) {
    throw new OperationsError('invalid_state', `La respuesta ya está ${RFQ_RESPONSE_STATUS_LABELS[response.status as keyof typeof RFQ_RESPONSE_STATUS_LABELS]?.toLowerCase() ?? response.status}`);
  }
  const rfq = assertFoundRow(await tx.rfq.findUnique({ where: { id: response.rfqId } }), 'No se encontró la cotización');
  if (rfq.status === 'closed' || rfq.status === 'cancelled') throw new OperationsError('invalid_state', 'La cotización ya está cerrada');
  const rfqLines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { sortOrder: 'asc' } });
  const profiles = await profilesFor(tx, rfqLines.map((l) => l.zohoItemId));
  const currentLines = await tx.rfqResponseLine.findMany({ where: { responseId: response.id } });
  const lineInputs: ResponseLineInput[] =
    input.lines ??
    currentLines.map((line) => {
      const rfqLine = rfqLines.find((l) => l.id === line.rfqLineId);
      const profile = rfqLine?.zohoItemId ? (profiles.get(rfqLine.zohoItemId) ?? null) : null;
      return {
        rfqLineId: line.rfqLineId,
        unitPrice: num(line.unitPrice),
        qty: num(line.qty),
        unit: line.unit,
        unitsPerRfqUnit: rfqLine ? unitsPerRfqUnitOf(rfqLine, line, profile) : null,
      };
    });
  if (lineInputs.length === 0) throw new OperationsError('invalid_payload', 'La respuesta no tiene precios: captúralos para confirmarla');
  const prepared = prepareResponseLines(rfqLines, lineInputs, profiles);
  const terms = {
    currency: input.currency ?? response.currency,
    exchangeRate: input.exchangeRate === undefined ? numOrNull(response.exchangeRate) : input.exchangeRate,
    taxIncluded: input.taxIncluded ?? response.taxIncluded,
    taxRate: input.taxRate === undefined ? numOrNull(response.taxRate) : input.taxRate,
    freight: input.freight ?? num(response.freight),
    otherCosts: input.otherCosts ?? num(response.otherCosts),
    leadTimeDays: input.leadTimeDays === undefined ? response.leadTimeDays : input.leadTimeDays,
    validUntil: input.validUntil === undefined ? response.validUntil : toDate(input.validUntil),
  };
  if (terms.currency !== 'MXN' && !terms.exchangeRate) {
    throw new OperationsError('invalid_payload', `Indica el tipo de cambio de ${terms.currency} a MXN`);
  }
  const landed = landedFor(rfqLines, terms, prepared);
  const interpretation = response.interpretation && typeof response.interpretation === 'object' && !Array.isArray(response.interpretation)
    ? { ...(response.interpretation as Record<string, unknown>), reviewReasons: [] }
    : undefined;
  const updated = await tx.rfqResponse.update({
    where: { id: response.id },
    data: {
      currency: terms.currency,
      exchangeRate: terms.exchangeRate === null || terms.exchangeRate === undefined ? null : D(terms.exchangeRate),
      taxIncluded: terms.taxIncluded,
      taxRate: terms.taxRate === null || terms.taxRate === undefined ? null : D(terms.taxRate),
      freight: D(terms.freight),
      otherCosts: D(terms.otherCosts),
      leadTimeDays: terms.leadTimeDays ?? null,
      validUntil: terms.validUntil ?? null,
      paymentTerms: input.paymentTerms === undefined ? response.paymentTerms : input.paymentTerms,
      landedTotal: landed.landedTotal === null ? null : D(landed.landedTotal),
      status: 'confirmed',
      reviewedByUserId: recordActorId(ctx),
      ...(interpretation ? { interpretation: interpretation as Prisma.InputJsonValue } : {}),
    },
  });
  await writeResponseLines(tx, response.id, prepared, new Map(landed.lines.map((l) => [l.rfqLineId, l.landedUnitCost])));
  await closeReviewItems(tx, response.id, { status: 'confirmed' });
  emitPurchases(
    ctx,
    EV.responseConfirmed,
    { rfqId: rfq.id, number: rfq.number, responseId: response.id, previousStatus: response.status, landedTotal: updated.landedTotal?.toString() ?? null },
    { objectType: OBJ.rfqResponse, objectId: response.id }
  );
  publishBoard(ctx, { rfqId: rfq.id, responseId: response.id });
  return updated;
}

export async function rejectResponseInTx(tx: Db, input: z.output<typeof rejectResponseSchema>, ctx: CommandContext): Promise<RfqResponse> {
  const response = assertFoundRow(await tx.rfqResponse.findUnique({ where: { id: input.responseId } }), 'No se encontró la respuesta');
  if (response.status === 'selected') throw new OperationsError('invalid_state', 'La respuesta ya se seleccionó para una orden');
  if (response.status === 'rejected') return response;
  const updated = await tx.rfqResponse.update({
    where: { id: response.id },
    data: { status: 'rejected', reviewedByUserId: recordActorId(ctx) },
  });
  await closeReviewItems(tx, response.id, { status: 'rejected', reason: input.reason });
  emitPurchases(
    ctx,
    EV.responseRejected,
    { rfqId: response.rfqId, responseId: response.id, reason: input.reason, previousStatus: response.status },
    { objectType: OBJ.rfqResponse, objectId: response.id }
  );
  publishBoard(ctx, { rfqId: response.rfqId, responseId: response.id });
  return updated;
}

// ---------------------------------------------------------------------------
// Compare / select / cancel / expire
// ---------------------------------------------------------------------------

export interface RfqRankingEntry extends Omit<ResponseScore, 'landed'> {
  name: string | null;
  status: string;
  lines: Array<{ rfqLineId: string; landedUnitCost: number | null; pricePerRfqUnit: number | null; issues: string[] }>;
}

export function rankingFromInputs(inputs: RfqScoringInputs, now: Date): RfqRankingEntry[] {
  const scores = scoreRfqResponses(inputs.scoringLines, inputs.responses.map((r) => r.scoring), { now });
  return scores.map((score) => {
    const entry = inputs.responses.find((r) => r.row.id === score.responseId)!;
    const { landed, ...rest } = score;
    return {
      ...rest,
      name: entry.name,
      status: entry.row.status,
      lines: landed.lines.map((l) => ({ rfqLineId: l.rfqLineId, landedUnitCost: l.landedUnitCost, pricePerRfqUnit: l.pricePerRfqUnit, issues: l.issues })),
    };
  });
}

export async function compareRfqInTx(tx: Db, input: z.output<typeof rfqIdSchema>, ctx: CommandContext): Promise<{ rfqId: string; ranking: RfqRankingEntry[] }> {
  const inputs = await loadRfqScoringInputs(tx, input.rfqId);
  if (['closed', 'cancelled'].includes(inputs.rfq.status)) throw new OperationsError('invalid_state', 'La cotización ya está cerrada');
  if (inputs.responses.length === 0) throw new OperationsError('invalid_state', 'Aún no hay respuestas que comparar');
  const ranking = rankingFromInputs(inputs, ctx.now);
  for (const entry of ranking) {
    await tx.rfqResponse.update({
      where: { id: entry.responseId },
      data: {
        score: D(entry.score),
        specMatch: D(entry.specMatch),
        riskScore: D(entry.risk),
        landedTotal: entry.landedTotal === null ? null : D(entry.landedTotal),
      },
    });
    const responseLines = inputs.responses.find((r) => r.row.id === entry.responseId)!.lines;
    for (const line of responseLines) {
      const cost = entry.lines.find((l) => l.rfqLineId === line.rfqLineId)?.landedUnitCost ?? null;
      await tx.rfqResponseLine.update({ where: { id: line.id }, data: { landedUnitCost: cost === null ? null : D(cost) } });
    }
  }
  if (['sent', 'collecting'].includes(inputs.rfq.status)) {
    await tx.rfq.update({ where: { id: inputs.rfq.id }, data: { status: 'compared' } });
  }
  emitPurchases(
    ctx,
    EV.compared,
    {
      rfqId: inputs.rfq.id,
      number: inputs.rfq.number,
      ranking: ranking.map((r) => ({ responseId: r.responseId, rank: r.rank, score: r.score, landedTotal: r.landedTotal, recommended: r.recommended })),
    },
    { objectType: OBJ.rfq, objectId: inputs.rfq.id }
  );
  publishBoard(ctx, { rfqId: inputs.rfq.id });
  return { rfqId: inputs.rfq.id, ranking };
}

export async function selectResponseInTx(
  tx: Db,
  input: z.output<typeof selectResponseSchema>,
  ctx: CommandContext
): Promise<{ responseId: string; rfqId: string; orderId: string; orderNumber: string; supplierId: string; quantityWarnings: string[] }> {
  const response = assertFoundRow(await tx.rfqResponse.findUnique({ where: { id: input.responseId } }), 'No se encontró la respuesta');
  if (response.status === 'rejected' || response.status === 'selected') {
    throw new OperationsError('invalid_state', `La respuesta ya está ${response.status === 'rejected' ? 'descartada' : 'seleccionada'}`);
  }
  // Prices, tax, freight and lead time read by the AI become an order only after a person confirms them.
  if (response.status !== 'confirmed') {
    throw new OperationsError('invalid_state', 'Revisa y confirma la respuesta antes de seleccionarla');
  }
  if (response.validUntil && response.validUntil.getTime() < ctx.now.getTime()) {
    throw new OperationsError(
      'invalid_state',
      `La cotización venció el ${isoDay(response.validUntil)}: reconfírmala con el proveedor y actualiza su vigencia`
    );
  }
  const rfq = assertFoundRow(await tx.rfq.findUnique({ where: { id: response.rfqId } }), 'No se encontró la cotización');
  if (rfq.status === 'closed' || rfq.status === 'cancelled') throw new OperationsError('invalid_state', 'La cotización ya está cerrada');
  const rfqLines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { sortOrder: 'asc' } });
  const lines = await tx.rfqResponseLine.findMany({ where: { responseId: response.id } });
  if (lines.length === 0) throw new OperationsError('invalid_state', 'La respuesta no tiene precios');
  let supplierId = response.supplierId;
  if (!supplierId) {
    if (!response.candidateId) throw new OperationsError('invalid_state', 'La respuesta no tiene proveedor');
    const promoted = await promoteCandidateToSupplierInTx(tx, { candidateId: response.candidateId }, ctx, { bumpCandidateVersion: true });
    supplierId = promoted.supplier.id;
  }
  const profiles = await profilesFor(tx, rfqLines.map((l) => l.zohoItemId));
  const taxRate = numOrNull(response.taxRate) ?? DEFAULT_TAX_RATE;
  const orderLines = lines.flatMap((line) => {
    const rfqLine = rfqLines.find((l) => l.id === line.rfqLineId);
    if (!rfqLine) return [];
    const profile = rfqLine.zohoItemId ? (profiles.get(rfqLine.zohoItemId) ?? null) : null;
    const units = unitsPerRfqUnitOf(rfqLine, line, profile) ?? 1;
    let price = num(line.unitPrice) * units;
    if (response.taxIncluded) price = price / (1 + taxRate);
    const specs = rfqLine.specs && typeof rfqLine.specs === 'object' && !Array.isArray(rfqLine.specs) ? (rfqLine.specs as Record<string, unknown>) : {};
    const sources = Array.isArray(specs.requestSources)
      ? specs.requestSources.flatMap((entry) => {
          const row = entry as { requestLineId?: unknown; qty?: unknown };
          return typeof row.requestLineId === 'string' && Number(row.qty) > 0 ? [{ requestLineId: row.requestLineId, qty: Number(row.qty) }] : [];
        })
      : [];
    return [
      {
        requestLineId: sources.length > 0 ? null : rfqLine.requestLineId,
        ...(sources.length > 0 ? { sources } : {}),
        zohoItemId: rfqLine.zohoItemId,
        supplierProductId: null,
        description: rfqLine.description,
        qty: num(rfqLine.qty),
        unit: rfqLine.unit,
        unitPrice: round4(price),
        taxRate,
      },
    ];
  });
  const quantityWarnings = lines.flatMap((line) => {
    const rfqLine = rfqLines.find((l) => l.id === line.rfqLineId);
    if (!rfqLine) return [];
    const profile = rfqLine.zohoItemId ? (profiles.get(rfqLine.zohoItemId) ?? null) : null;
    const units = unitsPerRfqUnitOf(rfqLine, line, profile) ?? 1;
    const quotedInRfqUnits = units > 0 ? num(line.qty) / units : num(line.qty);
    return Math.abs(quotedInRfqUnits - num(rfqLine.qty)) > 0.0001
      ? [`${rfqLine.description}: el proveedor cotizó ${round4(quotedInRfqUnits)} ${rfqLine.unit} y la orden pide ${num(rfqLine.qty)}`]
      : [];
  });
  const expectedAt =
    input.expectedAt ?? (response.leadTimeDays !== null ? isoDay(addDays(ctx.now, response.leadTimeDays)) : null);
  const { order } = await createOrderInTx(
    tx,
    {
      supplierId,
      currency: response.currency,
      deliveryMode: input.deliveryMode,
      warehouseId: input.warehouseId ?? null,
      directDeliveryCaseId: input.directDeliveryCaseId ?? null,
      expectedAt,
      freight: round4(num(response.freight) + num(response.otherCosts)),
      notes: input.notes ?? `Cotización ${rfq.number}`,
      rfqResponseId: response.id,
      lines: orderLines,
    },
    ctx
  );
  await tx.rfqResponse.update({ where: { id: response.id }, data: { status: 'selected', supplierId, reviewedByUserId: recordActorId(ctx) } });
  await tx.rfq.update({ where: { id: rfq.id }, data: { status: 'closed', version: { increment: 1 } } });
  for (const line of lines) {
    const rfqLine = rfqLines.find((l) => l.id === line.rfqLineId);
    if (!rfqLine) continue;
    await touchSupplierProductPrice(tx, {
      supplierId,
      zohoItemId: rfqLine.zohoItemId,
      description: rfqLine.description,
      unit: line.unit,
      price: line.unitPrice,
      currency: response.currency,
      leadTimeDays: response.leadTimeDays,
      source: 'rfq',
      at: ctx.now,
    });
  }
  await closeReviewItems(tx, response.id, { status: 'selected', orderId: order.id });
  emitPurchases(
    ctx,
    EV.responseSelected,
    { rfqId: rfq.id, number: rfq.number, responseId: response.id, supplierId, orderId: order.id, orderNumber: order.number, quantityWarnings },
    { objectType: OBJ.rfqResponse, objectId: response.id }
  );
  await ctx.relate({ type: OBJ.rfq, id: rfq.id }, { type: OBJ.order, id: order.id }, 'awarded_as');
  publishBoard(ctx, { rfqId: rfq.id, orderId: order.id });
  return { responseId: response.id, rfqId: rfq.id, orderId: order.id, orderNumber: order.number, supplierId, quantityWarnings };
}

async function reopenSourcingRequests(tx: Db, rfqId: string, ctx: CommandContext): Promise<void> {
  const lines = await tx.rfqLine.findMany({ where: { rfqId, requestLineId: { not: null } }, select: { requestLineId: true } });
  if (lines.length === 0) return;
  const requestLines = await tx.purchaseRequestLine.findMany({
    where: { id: { in: lines.map((l) => l.requestLineId!) } },
    select: { requestId: true },
  });
  const requestIds = [...new Set(requestLines.map((l) => l.requestId))];
  for (const requestId of requestIds) {
    await tx.purchaseRequest.updateMany({ where: { id: requestId, status: 'sourcing' }, data: { status: 'open', version: { increment: 1 } } });
  }
  await recomputeRequestStatuses(tx, requestIds, ctx);
}

export async function cancelRfqInTx(tx: Db, input: z.output<typeof cancelRfqSchema>, ctx: CommandContext): Promise<Rfq> {
  const rfq = assertFoundRow(await tx.rfq.findUnique({ where: { id: input.rfqId } }), 'No se encontró la cotización');
  if (rfq.status === 'closed' || rfq.status === 'cancelled') throw new OperationsError('invalid_state', 'La cotización ya está cerrada');
  await tx.rfqInvitation.updateMany({ where: { rfqId: rfq.id, status: { in: ['pending', 'sent'] } }, data: { status: 'expired' } });
  const updated = await tx.rfq.update({ where: { id: rfq.id }, data: { status: 'cancelled' } });
  await reopenSourcingRequests(tx, rfq.id, ctx);
  emitPurchases(ctx, EV.cancelled, { rfqId: rfq.id, number: rfq.number, reason: input.reason, previousStatus: rfq.status }, { objectType: OBJ.rfq, objectId: rfq.id });
  publishBoard(ctx, { rfqId: rfq.id });
  return updated;
}

/** System command of `purchases.rfq_expire`: the due date passed. */
export async function expireRfqInTx(tx: Db, input: z.output<typeof rfqIdSchema>, ctx: CommandContext): Promise<{ expired: boolean; invitations: number; responses: number; status: string }> {
  const rfq = assertFoundRow(await tx.rfq.findUnique({ where: { id: input.rfqId } }), 'No se encontró la cotización');
  if (!['sent', 'collecting'].includes(rfq.status) || !rfq.dueAt || rfq.dueAt.getTime() > ctx.now.getTime()) {
    return { expired: false, invitations: 0, responses: 0, status: rfq.status };
  }
  const { count } = await tx.rfqInvitation.updateMany({
    where: { rfqId: rfq.id, status: { in: ['pending', 'sent'] } },
    data: { status: 'expired' },
  });
  const responses = await tx.rfqResponse.count({ where: { rfqId: rfq.id, status: { not: 'rejected' } } });
  let status = rfq.status;
  if (responses === 0) {
    status = 'closed';
    await tx.rfq.update({ where: { id: rfq.id }, data: { status } });
    await reopenSourcingRequests(tx, rfq.id, ctx);
  }
  if (count === 0 && responses > 0) return { expired: false, invitations: 0, responses, status };
  emitPurchases(ctx, EV.expired, { rfqId: rfq.id, number: rfq.number, expiredInvitations: count, responses, status }, { objectType: OBJ.rfq, objectId: rfq.id });
  const creator = rfq.createdByUserId.includes(':') ? null : rfq.createdByUserId;
  if (creator) {
    ctx.notify({
      userId: creator,
      category: purchaseNotificationCategory(),
      type: 'purchase_rfq_expired',
      title: `Venció la cotización ${rfq.number}`,
      body: responses > 0 ? `${responses} respuesta(s): compáralas y elige` : 'Nadie respondió; la cotización se cerró',
      url: `/app/purchases/rfqs/${rfq.id}`,
      entityType: OBJ.rfq,
      entityId: rfq.id,
    });
  }
  publishBoard(ctx, { rfqId: rfq.id });
  return { expired: true, invitations: count, responses, status };
}

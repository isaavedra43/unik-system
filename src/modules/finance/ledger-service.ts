import { Prisma, type LedgerEntry, type LedgerLine } from '@prisma/client';
import { z } from 'zod';
import { lockAdvisoryKeys } from '@/modules/operations/advisory-locks';
import { resolveApprovalRequirement } from '@/modules/operations/approvals-service';
import { ConcurrencyConflict, type CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { nextNumber } from '@/modules/operations/sequence-service';
import { financeError } from './finance-errors';
import { dateKeyOf, dateKeySchema, isDateKey, toDbDate } from './finance-dates';
import {
  actorUserIdOf,
  financeEventOptions,
  newRowId,
  publishBoard,
  todayKeyOf,
} from './finance-helpers';
import {
  assertBalanced,
  assertDateOpen,
  assertReversible,
  cashDeltas,
  closedPeriodFor,
  isLedgerEntryKind,
  manualCashOutflow,
  mirrorForReversal,
  normalizeLedgerLines,
  periodKeyOf,
  postingLockKeys,
  reversalDateKey,
  type LedgerLineInput,
  type PeriodCloseState,
} from './ledger-rules';
import { currencySchema, formatMxn, nonNegativeMoneySchema, roundMoney } from './money';
import {
  FINANCE_EVENTS,
  FINANCE_OBJECT_TYPES,
  FINANCE_SEQUENCES,
  LEDGER_SOURCE_TYPES,
  MANUAL_ENTRY_KINDS,
  type LedgerEntryKind,
} from './types';

/**
 * The immutable, balanced ledger (plan 6.4).
 *
 * `postLedgerEntry(tx, input, ctx)` runs inside a finance command: validates
 * the lines (`ledger-rules.ts`), rejects dates of a closed day or month,
 * checks every referenced account (active cash account in the entry currency,
 * active category, obligation of the right kind and currency), takes the
 * `AS-` folio, writes the entry and its lines, and moves the balance of each
 * cash account with an optimistic version guard (a lost race rolls the
 * command back and the engine retries it).
 *
 * `reverseLedgerEntry(tx, input, ctx)` is the ONLY correction: a `reversal`
 * entry with mirrored lines, dated in an open period (never before the
 * original), claimed atomically on the original (`reversedByEntryId`) so an
 * entry is reversed at most once. Entries owned by a domain flow
 * (obligations, expenses, payroll) are reversed through that flow, which also
 * fixes the domain rows.
 */

type Db = Prisma.TransactionClient;

export type LedgerEntryWithLines = LedgerEntry & { lines: LedgerLine[] };

export interface PostLedgerEntryInput {
  kind: LedgerEntryKind;
  dateKey: string;
  description: string;
  currency?: string;
  sourceType?: string | null;
  sourceId?: string | null;
  lines: readonly LedgerLineInput[];
  evidenceObjectIds?: readonly string[];
  meta?: Record<string, unknown> | null;
  /** Internal: fixed id (reversals claim the original before inserting). */
  id?: string;
  /** Internal: only for `kind = 'reversal'`. */
  reversesEntryId?: string | null;
}

const CLEARING_ID_PATTERN = /^[a-z][a-z0-9_:.-]{1,119}$/;

export async function loadCloseStates(db: Pick<Db, 'periodClose'>, dateKey: string): Promise<PeriodCloseState[]> {
  return db.periodClose.findMany({
    where: {
      status: 'closed',
      OR: [
        { kind: 'monthly', periodKey: periodKeyOf(dateKey) },
        { kind: 'daily', periodKey: dateKey },
      ],
    },
    select: { periodKey: true, kind: true, status: true },
  });
}

/** Throws `period_closed` when `dateKey` falls in a closed day or month. */
export async function assertPeriodOpen(db: Pick<Db, 'periodClose'>, dateKey: string): Promise<void> {
  assertDateOpen(await loadCloseStates(db, dateKey), dateKey);
}

export async function closedPeriodOf(
  db: Pick<Db, 'periodClose'>,
  dateKey: string
): Promise<PeriodCloseState | null> {
  return closedPeriodFor(await loadCloseStates(db, dateKey), dateKey);
}

async function validateAccounts(
  tx: Db,
  lines: ReturnType<typeof normalizeLedgerLines>,
  currency: string,
  lenient: boolean
): Promise<void> {
  const ids = (type: string) => [...new Set(lines.filter((l) => l.accountType === type).map((l) => l.accountId))];

  const cashIds = ids('cash');
  if (cashIds.length > 0) {
    const accounts = await tx.cashAccount.findMany({ where: { id: { in: cashIds } } });
    for (const id of cashIds) {
      const account = accounts.find((a) => a.id === id);
      if (!account) throw financeError('invalid_line', 'Una cuenta de caja del asiento no existe');
      if (!lenient && account.status !== 'active') {
        throw financeError('account_inactive', `La cuenta ${account.name} está cerrada`);
      }
      if (account.currency !== currency) {
        throw financeError('currency_mismatch', `La cuenta ${account.name} es en ${account.currency} y el asiento en ${currency}`);
      }
    }
  }

  const categoryIds = ids('category');
  if (categoryIds.length > 0) {
    const categories = await tx.financeCategory.findMany({ where: { id: { in: categoryIds } } });
    for (const id of categoryIds) {
      const category = categories.find((c) => c.id === id);
      if (!category) throw financeError('invalid_line', 'Una categoría del asiento no existe');
      if (!lenient && category.status !== 'active') {
        throw financeError('account_inactive', `La categoría ${category.name} está archivada`);
      }
    }
  }

  for (const kind of ['receivable', 'payable'] as const) {
    const obligationIds = ids(kind);
    if (obligationIds.length === 0) continue;
    const obligations = await tx.obligation.findMany({
      where: { id: { in: obligationIds } },
      select: { id: true, kind: true, currency: true, number: true },
    });
    for (const id of obligationIds) {
      const obligation = obligations.find((o) => o.id === id);
      if (!obligation) throw financeError('invalid_line', 'Una obligación del asiento no existe');
      if (obligation.kind !== kind) {
        throw financeError('invalid_line', `La obligación ${obligation.number} no es una cuenta ${kind === 'payable' ? 'por pagar' : 'por cobrar'}`);
      }
      if (obligation.currency !== currency) {
        throw financeError('currency_mismatch', `La obligación ${obligation.number} está en ${obligation.currency}`);
      }
    }
  }

  for (const line of lines) {
    if ((line.accountType === 'clearing' || line.accountType === 'equity') && !CLEARING_ID_PATTERN.test(line.accountId)) {
      throw financeError('invalid_line', `Renglón ${line.seq}: clave de cuenta inválida`);
    }
  }

  const centerIds = [...new Set(lines.map((l) => l.costCenterId).filter((id): id is string => Boolean(id)))];
  if (centerIds.length > 0) {
    const centers = await tx.costCenter.findMany({ where: { id: { in: centerIds } }, select: { id: true } });
    if (centers.length !== centerIds.length) {
      throw financeError('invalid_line', 'Un centro de costo del asiento no existe');
    }
  }
}

/** Moves each cash account by its delta with the version guard. */
export async function applyCashDeltas(tx: Db, deltas: ReadonlyMap<string, Prisma.Decimal>): Promise<void> {
  for (const [cashAccountId, delta] of [...deltas.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const account = await tx.cashAccount.findUnique({
      where: { id: cashAccountId },
      select: { version: true },
    });
    if (!account) throw financeError('invalid_line', 'Una cuenta de caja del asiento no existe');
    const updated = await tx.cashAccount.updateMany({
      where: { id: cashAccountId, version: account.version },
      data: { currentBalance: { increment: delta }, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new ConcurrencyConflict();
  }
}

export async function postLedgerEntry(
  tx: Db,
  input: PostLedgerEntryInput,
  ctx: CommandContext
): Promise<LedgerEntryWithLines> {
  if (!isLedgerEntryKind(input.kind)) throw financeError('invalid_payload', 'Tipo de asiento inválido');
  if (input.kind === 'reversal' && !input.reversesEntryId) {
    throw financeError('invalid_payload', 'Un reverso debe indicar el asiento que revierte');
  }
  if (input.kind !== 'reversal' && input.reversesEntryId) {
    throw financeError('invalid_payload', 'Sólo un reverso puede revertir otro asiento');
  }
  if (!isDateKey(input.dateKey)) throw financeError('invalid_payload', 'Fecha del asiento inválida');
  const description = (input.description ?? '').trim().slice(0, 500);
  if (!description) throw financeError('invalid_payload', 'Falta la descripción del asiento');
  const currency = currencySchema.parse(input.currency ?? 'MXN');

  const lines = normalizeLedgerLines(input.lines);
  assertBalanced(lines);
  // Shared with every other posting, exclusive against the close of this day or month:
  // the period check below and the close never interleave (READ COMMITTED).
  await lockAdvisoryKeys(tx, postingLockKeys(input.dateKey), 'shared');
  await assertPeriodOpen(tx, input.dateKey);
  await validateAccounts(tx, lines, currency, input.kind === 'reversal');

  const number = await nextNumber(tx, FINANCE_SEQUENCES.ledgerEntry.key, FINANCE_SEQUENCES.ledgerEntry.prefix);
  const entry = await tx.ledgerEntry.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      number,
      kind: input.kind,
      date: toDbDate(input.dateKey),
      periodKey: periodKeyOf(input.dateKey),
      description,
      currency,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      postedByUserId: actorUserIdOf(ctx),
      postedAt: ctx.now,
      evidenceObjectIds: [...new Set(input.evidenceObjectIds ?? [])].slice(0, 50),
      meta: input.meta ? toOperationalJson(input.meta) : undefined,
    },
  });
  await tx.ledgerLine.createMany({
    data: lines.map((line) => ({
      entryId: entry.id,
      seq: line.seq,
      accountType: line.accountType,
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      costCenterId: line.costCenterId,
      caseId: line.caseId,
      procurementOrderId: line.procurementOrderId,
      projectRef: line.projectRef,
      memo: line.memo,
    })),
  });
  const written = await tx.ledgerLine.findMany({ where: { entryId: entry.id }, orderBy: { seq: 'asc' } });
  await applyCashDeltas(tx, cashDeltas(lines));

  const totals = assertBalanced(written);
  const caseIds = [...new Set(lines.map((l) => l.caseId).filter((id): id is string => Boolean(id)))];
  ctx.emit(
    FINANCE_EVENTS.ledger.posted,
    {
      entryId: entry.id,
      number: entry.number,
      kind: entry.kind,
      date: input.dateKey,
      periodKey: entry.periodKey,
      total: totals.totalDebit.toFixed(2),
      currency,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      reversesEntryId: entry.reversesEntryId,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.ledgerEntry, entry.id, caseIds.length === 1 ? caseIds[0] : null)
  );
  publishBoard(ctx, 'finance.ledger', { entryId: entry.id, number: entry.number, kind: entry.kind });
  return { ...entry, lines: written };
}

export interface ReverseLedgerEntryInput {
  entryId: string;
  reason: string;
  dateKey?: string | null;
}

export interface ReverseLedgerEntryResult {
  original: LedgerEntry;
  reversal: LedgerEntryWithLines;
}

export async function reverseLedgerEntry(
  tx: Db,
  input: ReverseLedgerEntryInput,
  ctx: CommandContext
): Promise<ReverseLedgerEntryResult> {
  const reason = (input.reason ?? '').trim();
  if (reason.length < 3) throw financeError('invalid_payload', 'Indica el motivo del reverso');
  const original = await tx.ledgerEntry.findUnique({
    where: { id: input.entryId },
    include: { lines: { orderBy: { seq: 'asc' } } },
  });
  if (!original) throw new OperationsError('not_found', 'No se encontró el asiento');
  assertReversible(original);
  const dateKey = reversalDateKey(dateKeyOf(original.date), todayKeyOf(ctx), input.dateKey ?? null);
  // Before claiming the original: a reversal into a closed period changes nothing.
  await assertPeriodOpen(tx, dateKey);

  const reversalId = newRowId();
  const claimed = await tx.ledgerEntry.updateMany({
    where: { id: original.id, reversedByEntryId: null },
    data: { reversedByEntryId: reversalId },
  });
  if (claimed.count !== 1) {
    throw financeError('already_reversed', `El asiento ${original.number} ya fue reversado`);
  }
  const reversal = await postLedgerEntry(
    tx,
    {
      id: reversalId,
      kind: 'reversal',
      dateKey,
      description: `Reverso de ${original.number}: ${reason}`.slice(0, 500),
      currency: original.currency,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      reversesEntryId: original.id,
      lines: mirrorForReversal(original.lines),
      meta: { reason: reason.slice(0, 500), originalNumber: original.number, originalKind: original.kind },
    },
    ctx
  );
  ctx.emit(
    FINANCE_EVENTS.ledger.reversed,
    {
      entryId: original.id,
      number: original.number,
      reversalEntryId: reversal.id,
      reversalNumber: reversal.number,
      date: dateKey,
      reason: reason.slice(0, 500),
      sourceType: original.sourceType,
      sourceId: original.sourceId,
    },
    financeEventOptions(FINANCE_OBJECT_TYPES.ledgerEntry, original.id)
  );
  return { original: { ...original, reversedByEntryId: reversal.id }, reversal };
}

// ---------------------------------------------------------------------------
// Manual entries
// ---------------------------------------------------------------------------

const manualLineSchema = z.object({
  accountType: z.enum(['cash', 'category', 'equity', 'clearing']),
  accountId: z.string().trim().min(1).max(120),
  debit: nonNegativeMoneySchema.optional(),
  credit: nonNegativeMoneySchema.optional(),
  costCenterId: z.string().trim().min(1).max(120).nullish(),
  caseId: z.string().trim().min(1).max(120).nullish(),
  projectRef: z.string().trim().max(120).nullish(),
  memo: z.string().trim().max(500).nullish(),
});

export const postManualEntrySchema = z.object({
  kind: z.enum(MANUAL_ENTRY_KINDS),
  date: dateKeySchema,
  description: z.string().trim().min(3).max(500),
  currency: currencySchema.default('MXN'),
  lines: z.array(manualLineSchema).min(2).max(200),
  evidenceObjectIds: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
});

export type PostManualEntryInput = z.input<typeof postManualEntrySchema>;

/**
 * A person's entry: income, expense, transfer between cash accounts or
 * adjustment (cash count differences). Receivables and payables are never
 * touched by hand: they move only through obligations.
 */
export async function postManualEntryInTx(
  tx: Db,
  input: z.output<typeof postManualEntrySchema>,
  ctx: CommandContext
): Promise<LedgerEntryWithLines> {
  if (input.kind === 'transfer' && input.lines.some((line) => line.accountType !== 'cash')) {
    throw financeError('invalid_line', 'Un traspaso sólo mueve cuentas de caja o banco');
  }
  if (input.lines.every((line) => line.accountType !== 'cash') && input.kind !== 'adjustment') {
    throw financeError('invalid_line', 'Un ingreso o gasto manual debe mover una cuenta de caja o banco');
  }
  // Money out of cash by hand follows the expense policy: only what the policy auto-approves
  // (small cash-count differences, petty expenses). Anything that needs a signature goes through
  // the expense flow (capture → approval → posting), so one person can never take money out alone.
  const outflow = manualCashOutflow(input.lines);
  if (outflow.greaterThan(0)) {
    const { requiredApprovals } = await resolveApprovalRequirement(tx, {
      scope: 'expense',
      amount: outflow,
      currency: input.currency,
    });
    if (requiredApprovals > 0) {
      throw financeError(
        'approval_required',
        `Un asiento manual que saca ${formatMxn(outflow, input.currency)} de caja necesita aprobación: captúralo como gasto para que pase por su autorización`,
        { outflow: outflow.toFixed(2), requiredApprovals }
      );
    }
  }
  return postLedgerEntry(
    tx,
    {
      kind: input.kind,
      dateKey: input.date,
      description: input.description,
      currency: input.currency,
      sourceType: LEDGER_SOURCE_TYPES.manual,
      sourceId: null,
      evidenceObjectIds: input.evidenceObjectIds,
      lines: input.lines.map((line) => ({
        ...line,
        debit: line.debit ? roundMoney(line.debit) : null,
        credit: line.credit ? roundMoney(line.credit) : null,
      })),
    },
    ctx
  );
}

export const reverseEntrySchema = z.object({
  entryId: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(3).max(500),
  date: dateKeySchema.nullish(),
});

const DOMAIN_HINTS: Record<string, string> = {
  [LEDGER_SOURCE_TYPES.obligation]:
    'Este asiento pertenece a una obligación: cancélala, castígala o reversa su liquidación desde la obligación',
  [LEDGER_SOURCE_TYPES.expense]: 'Este asiento pertenece a un gasto: reversa el gasto contabilizado',
  [LEDGER_SOURCE_TYPES.payrollRun]: 'Este asiento pertenece a una nómina: cancela la nómina',
};

/** Reversal of a manual entry; domain entries are reversed by their own flow. */
export async function reverseManualEntryInTx(
  tx: Db,
  input: z.output<typeof reverseEntrySchema>,
  ctx: CommandContext
): Promise<ReverseLedgerEntryResult> {
  const entry = await tx.ledgerEntry.findUnique({
    where: { id: input.entryId },
    select: { id: true, sourceType: true },
  });
  if (!entry) throw new OperationsError('not_found', 'No se encontró el asiento');
  if (entry.sourceType && entry.sourceType !== LEDGER_SOURCE_TYPES.manual) {
    throw financeError(
      'domain_entry',
      DOMAIN_HINTS[entry.sourceType] ?? 'Este asiento pertenece a otro proceso: corrígelo desde ese proceso'
    );
  }
  return reverseLedgerEntry(tx, { entryId: entry.id, reason: input.reason, dateKey: input.date ?? null }, ctx);
}

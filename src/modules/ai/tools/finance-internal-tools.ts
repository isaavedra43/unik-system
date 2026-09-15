import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import { getBudgetVsActual, getCashBook, getCashflowProjection } from '@/modules/finance/cashflow-service';
import { supplierKeyOf } from '@/modules/finance/expense-duplicates';
import { buildExtractionMaterial, proposeExpenseWithAi } from '@/modules/finance/expense-extraction';
import {
  resolveExpenseProposal,
  suggestExpenseClassification,
  type ExpenseProposalRaw,
} from '@/modules/finance/expense-rules';
import { findExpenseDuplicates } from '@/modules/finance/expenses-service';
import { captureExpense, matchPaymentToObligation, submitExpense } from '@/modules/finance/finance-commands';
import { addDaysToKey, dateKeyOf, localDateKey, toDbDate } from '@/modules/finance/finance-dates';
import { loadCatalogRefs } from '@/modules/finance/finance-helpers';
import { getExpense, listUnassignedCollections } from '@/modules/finance/finance-queries';
import { remainingOf } from '@/modules/finance/obligation-rules';
import {
  OperationsToolError,
  checkActingScope,
  checkReadingScope,
  creationCommandId,
  formatMoney,
  isBotActor,
  transitionCommandId,
  truncateText,
  unwrapCommand,
} from './operations-tool-kit';
import { registerTool, type ToolDefinition, type ToolExecutionContext } from './registry';

/**
 * AI tools of the internal accounting (plan 6.6): named apart from the Zoho
 * finance tools (`finance-tools.ts`).
 *
 * - `captureExpenseDraft` (draft): one-step capture of an expense from what the
 *   person said; the proposal job fills the rest.
 * - `proposeExpenseFields`, `checkExpenseDuplicate`, `getCashflowProjection`,
 *   `getBudgetVsActual`, `listUnmatchedPayments`, `getCashBook` (read).
 * - `submitExpense`, `matchPaymentToObligation` (business_write): an approval
 *   card; the approved proposal runs as the person who approved it (an AI
 *   identity never submits expenses nor assigns money).
 *
 * The finance services enforce permissions and ownership; these tools add the
 * AI identity scope (only the Contabilidad identity, or the administrator for
 * readings, works here).
 */

const FINANCE_TOOL_CONTEXT_TAGS = ['/app/finance', '/app/mywork', '/app/areas'];
const AREA = 'contabilidad' as const;

type ScopeCtx = ToolExecutionContext | undefined;

function registerFinanceTool(def: Omit<ToolDefinition, 'category' | 'enabledByDefault'>): void {
  registerTool({ category: 'finance', enabledByDefault: true, contextTags: FINANCE_TOOL_CONTEXT_TAGS, ...def });
}

function assertReading(actor: CurrentUser, ctx: ScopeCtx): void {
  const reason = checkReadingScope(actor, AREA, ctx);
  if (reason) throw new OperationsToolError(reason, 'forbidden');
}

function assertActing(actor: CurrentUser, ctx: ScopeCtx): void {
  const reason = checkActingScope(actor, AREA, ctx);
  if (reason) throw new OperationsToolError(reason, 'forbidden');
}

function can(actor: CurrentUser, key: string): boolean {
  return isKnownPermission(key) && hasPermission(actor, key);
}

const dayArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa AAAA-MM-DD');
const idArg = z.string().trim().min(1).max(120);

// ---------------------------------------------------------------------------
// captureExpenseDraft
// ---------------------------------------------------------------------------

export const captureExpenseDraftParams = z.object({
  text: z.string().trim().min(3).max(2000).describe('El gasto como lo dijo la persona: concepto, monto, proveedor, fecha, forma de pago'),
  amount: z.number().positive().describe('Monto total si la persona lo dijo').optional(),
  date: dayArg.describe('Fecha del gasto AAAA-MM-DD si la persona la dijo').optional(),
  supplierName: z.string().trim().max(200).describe('Proveedor si la persona lo dijo').optional(),
  categoryId: idArg.describe('Categoría de gasto (id) si ya se conoce').optional(),
  costCenterId: idArg.describe('Centro de costo (id) si ya se conoce').optional(),
  caseId: idArg.describe('Expediente al que pertenece').optional(),
  isPaid: z.boolean().describe('false si se pagará después (crédito)').optional(),
  paymentMethod: z.enum(['cash', 'transfer', 'card', 'other']).optional(),
});

registerFinanceTool({
  name: 'captureExpenseDraft',
  description:
    'Captura un gasto como BORRADOR a partir de lo que dijo o escribió la persona (un solo paso). La categoría, proveedor, importe y centro de costo los propone el sistema en segundos; el borrador no mueve dinero ni pide aprobación: la persona lo revisa y lo envía con submitExpense.',
  requiredPermission: 'finance.capture_expense',
  effect: 'draft',
  parameters: captureExpenseDraftParams,
  execute: async (actor, raw, ctx) => {
    const args = raw as z.output<typeof captureExpenseDraftParams>;
    assertActing(actor, ctx);
    const result = unwrapCommand(
      await captureExpense(
        actor,
        {
          captureMode: 'text',
          rawInput: args.text,
          ...(args.amount !== undefined ? { amount: args.amount } : {}),
          ...(args.date ? { date: args.date } : {}),
          ...(args.supplierName ? { supplierNameFree: args.supplierName } : {}),
          ...(args.categoryId ? { categoryId: args.categoryId } : {}),
          ...(args.costCenterId ? { costCenterId: args.costCenterId } : {}),
          ...(args.caseId ? { caseId: args.caseId } : {}),
          ...(args.isPaid !== undefined ? { isPaid: args.isPaid } : {}),
          ...(args.paymentMethod ? { paymentMethod: args.paymentMethod } : {}),
        },
        { commandId: creationCommandId('captureExpenseDraft', actor.id, args, ctx) }
      )
    );
    if (!result.data) throw new OperationsToolError('La captura se está procesando; intenta de nuevo en un momento', 'accepted');
    const data = result.data;
    return {
      expenseId: data.expenseId,
      number: data.number,
      status: data.status,
      duplicateStatus: data.duplicateStatus,
      possibleDuplicates: data.matches ?? [],
      proposalQueued: data.proposalQueued ?? false,
      message:
        data.duplicateStatus === 'suspect'
          ? `Borrador ${data.number} creado, pero parece duplicado: confirma con la persona si es único antes de enviarlo`
          : `Borrador ${data.number} creado; la propuesta de categoría, proveedor e importe llega en unos segundos. Revísalo y envíalo a aprobación.`,
    };
  },
});

// ---------------------------------------------------------------------------
// proposeExpenseFields
// ---------------------------------------------------------------------------

export const proposeExpenseFieldsParams = z
  .object({
    text: z.string().trim().min(3).max(2000).describe('Descripción libre del gasto a interpretar').optional(),
    expenseId: idArg.describe('Gasto ya capturado: devuelve su propuesta actual').optional(),
  })
  .refine((v) => Boolean(v.text || v.expenseId), { message: 'Indica el texto del gasto o el gasto (expenseId)' });

registerFinanceTool({
  name: 'proposeExpenseFields',
  description:
    'Propone los campos de un gasto (importe, fecha, proveedor, categoría, centro de costo, forma de pago) a partir de un texto, sin guardar nada; con expenseId devuelve la propuesta que ya calculó el sistema para ese borrador. Úsala para confirmar datos con la persona antes de capturar.',
  requiredPermission: 'finance.capture_expense',
  effect: 'read',
  parameters: proposeExpenseFieldsParams,
  execute: async (actor, input, ctx) => {
    const args = input as z.output<typeof proposeExpenseFieldsParams>;
    assertActing(actor, ctx);
    if (args.expenseId) {
      const expense = await getExpense(actor, args.expenseId);
      return {
        expenseId: expense.id,
        number: expense.number,
        status: expense.status,
        current: {
          amount: expense.amount,
          date: expense.date,
          supplierId: expense.supplierId,
          supplierName: expense.supplierNameFree,
          categoryId: expense.categoryId,
          costCenterId: expense.costCenterId,
          paymentMethod: expense.paymentMethod,
          isPaid: expense.isPaid,
        },
        proposal: expense.aiProposal,
        duplicateStatus: expense.duplicateStatus,
      };
    }
    const now = new Date();
    const todayKey = localDateKey(now);
    const refs = await loadCatalogRefs(prisma);
    const [history, suppliers] = await Promise.all([
      prisma.expense.findMany({
        where: { status: { in: ['approved', 'posted'] }, date: { gte: toDbDate(addDaysToKey(todayKey, -183)) } },
        select: { supplierId: true, supplierNameFree: true, categoryId: true, costCenterId: true, date: true },
        orderBy: { date: 'desc' },
        take: 500,
      }),
      prisma.supplier.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, legalName: true, taxRegNo: true },
        take: 2000,
      }),
    ]);
    const historyRows = history.map((row) => ({
      supplierKey: supplierKeyOf(row),
      categoryId: row.categoryId,
      costCenterId: row.costCenterId,
      dateKey: dateKeyOf(row.date),
    }));
    let raw: ExpenseProposalRaw | null = null;
    let source: 'ai' | 'rules' = 'rules';
    let error: string | null = null;
    try {
      const material = await buildExtractionMaterial({ rawInput: args.text ?? null, receipts: [] });
      const ai = await proposeExpenseWithAi({ material, categories: refs.categories, costCenters: refs.costCenters, todayKey, currency: 'MXN' });
      raw = ai.raw;
      source = 'ai';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const supplierKey = supplierKeyOf({ supplierNameFree: raw?.supplierName ?? null });
    const fallback = suggestExpenseClassification({
      supplierKey,
      description: args.text,
      history: historyRows,
      categories: refs.categories,
      costCenters: refs.costCenters,
    });
    const resolved = resolveExpenseProposal(raw, {
      categories: refs.categories,
      costCenters: refs.costCenters,
      suppliers,
      todayKey,
      fallback,
      expenseCurrency: 'MXN',
    });
    const nameOf = (list: Array<{ id: string; name: string }>, id: string | null) => (id ? (list.find((row) => row.id === id)?.name ?? null) : null);
    return {
      source,
      error,
      proposal: {
        ...resolved,
        categoryName: nameOf(refs.categories, resolved.categoryId),
        costCenterName: nameOf(refs.costCenters, resolved.costCenterId),
        supplierName: nameOf(suppliers, resolved.supplierId) ?? resolved.supplierNameFree,
      },
      note: 'Propuesta sin guardar: confírmala con la persona y captúrala con captureExpenseDraft.',
    };
  },
});

// ---------------------------------------------------------------------------
// checkExpenseDuplicate
// ---------------------------------------------------------------------------

export const checkExpenseDuplicateParams = z
  .object({
    expenseId: idArg.describe('Gasto capturado a revisar').optional(),
    amount: z.number().positive().describe('Monto a buscar (sin expenseId)').optional(),
    date: dayArg.describe('Fecha AAAA-MM-DD (sin expenseId)').optional(),
    supplierName: z.string().trim().max(200).optional(),
  })
  .refine((v) => Boolean(v.expenseId || (v.amount && v.date)), { message: 'Indica el gasto (expenseId) o el monto y la fecha' });

registerFinanceTool({
  name: 'checkExpenseDuplicate',
  description:
    'Revisa si un gasto parece duplicado: mismo comprobante, mismo importe-fecha-proveedor, o importe ±1 % en ±3 días. Con expenseId revisa ese borrador; con monto y fecha busca en todos los gastos (requiere ver la contabilidad).',
  requiredPermission: 'finance.capture_expense',
  effect: 'read',
  parameters: checkExpenseDuplicateParams,
  execute: async (actor, raw, ctx) => {
    const args = raw as z.output<typeof checkExpenseDuplicateParams>;
    assertActing(actor, ctx);
    let subject;
    if (args.expenseId) {
      const expense = await getExpense(actor, args.expenseId);
      subject = {
        id: expense.id,
        amount: expense.amount,
        dateKey: expense.date,
        supplierId: expense.supplierId,
        supplierNameFree: expense.supplierNameFree,
        receiptHash: expense.receiptHash,
      };
    } else {
      if (!can(actor, 'finance.view')) {
        throw new OperationsToolError('Para buscar entre todos los gastos necesitas ver la contabilidad; indica tu gasto (expenseId)', 'forbidden');
      }
      subject = { amount: String(args.amount), dateKey: args.date as string, supplierNameFree: args.supplierName ?? null };
    }
    const matches = await findExpenseDuplicates(prisma, subject);
    return {
      duplicates: matches.slice(0, 10).map((m) => ({ expenseId: m.expenseId, number: m.number, kind: m.kind, reason: m.reason, daysApart: m.daysApart })),
      verdict: matches.length === 0 ? 'Sin duplicados aparentes' : `${matches.length} posible(s) duplicado(s)`,
    };
  },
});

// ---------------------------------------------------------------------------
// submitExpense
// ---------------------------------------------------------------------------

export const submitExpenseParams = z.object({
  expenseId: idArg.describe('Borrador de gasto a enviar a aprobación'),
  number: z.string().max(40).describe('Lo completa el sistema').optional(),
  amount: z.string().max(40).describe('Lo completa el sistema').optional(),
  currency: z.string().max(3).describe('Lo completa el sistema').optional(),
  concept: z.string().max(200).describe('Lo completa el sistema').optional(),
});

registerFinanceTool({
  name: 'submitExpense',
  description:
    'Envía un borrador de gasto a su aprobación de negocio (debajo del umbral se autoaprueba). Queda como propuesta que la persona confirma; no se envía si el gasto parece duplicado sin resolver.',
  requiredPermission: 'finance.capture_expense',
  effect: 'business_write',
  parameters: submitExpenseParams,
  summarize: (raw) => {
    const a = raw as z.output<typeof submitExpenseParams>;
    const money = a.amount ? ` por ${formatMoney(a.amount, a.currency ?? 'MXN')}` : '';
    return `Enviar a aprobación el gasto ${a.number ?? a.expenseId}${money}${a.concept ? ` · ${truncateText(a.concept, 120)}` : ''}`;
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as z.output<typeof submitExpenseParams>;
    const scope = checkActingScope(actor, AREA, ctx);
    if (scope) return { error: scope };
    const expense = await getExpense(actor, args.expenseId);
    if (expense.status !== 'draft') return { error: `${expense.number} ya no es un borrador (${expense.statusLabel})` };
    if (expense.duplicateStatus === 'suspect') {
      return { error: `${expense.number} parece duplicado: confirma con la persona si es único antes de enviarlo` };
    }
    if (expense.duplicateStatus === 'confirmed_duplicate') return { error: `${expense.number} está marcado como duplicado` };
    return {
      args: {
        expenseId: expense.id,
        number: expense.number,
        amount: expense.amount,
        currency: expense.currency,
        concept: truncateText(expense.description ?? expense.supplierNameFree ?? '', 200) || undefined,
      },
    };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as z.output<typeof submitExpenseParams>;
    assertActing(actor, ctx);
    if (isBotActor(actor)) throw new OperationsToolError('Un gasto lo envía una persona: queda como propuesta', 'forbidden');
    const result = unwrapCommand(
      await submitExpense(actor, { expenseId: args.expenseId }, { commandId: transitionCommandId('submitExpense', ctx) })
    );
    const data = result.data;
    if (!data) throw new OperationsToolError('El envío se está procesando; revisa el gasto en un momento', 'accepted');
    if (!data.submitted) {
      return { ...data, message: `No se envió: ${data.number} parece duplicado de ${data.matches?.[0]?.number ?? 'otro gasto'}; resuélvelo primero` };
    }
    return {
      ...data,
      message: data.autoApproved
        ? `${data.number} quedó aprobado por la política (bajo el umbral); falta contabilizarlo`
        : `${data.number} espera ${data.requiredApprovals ?? 1} aprobación(es) en Mi trabajo`,
    };
  },
});

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

export const cashflowParams = z.object({
  weeks: z.number().int().min(1).max(26).describe('Semanas a proyectar (8 por omisión)').optional(),
  from: dayArg.describe('Desde (AAAA-MM-DD); por omisión esta semana').optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});

registerFinanceTool({
  name: 'getCashflowProjection',
  description:
    'Flujo de efectivo por semana: cobros y pagos proyectados (obligaciones abiertas por su fecha esperada, lo vencido en la primera semana) contra lo realmente cobrado y pagado, con el saldo proyectado.',
  requiredPermission: 'finance.view',
  effect: 'read',
  parameters: cashflowParams,
  execute: async (actor, raw, ctx) => {
    assertReading(actor, ctx);
    return getCashflowProjection(actor, raw as z.output<typeof cashflowParams>);
  },
});

export const budgetParams = z.object({
  periodKey: z.string().regex(/^\d{4}-\d{2}$/, 'Usa AAAA-MM').describe('Mes AAAA-MM'),
  costCenterId: idArg.optional(),
});

registerFinanceTool({
  name: 'getBudgetVsActual',
  description: 'Presupuesto contra real de un mes por centro de costo y categoría, con variación y porcentaje usado; incluye lo gastado sin presupuesto.',
  requiredPermission: 'finance.view',
  effect: 'read',
  parameters: budgetParams,
  execute: async (actor, raw, ctx) => {
    assertReading(actor, ctx);
    return getBudgetVsActual(actor, raw as z.output<typeof budgetParams>);
  },
});

export const unmatchedParams = z.object({
  from: dayArg.describe('Pagos desde (AAAA-MM-DD)').optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

registerFinanceTool({
  name: 'listUnmatchedPayments',
  description:
    'Cobros de Zoho sincronizados que aún no se asignan (o sólo en parte) a cuentas por cobrar esperadas: monto, aplicado, pendiente y si ya hay un trabajo "Asignar cobro".',
  requiredPermission: 'finance.view',
  effect: 'read',
  parameters: unmatchedParams,
  execute: async (actor, raw, ctx) => {
    assertReading(actor, ctx);
    const args = raw as z.output<typeof unmatchedParams>;
    const payments = await listUnassignedCollections(actor, { from: args.from, limit: args.limit ?? 30 });
    return { payments, count: payments.length };
  },
});

export const cashBookParams = z.object({
  cashAccountId: idArg.optional(),
  cashAccountKey: z.string().trim().max(60).describe('Clave de la cuenta, p. ej. caja_general o banco_zoho').optional(),
  from: dayArg.optional(),
  to: dayArg.optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

registerFinanceTool({
  name: 'getCashBook',
  description: 'Libro de caja de una cuenta (caja o banco): saldo inicial, movimientos con saldo corrido y saldo final en un rango de fechas.',
  requiredPermission: 'finance.view',
  effect: 'read',
  parameters: cashBookParams,
  execute: async (actor, raw, ctx) => {
    assertReading(actor, ctx);
    const args = raw as z.output<typeof cashBookParams>;
    let cashAccountId = args.cashAccountId;
    if (!cashAccountId) {
      const account = await prisma.cashAccount.findUnique({ where: { key: args.cashAccountKey ?? 'caja_general' }, select: { id: true } });
      if (!account) throw new OperationsToolError(`No existe la cuenta ${args.cashAccountKey ?? 'caja_general'}`, 'not_found');
      cashAccountId = account.id;
    }
    return getCashBook(actor, { cashAccountId, from: args.from, to: args.to, page: args.page, pageSize: args.pageSize ?? 50 });
  },
});

// ---------------------------------------------------------------------------
// matchPaymentToObligation
// ---------------------------------------------------------------------------

export const matchPaymentParams = z.object({
  zohoPaymentId: idArg.describe('Pago de Zoho (zohoPaymentId de listUnmatchedPayments)'),
  allocations: z
    .array(z.object({ obligationId: idArg, amount: z.number().positive() }))
    .min(1)
    .max(20)
    .describe('Cuentas por cobrar y montos a los que se aplica el pago'),
  paymentLabel: z.string().max(200).describe('Lo completa el sistema').optional(),
  allocationLabels: z.array(z.string().max(200)).max(20).describe('Lo completa el sistema').optional(),
});

registerFinanceTool({
  name: 'matchPaymentToObligation',
  description:
    'Asigna un cobro de Zoho a una o varias cuentas por cobrar (puede repartirse). Registra la liquidación en "Banco (Zoho)" y cierra el trabajo "Asignar cobro" cuando no queda remanente. Queda como propuesta que la persona confirma.',
  requiredPermission: 'finance.manage_obligations',
  effect: 'business_write',
  parameters: matchPaymentParams,
  summarize: (raw) => {
    const a = raw as z.output<typeof matchPaymentParams>;
    const targets = a.allocationLabels?.length
      ? a.allocationLabels.join(', ')
      : a.allocations.map((x) => `${x.obligationId} ${formatMoney(x.amount)}`).join(', ');
    return `Asignar el pago ${a.paymentLabel ?? a.zohoPaymentId} a ${truncateText(targets, 300)}`;
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as z.output<typeof matchPaymentParams>;
    const scope = checkActingScope(actor, AREA, ctx);
    if (scope) return { error: scope };
    const payment = await prisma.customerPayment.findUnique({ where: { zohoPaymentId: args.zohoPaymentId } });
    if (!payment) return { error: 'No encontré ese pago de Zoho' };
    const ids = [...new Set(args.allocations.map((a) => a.obligationId))];
    if (ids.length !== args.allocations.length) return { error: 'Una cuenta por cobrar aparece dos veces' };
    const obligations = await prisma.obligation.findMany({ where: { id: { in: ids } } });
    const labels: string[] = [];
    for (const allocation of args.allocations) {
      const obligation = obligations.find((o) => o.id === allocation.obligationId);
      if (!obligation) return { error: 'Una cuenta por cobrar no existe' };
      if (obligation.kind !== 'receivable') return { error: `${obligation.number} no es una cuenta por cobrar` };
      if (obligation.status !== 'expected' && obligation.status !== 'partially_settled') {
        return { error: `${obligation.number} ya no tiene saldo pendiente` };
      }
      if (allocation.amount > remainingOf(obligation).toNumber() + 0.005) {
        return { error: `El monto para ${obligation.number} excede su saldo (${formatMoney(remainingOf(obligation).toFixed(2), obligation.currency)})` };
      }
      labels.push(`${obligation.number}${obligation.counterpartyName ? ` (${truncateText(obligation.counterpartyName, 60)})` : ''} ${formatMoney(allocation.amount, obligation.currency)}`);
    }
    return {
      args: {
        ...args,
        paymentLabel: `${payment.paymentNumber ?? payment.zohoPaymentId}${payment.customerName ? ` de ${truncateText(payment.customerName, 80)}` : ''}`,
        allocationLabels: labels,
      },
    };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as z.output<typeof matchPaymentParams>;
    assertActing(actor, ctx);
    if (isBotActor(actor)) throw new OperationsToolError('Una IA no asigna cobros: la asignación la confirma una persona', 'forbidden');
    const payload = {
      zohoPaymentId: args.zohoPaymentId,
      allocations: args.allocations.map((a) => ({ obligationId: a.obligationId, amount: a.amount.toFixed(2) })),
    };
    const result = unwrapCommand(
      await matchPaymentToObligation(actor, payload, { commandId: creationCommandId('matchPaymentToObligation', actor.id, payload, ctx) })
    );
    const data = result.data;
    if (!data) throw new OperationsToolError('La asignación se está procesando; revisa el pago en un momento', 'accepted');
    return {
      ...data,
      message:
        data.applied.length === 0
          ? 'El pago ya estaba aplicado a esas cuentas; no se registró nada nuevo'
          : `Pago asignado a ${data.applied.map((a) => a.number).join(', ')}${data.remaining !== '0.00' ? `; quedan ${formatMoney(data.remaining)} por asignar` : ''}`,
    };
  },
});

/** Names of the internal accounting tools (for enabledTools and the tool allowlist of the Contabilidad identity). */
export const FINANCE_INTERNAL_TOOL_NAMES = [
  'captureExpenseDraft',
  'proposeExpenseFields',
  'checkExpenseDuplicate',
  'submitExpense',
  'getCashflowProjection',
  'getBudgetVsActual',
  'listUnmatchedPayments',
  'matchPaymentToObligation',
  'getCashBook',
] as const;

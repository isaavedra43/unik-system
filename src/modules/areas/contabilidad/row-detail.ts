import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { markSensitive } from '@/modules/areas/area-work-row';
import type { AreaRowDetail, AreaRowEvidence, AreaRowField } from '@/modules/areas/area-work-row';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import {
  agingBucket,
  daysOverdue,
  paymentAuthorizationState,
} from '@/modules/finance/obligation-rules';
import { localDateKey } from '@/modules/finance/finance-dates';
import { FINANCE_OBJECT_TYPES } from '@/modules/finance/types';
import {
  EXPENSE_ROW_KIND,
  OBLIGATION_ROW_KIND,
  PERIOD_CLOSE_ROW_KIND,
  agingBucketLabel,
  closeKindLabel,
  closeStatusLabel,
  duplicateStatusLabel,
  expenseStatusLabel,
  formatDateKey,
  formatMoney,
  formatPeriodKey,
  obligationStatusLabel,
  parseCloseChecks,
  paymentAuthorizationLabel,
  summarizeCloseChecks,
  whereItIsAttended,
} from './contabilidad-model';

/**
 * Detail of a Contabilidad row for the drawer and the detail page (plan 7.4).
 * SERVER ONLY. It returns the facts, the receipts already attached and the
 * untrusted text the person dictated or wrote (`freeText`, rendered as a
 * quote, never as an instruction).
 *
 * `evidenceTargetId` stays null on purpose: a receipt belongs to the
 * `expense_receipt` upload target of `finance-storage`, not to the operational
 * evidence target the shared drawer uploads to, so receipts are attached from
 * "Capturar gasto" where the duplicate check and the AI proposal run.
 */

function field(
  label: string,
  value: string | null | undefined,
  hint?: string | null
): AreaRowField | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { label, value: text, hint: hint ?? null } : null;
}

function compact(fields: Array<AreaRowField | null>): AreaRowField[] {
  return fields.filter((entry): entry is AreaRowField => entry !== null);
}

const PAYMENT_METHOD_LABELS: Readonly<Record<string, string>> = {
  cash: 'Efectivo',
  transfer: 'Transferencia',
  card: 'Tarjeta',
  other: 'Otro',
};

const COUNTERPARTY_LABELS: Readonly<Record<string, string>> = {
  supplier: 'Proveedor',
  customer: 'Cliente',
  employee: 'Empleado',
  tax: 'Impuestos',
  lender: 'Acreedor',
  other: 'Otro',
};

const CAPTURE_MODE_LABELS: Readonly<Record<string, string>> = {
  form: 'Formulario',
  text: 'Texto',
  voice: 'Voz',
  photo: 'Foto',
  template: 'Plantilla',
  recurring: 'Recurrente',
};

function receiptEvidence(objectIds: readonly string[], createdAt: Date): AreaRowEvidence[] {
  return objectIds.slice(0, 10).map((objectId, index) => ({
    id: objectId,
    kind: 'document',
    label: `Comprobante ${index + 1}`,
    note: null,
    createdAt: createdAt.toISOString(),
    createdByName: null,
    storageObjectId: objectId,
  }));
}

async function expenseDetail(row: AreaWorkRow): Promise<Partial<AreaRowDetail> | null> {
  const expense = await prisma.expense.findUnique({
    where: { id: row.sourceId },
    include: { splits: true },
  });
  if (!expense) return null;

  const [supplier, category, costCenter, cashAccount, approval, creator, duplicateOf] =
    await Promise.all([
      expense.supplierId
        ? prisma.supplier.findUnique({ where: { id: expense.supplierId }, select: { name: true } })
        : null,
      expense.categoryId
        ? prisma.financeCategory.findUnique({
            where: { id: expense.categoryId },
            select: { name: true },
          })
        : null,
      expense.costCenterId
        ? prisma.costCenter.findUnique({
            where: { id: expense.costCenterId },
            select: { name: true },
          })
        : null,
      expense.cashAccountId
        ? prisma.cashAccount.findUnique({
            where: { id: expense.cashAccountId },
            select: { name: true },
          })
        : null,
      expense.approvalRequestId
        ? prisma.approvalRequest.findUnique({
            where: { id: expense.approvalRequestId },
            select: { status: true, requiredApprovals: true, decisions: true },
          })
        : null,
      prisma.user.findUnique({ where: { id: expense.createdByUserId }, select: { name: true } }),
      expense.duplicateOfId
        ? prisma.expense.findUnique({
            where: { id: expense.duplicateOfId },
            select: { number: true },
          })
        : null,
    ]);

  const votes = Array.isArray(approval?.decisions)
    ? (approval?.decisions as Array<{ decision?: string }>)
    : [];
  const approved = votes.filter((vote) => vote?.decision === 'approve').length;
  const splitTotal = expense.splits.length;

  const fields = compact([
    field('Folio', expense.number),
    field('Estado', expenseStatusLabel(expense.status)),
    markSensitive(
      field('Importe', formatMoney(expense.amount.toString(), expense.currency)),
      'amount'
    ),
    field('Fecha', formatDateKey(localDateKey(expense.date))),
    field('Proveedor', supplier?.name ?? expense.supplierNameFree),
    field('Categoría', category?.name, category ? null : 'Falta la categoría para poder enviarlo'),
    field('Centro de costo', costCenter?.name),
    field(
      'Pago',
      expense.isPaid ? 'Ya pagado' : 'Por pagar (generará una cuenta por pagar)',
      [
        cashAccount?.name,
        expense.paymentMethod ? PAYMENT_METHOD_LABELS[expense.paymentMethod] : null,
      ]
        .filter(Boolean)
        .join(' · ') || null
    ),
    field(
      'Comprobantes',
      String(expense.receiptObjectIds.length),
      expense.receiptObjectIds.length === 0 ? 'Sin comprobante adjunto' : null
    ),
    field('Captura', CAPTURE_MODE_LABELS[expense.captureMode] ?? expense.captureMode),
    field(
      'Duplicado',
      duplicateStatusLabel(expense.duplicateStatus),
      duplicateOf ? `Posible original: ${duplicateOf.number}` : null
    ),
    approval
      ? field(
          'Aprobación',
          `${approved} de ${approval.requiredApprovals} firmas`,
          `Solicitud ${approval.status === 'pending' ? 'pendiente' : approval.status}`
        )
      : null,
    splitTotal > 0
      ? field('Reparto', `${splitTotal} ${splitTotal === 1 ? 'línea' : 'líneas'}`)
      : null,
    field('Capturado por', creator?.name),
    field('Descripción', expense.description),
    field('Dónde se atiende', whereItIsAttended(EXPENSE_ROW_KIND)),
  ]);

  return {
    fields,
    evidence: receiptEvidence(expense.receiptObjectIds, expense.createdAt),
    evidenceTargetId: null,
    missingEvidence: expense.receiptObjectIds.length === 0 ? ['document'] : [],
    freeText: expense.rawInput,
  };
}

async function obligationDetail(
  row: AreaWorkRow,
  now: Date
): Promise<Partial<AreaRowDetail> | null> {
  const obligation = await prisma.obligation.findUnique({
    where: { id: row.sourceId },
    include: { settlements: { orderBy: { settledAt: 'asc' } } },
  });
  if (!obligation) return null;

  const [category, approvals, expense, supplier] = await Promise.all([
    prisma.financeCategory.findUnique({
      where: { id: obligation.categoryId },
      select: { name: true },
    }),
    prisma.approvalRequest.findMany({
      where: {
        scope: 'payment',
        targetType: FINANCE_OBJECT_TYPES.obligation,
        targetId: obligation.id,
      },
      select: { status: true, createdAt: true },
    }),
    obligation.expenseId
      ? prisma.expense.findUnique({
          where: { id: obligation.expenseId },
          select: { number: true, receiptObjectIds: true },
        })
      : null,
    obligation.supplierId
      ? prisma.supplier.findUnique({ where: { id: obligation.supplierId }, select: { name: true } })
      : null,
  ]);

  const todayKey = localDateKey(now);
  const remaining = obligation.expectedAmount.minus(obligation.settledAmount);
  const open = obligation.status === 'expected' || obligation.status === 'partially_settled';
  const overdueDays = open ? daysOverdue(obligation.dueAt, todayKey) : null;
  const authorization = paymentAuthorizationState(obligation, approvals);

  const fields = compact([
    field('Folio', obligation.number),
    field('Tipo', obligation.kind === 'payable' ? 'Por pagar' : 'Por cobrar'),
    field(
      'Contraparte',
      supplier?.name ?? obligation.counterpartyName,
      COUNTERPARTY_LABELS[obligation.counterpartyType] ?? obligation.counterpartyType
    ),
    field('Estado', obligationStatusLabel(obligation.status)),
    markSensitive(
      field('Esperado', formatMoney(obligation.expectedAmount.toString(), obligation.currency)),
      'amount'
    ),
    markSensitive(
      field('Liquidado', formatMoney(obligation.settledAmount.toString(), obligation.currency)),
      'amount'
    ),
    open
      ? markSensitive(
          field('Pendiente', formatMoney(remaining.toString(), obligation.currency)),
          'amount'
        )
      : null,
    field(
      'Vence',
      obligation.dueAt ? formatDateKey(localDateKey(obligation.dueAt)) : 'Sin fecha',
      overdueDays && overdueDays > 0 ? `Vencida hace ${overdueDays} días` : null
    ),
    open ? field('Antigüedad', agingBucketLabel(agingBucket(obligation.dueAt, todayKey))) : null,
    obligation.kind === 'payable'
      ? field('Autorización de pago', paymentAuthorizationLabel(authorization))
      : null,
    field('Categoría', category?.name),
    field('Descripción', obligation.description),
    expense ? field('Gasto de origen', expense.number) : null,
    obligation.payrollRunId ? field('Origen', 'Corrida de nómina') : null,
    obligation.procurementOrderId ? field('Origen', 'Orden de compra') : null,
    obligation.zohoSalesOrderId
      ? field('Orden de venta (Zoho)', obligation.zohoSalesOrderId)
      : null,
    obligation.settlements.length > 0
      ? field(
          'Liquidaciones',
          `${obligation.settlements.length} ${obligation.settlements.length === 1 ? 'movimiento' : 'movimientos'}`,
          `Último el ${formatDateKey(localDateKey(obligation.settlements[obligation.settlements.length - 1].settledAt))}`
        )
      : null,
    field('Dónde se atiende', whereItIsAttended(OBLIGATION_ROW_KIND)),
  ]);

  const evidenceIds = [
    ...obligation.settlements.flatMap((settlement) => settlement.evidenceObjectIds),
    ...(expense?.receiptObjectIds ?? []),
  ];

  return {
    fields,
    evidence: receiptEvidence([...new Set(evidenceIds)], obligation.createdAt),
    evidenceTargetId: null,
    missingEvidence: [],
    freeText: null,
  };
}

async function periodCloseDetail(row: AreaWorkRow): Promise<Partial<AreaRowDetail> | null> {
  const close = await prisma.periodClose.findUnique({ where: { id: row.sourceId } });
  if (!close) return null;

  const checks = parseCloseChecks(close.checks);
  const progress = summarizeCloseChecks(checks);
  const closedBy = close.closedByUserId
    ? await prisma.user.findUnique({ where: { id: close.closedByUserId }, select: { name: true } })
    : null;

  const fields = compact([
    field(
      'Periodo',
      close.kind === 'monthly' ? formatPeriodKey(close.periodKey) : formatDateKey(close.periodKey)
    ),
    field('Tipo', `Cierre ${closeKindLabel(close.kind)}`),
    field('Estado', closeStatusLabel(close.status)),
    field(
      'Revisiones',
      progress.total > 0 ? `${progress.ok} de ${progress.total} en orden` : 'Sin intentos todavía'
    ),
    progress.blockers.length > 0
      ? field('Bloqueos', String(progress.blockers.length), progress.blockers[0].detail)
      : null,
    progress.warnings.length > 0 ? field('Advertencias', String(progress.warnings.length)) : null,
    close.closedAt
      ? field(
          'Cerrado',
          formatDateKey(localDateKey(close.closedAt)),
          closedBy?.name ? `Por ${closedBy.name}` : null
        )
      : null,
    field('Motivo de reapertura', close.reopenReason),
    field('Dónde se atiende', whereItIsAttended(PERIOD_CLOSE_ROW_KIND)),
    ...progress.blockers.slice(0, 4).map((blocker) => field(blocker.label, blocker.detail)),
  ]);

  return { fields, evidence: [], evidenceTargetId: null, missingEvidence: [], freeText: null };
}

/** Detail of one Contabilidad row; null when the row kind is not one of ours. */
export async function getContabilidadRowDetail(
  _actor: CurrentUser,
  row: AreaWorkRow,
  options: { now: Date }
): Promise<Partial<AreaRowDetail> | null> {
  switch (row.rowKind) {
    case EXPENSE_ROW_KIND:
      return expenseDetail(row);
    case OBLIGATION_ROW_KIND:
      return obligationDetail(row, options.now);
    case PERIOD_CLOSE_ROW_KIND:
      return periodCloseDetail(row);
    default:
      return null;
  }
}

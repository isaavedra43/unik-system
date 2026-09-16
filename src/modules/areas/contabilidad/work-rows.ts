import { Prisma } from '@prisma/client';
import {
  areaWorkRowSelect,
  type AreaWorkSqlFilters,
  type WorkRowBranch,
} from '@/modules/areas/work-rows-sql';
import {
  EXPENSE_STATUS_LABELS,
  OBLIGATION_STATUS_LABELS,
  EXPENSE_PENDING_STATUSES,
  OBLIGATION_OPEN_STATUSES,
} from '@/modules/finance/types';
import {
  EXPENSE_ROW_ACTIONS,
  EXPENSE_ROW_KIND,
  OBLIGATION_AUTHORIZATION_ACTIONS,
  OBLIGATION_CANCEL_ACTIONS,
  OBLIGATION_ROW_KIND,
  PERIOD_CLOSE_ROW_KIND,
  PERIOD_CLOSE_STATUS_LABELS,
  expenseStatusTone,
  obligationStatusTone,
  closeStatusTone,
  type BranchRowAction,
} from './contabilidad-model';

/**
 * Work rows of Contabilidad (plan 7.4): `Expense`, `Obligation` and the pending
 * tasks of `PeriodClose`, as three branches of the shared `UNION ALL`.
 *
 * Rules kept from the framework: every branch is built with `areaWorkRowSelect`
 * (canonical column list and order), every value written by a person travels as
 * a bound parameter, and the Spanish label and tone of each status travel in
 * `extra` so the table never shows a raw English state.
 *
 * These rows carry NO `extra.actions`: the generic row-action payload only
 * knows `note` / `reason` / `answer`, while every finance command needs its own
 * id inside the payload (`expenseId`, `obligationId`, `periodKey`…). Acting on
 * them therefore happens in the Contabilidad pages, which send the complete
 * command; the drawer says where each row is attended.
 */

const EXPENSE_OPEN_STATUSES = [...EXPENSE_PENDING_STATUSES];
const OPEN_OBLIGATION_STATUSES = [...OBLIGATION_OPEN_STATUSES];

/** `CASE col WHEN 'draft' THEN 'Borrador' … ELSE col END`, every value bound. */
function labelCase(column: Prisma.Sql, labels: Readonly<Record<string, string>>): Prisma.Sql {
  const entries = Object.entries(labels);
  if (entries.length === 0) return column;
  const whens = entries.map(([key, label]) => Prisma.sql`WHEN ${key} THEN ${label}`);
  return Prisma.sql`CASE ${column} ${Prisma.join(whens, ' ')} ELSE ${column} END`;
}

function toneCase(
  column: Prisma.Sql,
  statuses: readonly string[],
  tone: (status: string) => string
): Prisma.Sql {
  return labelCase(column, Object.fromEntries(statuses.map((status) => [status, tone(status)])));
}

function scopeFilter(scope: AreaWorkSqlFilters['scope'], open: Prisma.Sql): Prisma.Sql {
  if (scope === 'open') return Prisma.sql`AND ${open}`;
  if (scope === 'closed') return Prisma.sql`AND NOT (${open})`;
  return Prisma.empty;
}

/**
 * `extra.actions` of a row: the static definition of each action (bound as a
 * JSON parameter) merged with the payload its finance command needs, which is
 * the id of THIS row. `work-actions.parseBranchActions` validates the result
 * and `executeCommand` checks the permission, the schema and the version again.
 */
function actionsArray(
  actions: readonly BranchRowAction[],
  payloadKey: string,
  idColumn: Prisma.Sql
): Prisma.Sql {
  if (actions.length === 0) return Prisma.sql`'[]'::jsonb`;
  const items = actions.map(
    (action) =>
      Prisma.sql`(${JSON.stringify(action)}::jsonb || jsonb_build_object('payload', jsonb_build_object(${payloadKey}, ${idColumn})))`
  );
  return Prisma.sql`jsonb_build_array(${Prisma.join(items, ', ')})`;
}

/** `CASE status WHEN 'draft' THEN [...] … ELSE [] END` for a per-status action catalog. */
function actionsByStatus(
  column: Prisma.Sql,
  byStatus: Readonly<Record<string, readonly BranchRowAction[]>>,
  payloadKey: string,
  idColumn: Prisma.Sql
): Prisma.Sql {
  const entries = Object.entries(byStatus);
  if (entries.length === 0) return Prisma.sql`'[]'::jsonb`;
  const whens = entries.map(
    ([status, actions]) =>
      Prisma.sql`WHEN ${status} THEN ${actionsArray(actions, payloadKey, idColumn)}`
  );
  return Prisma.sql`CASE ${column} ${Prisma.join(whens, ' ')} ELSE '[]'::jsonb END`;
}

// ---------------------------------------------------------------------------
// Gastos
// ---------------------------------------------------------------------------

const EXPENSE_STATUSES = Object.keys(EXPENSE_STATUS_LABELS);

function expenseBranch(): WorkRowBranch {
  return {
    rowKind: EXPENSE_ROW_KIND,
    sql: (filters) => {
      const open = Prisma.sql`e."status" IN (${Prisma.join(EXPENSE_OPEN_STATUSES)})`;
      const caseFilter = filters.caseId
        ? Prisma.sql`AND e."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND e."createdByUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      const supplierName = Prisma.sql`COALESCE(NULLIF(s."name", ''), NULLIF(e."supplierNameFree", ''))`;
      return areaWorkRowSelect({
        rowKind: EXPENSE_ROW_KIND,
        from: Prisma.sql`FROM "Expense" e
          LEFT JOIN "Supplier" s ON s."id" = e."supplierId"
          LEFT JOIN "OperationalCase" c ON c."id" = e."caseId"`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeFilter(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`e."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`e."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`e."number" || ' · ' || COALESCE(${supplierName}, NULLIF(e."description", ''), 'Gasto')`,
          status: Prisma.sql`e."status"`,
          priority: Prisma.sql`CASE WHEN e."duplicateStatus" = 'suspect' THEN 'high' ELSE 'normal' END`,
          ownerUserId: Prisma.sql`e."createdByUserId"`,
          lastActivityAt: Prisma.sql`e."updatedAt"`,
          objectType: Prisma.sql`'expense'::text`,
          objectId: Prisma.sql`e."id"`,
          counterpartyName: supplierName,
          amount: Prisma.sql`e."amount"`,
          version: Prisma.sql`e."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${labelCase(Prisma.sql`e."status"`, EXPENSE_STATUS_LABELS)},
            'statusTone', ${toneCase(Prisma.sql`e."status"`, EXPENSE_STATUSES, expenseStatusTone)},
            'counterparty', ${supplierName},
            'periodKey', to_char(e."date", 'YYYY-MM'),
            'number', e."number",
            'currency', e."currency",
            'date', to_char(e."date", 'YYYY-MM-DD'),
            'captureMode', e."captureMode",
            'duplicateStatus', e."duplicateStatus",
            'isPaid', e."isPaid",
            'hasReceipt', COALESCE(cardinality(e."receiptObjectIds"), 0) > 0,
            'hasCategory', e."categoryId" IS NOT NULL,
            'approvalRequestId', e."approvalRequestId",
            'createdByUserId', e."createdByUserId",
            'actions', ${actionsByStatus(Prisma.sql`e."status"`, EXPENSE_ROW_ACTIONS, 'expenseId', Prisma.sql`e."id"`)}
          )`,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Obligaciones
// ---------------------------------------------------------------------------

const OBLIGATION_STATUSES = Object.keys(OBLIGATION_STATUS_LABELS);

/**
 * A payable that still needs a payment authorization: the same rule as
 * `obligation-rules.paymentAuthorizationState` (an approved expense or payroll
 * run already carries its approval, and an open `payment` request is enough).
 */
const NEEDS_PAYMENT_AUTHORIZATION = Prisma.sql`(
  o."kind" = 'payable'
  AND o."expenseId" IS NULL
  AND o."payrollRunId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ApprovalRequest" a
    WHERE a."scope" = 'payment'
      AND a."targetType" = 'obligation'
      AND a."targetId" = o."id"
      AND a."status" IN ('pending', 'approved')
  )
)`;

function obligationBranch(): WorkRowBranch {
  return {
    rowKind: OBLIGATION_ROW_KIND,
    sql: (filters) => {
      const open = Prisma.sql`o."status" IN (${Prisma.join(OPEN_OBLIGATION_STATUSES)})`;
      const caseFilter = filters.caseId
        ? Prisma.sql`AND o."caseId" = ${filters.caseId}`
        : Prisma.empty;
      // An obligation has no owner: when the person filters "Míos" this branch adds nothing.
      const ownerFilter = filters.ownerUserId ? Prisma.sql`AND FALSE` : Prisma.empty;
      const remaining = Prisma.sql`(o."expectedAmount" - o."settledAmount")`;
      return areaWorkRowSelect({
        rowKind: OBLIGATION_ROW_KIND,
        from: Prisma.sql`FROM "Obligation" o LEFT JOIN "OperationalCase" c ON c."id" = o."caseId"`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeFilter(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`o."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`o."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`o."number" || ' · ' || o."description"`,
          status: Prisma.sql`o."status"`,
          priority: Prisma.sql`CASE
            WHEN ${open} AND o."dueAt" IS NOT NULL AND o."dueAt" < ${filters.now}::date THEN 'high'
            ELSE 'normal' END`,
          dueAt: Prisma.sql`o."dueAt"::timestamp`,
          lastActivityAt: Prisma.sql`o."updatedAt"`,
          objectType: Prisma.sql`'obligation'::text`,
          objectId: Prisma.sql`o."id"`,
          counterpartyName: Prisma.sql`o."counterpartyName"`,
          amount: Prisma.sql`CASE WHEN ${open} THEN ${remaining} ELSE o."expectedAmount" END`,
          version: Prisma.sql`o."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${labelCase(Prisma.sql`o."status"`, OBLIGATION_STATUS_LABELS)},
            'statusTone', ${toneCase(Prisma.sql`o."status"`, OBLIGATION_STATUSES, obligationStatusTone)},
            'counterparty', o."counterpartyName",
            'periodKey', to_char(COALESCE(o."dueAt", o."createdAt"), 'YYYY-MM'),
            'number', o."number",
            'currency', o."currency",
            'obligationKind', o."kind",
            'counterpartyType', o."counterpartyType",
            'expectedAmount', o."expectedAmount"::text,
            'settledAmount', o."settledAmount"::text,
            'remaining', ${remaining}::text,
            'dueDate', to_char(o."dueAt", 'YYYY-MM-DD'),
            'expenseId', o."expenseId",
            'procurementOrderId', o."procurementOrderId",
            'payrollRunId', o."payrollRunId",
            'zohoSalesOrderId', o."zohoSalesOrderId",
            'supplierId', o."supplierId",
            'needsPaymentAuthorization', ${NEEDS_PAYMENT_AUTHORIZATION},
            'actions', (
              CASE WHEN ${open}
                THEN ${actionsArray(OBLIGATION_CANCEL_ACTIONS, 'obligationId', Prisma.sql`o."id"`)}
                ELSE '[]'::jsonb END
              ||
              CASE WHEN ${open} AND ${NEEDS_PAYMENT_AUTHORIZATION}
                THEN ${actionsArray(OBLIGATION_AUTHORIZATION_ACTIONS, 'obligationId', Prisma.sql`o."id"`)}
                ELSE '[]'::jsonb END
            )
          )`,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tareas de cierre
// ---------------------------------------------------------------------------

const CLOSE_STATUSES = Object.keys(PERIOD_CLOSE_STATUS_LABELS);

/** `checks` as an array, or an empty one (a malformed value never breaks the query). */
const CHECKS_ARRAY = Prisma.sql`CASE
  WHEN jsonb_typeof(COALESCE(p."checks", '[]'::jsonb)) = 'array' THEN COALESCE(p."checks", '[]'::jsonb)
  ELSE '[]'::jsonb END`;

const BLOCKING_FAILURES = Prisma.sql`(
  SELECT count(*) FROM jsonb_array_elements(${CHECKS_ARRAY}) AS chk
  WHERE (chk->>'ok') = 'false' AND (chk->>'blocking') = 'true'
)`;

function periodCloseBranch(): WorkRowBranch {
  return {
    rowKind: PERIOD_CLOSE_ROW_KIND,
    sql: (filters) => {
      const open = Prisma.sql`p."status" <> 'closed'`;
      // Closes belong to the whole area, never to one case nor to one person.
      const caseFilter = filters.caseId ? Prisma.sql`AND FALSE` : Prisma.empty;
      const ownerFilter = filters.ownerUserId ? Prisma.sql`AND FALSE` : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: PERIOD_CLOSE_ROW_KIND,
        from: Prisma.sql`FROM "PeriodClose" p`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scopeFilter(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`p."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          title: Prisma.sql`'Cierre ' || CASE p."kind" WHEN 'monthly' THEN 'mensual' ELSE 'diario' END || ' ' || p."periodKey"`,
          status: Prisma.sql`p."status"`,
          priority: Prisma.sql`CASE WHEN ${BLOCKING_FAILURES} > 0 THEN 'high' ELSE 'normal' END`,
          dueAt: Prisma.sql`CASE
            WHEN p."kind" = 'monthly'
              THEN (to_date(p."periodKey" || '-01', 'YYYY-MM-DD') + interval '1 month')::timestamp
            ELSE (to_date(p."periodKey", 'YYYY-MM-DD') + interval '1 day')::timestamp END`,
          lastActivityAt: Prisma.sql`p."updatedAt"`,
          objectType: Prisma.sql`'period_close'::text`,
          objectId: Prisma.sql`p."id"`,
          quantity: Prisma.sql`${BLOCKING_FAILURES}::numeric`,
          version: Prisma.sql`p."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${labelCase(Prisma.sql`p."status"`, PERIOD_CLOSE_STATUS_LABELS)},
            'statusTone', ${toneCase(Prisma.sql`p."status"`, CLOSE_STATUSES, closeStatusTone)},
            'periodKey', p."periodKey",
            'closeKind', p."kind",
            'closedAt', p."closedAt",
            'reopenReason', p."reopenReason",
            'checksTotal', jsonb_array_length(${CHECKS_ARRAY}),
            'blockingFailures', ${BLOCKING_FAILURES},
            'blockers', COALESCE((
              SELECT jsonb_agg(chk->>'label')
              FROM jsonb_array_elements(${CHECKS_ARRAY}) AS chk
              WHERE (chk->>'ok') = 'false' AND (chk->>'blocking') = 'true'
            ), '[]'::jsonb)
          )`,
        },
      });
    },
  };
}

/** The three branches Contabilidad adds to the common ones. */
export function contabilidadWorkRowBranches(): WorkRowBranch[] {
  return [expenseBranch(), obligationBranch(), periodCloseBranch()];
}

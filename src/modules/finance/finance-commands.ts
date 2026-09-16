import { z } from 'zod';
import type { CurrentUser } from '@/modules/auth/authorization';
import { registerApprovalScopePermission } from '@/modules/operations/approvals-service';
import {
  registerCommand,
  versionedAggregate,
  type CommandResult,
} from '@/modules/operations/commands';
import {
  budgetSetSchema,
  cashAccountCreateSchema,
  cashAccountUpdateSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  costCenterCreateSchema,
  costCenterUpdateSchema,
  createCashAccountInTx,
  createCategoryInTx,
  createCostCenterInTx,
  ensureFinanceSeed,
  setBudgetInTx,
  updateCashAccountInTx,
  updateCategoryInTx,
  updateCostCenterInTx,
} from './catalog-service';
import {
  dailyCloseSchema,
  monthlyCloseSchema,
  reopenPeriodInTx,
  reopenPeriodSchema,
  runDailyCloseInTx,
  runMonthlyCloseInTx,
  type CloseResultData,
} from './close-service';
import {
  applyPaymentInTx,
  applyPaymentSchema,
  cancelVoidedReceivablesInTx,
  cancelVoidedSchema,
  expectCaseSchema,
  expectReceivableForCaseInTx,
  flagOverappliedPaymentInTx,
  flagOverappliedSchema,
  flagPaymentInTx,
  flagPaymentSchema,
  holdReversedPaymentInTx,
  recordUnexpectedCollectionInTx,
  recordUnexpectedCollectionSchema,
  type ApplyPaymentResult,
} from './collections-service';
import {
  applyProposalInTx,
  applyProposalSchema,
  captureExpenseInTx,
  captureExpenseSchema,
  captureFromTemplateInTx,
  captureFromTemplateSchema,
  createExpenseTemplateInTx,
  expenseTemplateCreateSchema,
  expenseTemplateUpdateSchema,
  postExpenseInTx,
  postExpenseSchema,
  rejectExpenseInTx,
  rejectExpenseSchema,
  resolveDuplicateInTx,
  resolveDuplicateSchema,
  reverseExpenseInTx,
  reverseExpenseSchema,
  runRecurringExpenseInTx,
  runRecurringSchema,
  submitExpenseInTx,
  submitExpenseSchema,
  toExpenseCommandData,
  updateExpenseInTx,
  updateExpenseSchema,
  updateExpenseTemplateInTx,
  type ExpenseCommandData,
} from './expenses-service';
import {
  toCashAccountDTO,
  toLedgerEntryDTO,
  type CashAccountDTO,
  type LedgerEntryDTO,
} from './finance-dto';
import {
  assertAggregateTarget,
  assertFinanceEnabledFor,
  runFinanceCommand,
  type FinanceCommandOptions,
} from './finance-helpers';
import {
  postManualEntryInTx,
  postManualEntrySchema,
  reverseEntrySchema,
  reverseManualEntryInTx,
} from './ledger-service';
import { remainingOf } from './obligation-rules';
import {
  cancelObligation,
  cancelObligationSchema,
  createObligationWithEntry,
  manualObligationSchema,
  requestPaymentAuthorizationInTx,
  requestPaymentAuthorizationSchema,
  rescheduleObligationInTx,
  rescheduleObligationSchema,
  reverseSettlementInTx,
  reverseSettlementSchema,
  settleObligationInTx,
  settleObligationSchema,
  toSettleData,
  writeOffObligationInTx,
  writeOffObligationSchema,
  type PaymentAuthorizationData,
  type RescheduleObligationData,
  type SettleObligationData,
} from './obligations-service';
import {
  cancelPayrollRunInTx,
  closePayrollRunInTx,
  createEmployeeInTx,
  createPayrollObligationsInTx,
  createPayrollRunInTx,
  employeeAdvanceSchema,
  employeeCreateSchema,
  employeeUpdateSchema,
  grantEmployeeAdvanceInTx,
  payPayrollLineInTx,
  payrollCancelSchema,
  payrollCreateObligationsSchema,
  payrollCreateSchema,
  payrollPayLineSchema,
  payrollRunOnlySchema,
  payrollUpdateSchema,
  submitPayrollRunInTx,
  updateEmployeeInTx,
  updatePayrollRunInTx,
} from './payroll-service';
import { FINANCE_COMMANDS, FINANCE_OBJECT_TYPES } from './types';

/**
 * Registration of the finance commands (plan 6.4) and the uniform service
 * signatures `fn(actor, input, {commandId, expectedVersion})` used by routes,
 * server actions and AI tools.
 *
 * | commands | aggregate | permission |
 * |---|---|---|
 * | catalog seed, cash account / category / cost center create, budget set | none | finance.manage_catalog |
 * | cash account update | cash_account | finance.manage_catalog |
 * | ledger post_manual / reverse | none | finance.post |
 * | obligation create / request_authorization | none | finance.manage_obligations |
 * | obligation settle / cancel / write_off / reschedule | obligation | finance.manage_obligations |
 * | obligation reverse_settlement | obligation | finance.post |
 * | expense capture / template create / capture_from_template | none | finance.capture_expense |
 * | expense update / resolve_duplicate / submit / reject | expense | finance.capture_expense (owner rules in the handler) |
 * | expense post / reverse | expense | finance.post |
 * | employee create / update / advance, payroll create | none | finance.payroll |
 * | payroll update / submit / create_obligations / pay_line / close / cancel | payroll_run | finance.payroll |
 * | collections match_payment / record_unexpected | none | finance.manage_obligations |
 * | close daily / monthly / reopen | none | finance.close |
 * | expense apply_proposal / run_recurring, collections expect_case / apply_payment / flag_payment / flag_overapplied / cancel_voided | expense / none | system actor only |
 *
 * Every user command checks the `finance` flag. The approver permission of
 * the `expense`, `payment` and `payroll` scopes is `finance.approve`.
 *
 * Import this file from `operations/register-commands.ts` (one line) so every
 * entry point that executes commands by type has the catalog.
 */

const SYSTEM_ONLY = ['system'] as const;
const HUMAN_ONLY = ['user'] as const;
const PEOPLE_AND_AGENTS = ['user', 'ai'] as const;

const expenseAggregate = versionedAggregate(FINANCE_OBJECT_TYPES.expense, 'expense');
const obligationAggregate = versionedAggregate(FINANCE_OBJECT_TYPES.obligation, 'obligation');
const payrollAggregate = versionedAggregate(FINANCE_OBJECT_TYPES.payrollRun, 'payrollRun');
const cashAccountAggregate = versionedAggregate(FINANCE_OBJECT_TYPES.cashAccount, 'cashAccount');

type GlobalWithFinanceScopes = typeof globalThis & { __unikFinanceApprovalScopes?: boolean };

export function registerFinanceApprovalScopes(): void {
  const scope = globalThis as GlobalWithFinanceScopes;
  if (scope.__unikFinanceApprovalScopes) return;
  registerApprovalScopePermission('expense', 'finance.approve');
  registerApprovalScopePermission('payment', 'finance.approve');
  registerApprovalScopePermission('payroll', 'finance.approve');
  scope.__unikFinanceApprovalScopes = true;
}

registerFinanceApprovalScopes();

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const catalogSeedSchema = z.object({}).strict();

registerCommand(FINANCE_COMMANDS.catalogSeed, {
  schema: catalogSeedSchema,
  permission: 'finance.manage_catalog',
  aggregate: 'none',
  async handler(tx, _cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await ensureFinanceSeed(tx) };
  },
});

registerCommand(FINANCE_COMMANDS.cashAccountCreate, {
  schema: cashAccountCreateSchema,
  permission: 'finance.manage_catalog',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const row = await createCashAccountInTx(tx, cmd.payload, ctx);
    return { aggregateVersion: row.version, data: toCashAccountDTO(row) };
  },
});

registerCommand(FINANCE_COMMANDS.cashAccountUpdate, {
  schema: cashAccountUpdateSchema,
  permission: 'finance.manage_catalog',
  aggregate: cashAccountAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.cashAccountId, 'La cuenta');
    return { data: toCashAccountDTO(await updateCashAccountInTx(tx, cmd.payload, ctx)) };
  },
});

registerCommand(FINANCE_COMMANDS.categoryCreate, {
  schema: categoryCreateSchema,
  permission: 'finance.manage_catalog',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const row = await createCategoryInTx(tx, cmd.payload, ctx);
    return { data: { categoryId: row.id, key: row.key } };
  },
});

registerCommand(FINANCE_COMMANDS.categoryUpdate, {
  schema: categoryUpdateSchema,
  permission: 'finance.manage_catalog',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const row = await updateCategoryInTx(tx, cmd.payload, ctx);
    return { data: { categoryId: row.id, status: row.status } };
  },
});

registerCommand(FINANCE_COMMANDS.costCenterCreate, {
  schema: costCenterCreateSchema,
  permission: 'finance.manage_catalog',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const row = await createCostCenterInTx(tx, cmd.payload, ctx);
    return { data: { costCenterId: row.id, key: row.key } };
  },
});

registerCommand(FINANCE_COMMANDS.costCenterUpdate, {
  schema: costCenterUpdateSchema,
  permission: 'finance.manage_catalog',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const row = await updateCostCenterInTx(tx, cmd.payload, ctx);
    return { data: { costCenterId: row.id, status: row.status } };
  },
});

registerCommand(FINANCE_COMMANDS.budgetSet, {
  schema: budgetSetSchema,
  permission: 'finance.manage_catalog',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await setBudgetInTx(tx, cmd.payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

registerCommand(FINANCE_COMMANDS.ledgerPostManual, {
  schema: postManualEntrySchema,
  permission: 'finance.post',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: toLedgerEntryDTO(await postManualEntryInTx(tx, cmd.payload, ctx)) };
  },
});

registerCommand(FINANCE_COMMANDS.ledgerReverse, {
  schema: reverseEntrySchema,
  permission: 'finance.post',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const { original, reversal } = await reverseManualEntryInTx(tx, cmd.payload, ctx);
    return { data: { entryId: original.id, reversal: toLedgerEntryDTO(reversal) } };
  },
});

// ---------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------

registerCommand(FINANCE_COMMANDS.obligationCreate, {
  schema: manualObligationSchema,
  permission: 'finance.manage_obligations',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const { obligation, ledgerEntry } = await createObligationWithEntry(tx, cmd.payload, ctx);
    return {
      aggregateVersion: obligation.version,
      data: {
        obligationId: obligation.id,
        number: obligation.number,
        ledgerEntryId: ledgerEntry?.id ?? null,
      },
    };
  },
});

registerCommand<z.output<typeof settleObligationSchema>, SettleObligationData>(
  FINANCE_COMMANDS.obligationSettle,
  {
    schema: settleObligationSchema,
    permission: 'finance.manage_obligations',
    aggregate: obligationAggregate,
    actorTypes: HUMAN_ONLY,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      assertAggregateTarget(cmd, cmd.payload.obligationId, 'La obligación');
      const result = await settleObligationInTx(
        tx,
        {
          obligationId: cmd.payload.obligationId,
          amount: cmd.payload.amount,
          cashAccountId: cmd.payload.cashAccountId,
          dateKey: cmd.payload.date ?? null,
          evidenceObjectIds: cmd.payload.evidenceObjectIds,
          memo: cmd.payload.memo ?? null,
        },
        ctx,
        { bumpVersion: false }
      );
      return { data: toSettleData(result) };
    },
  }
);

registerCommand(FINANCE_COMMANDS.obligationCancel, {
  schema: cancelObligationSchema,
  permission: 'finance.manage_obligations',
  aggregate: obligationAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.obligationId, 'La obligación');
    const row = await cancelObligation(tx, cmd.payload.obligationId, cmd.payload.reason, ctx, {
      bumpVersion: false,
    });
    return { data: { obligationId: row.id, number: row.number, status: row.status } };
  },
});

registerCommand<z.output<typeof rescheduleObligationSchema>, RescheduleObligationData>(
  FINANCE_COMMANDS.obligationReschedule,
  {
    schema: rescheduleObligationSchema,
    permission: 'finance.manage_obligations',
    aggregate: obligationAggregate,
    actorTypes: HUMAN_ONLY,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      assertAggregateTarget(cmd, cmd.payload.obligationId, 'La obligación');
      const { data } = await rescheduleObligationInTx(tx, cmd.payload, ctx, { bumpVersion: false });
      return { data };
    },
  }
);

registerCommand(FINANCE_COMMANDS.obligationWriteOff, {
  schema: writeOffObligationSchema,
  permission: 'finance.manage_obligations',
  aggregate: obligationAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.obligationId, 'La obligación');
    const { obligation, ledgerEntry } = await writeOffObligationInTx(tx, cmd.payload, ctx, {
      bumpVersion: false,
    });
    return {
      data: {
        obligationId: obligation.id,
        status: obligation.status,
        ledgerEntryId: ledgerEntry.id,
      },
    };
  },
});

registerCommand(FINANCE_COMMANDS.settlementReverse, {
  schema: reverseSettlementSchema,
  permission: 'finance.post',
  aggregate: obligationAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const result = await reverseSettlementInTx(tx, cmd.payload, ctx, {
      bumpVersion: false,
      expectedObligationId: cmd.aggregate.id,
    });
    // The freed Zoho payment waits for a person instead of going back to the reconciler.
    const hold = result.settlement.zohoPaymentId
      ? await holdReversedPaymentInTx(
          tx,
          {
            zohoPaymentId: result.settlement.zohoPaymentId,
            obligationNumber: result.obligation.number,
            reason: cmd.payload.reason,
          },
          ctx
        )
      : null;
    return {
      data: {
        obligationId: result.obligation.id,
        status: result.obligation.status,
        remaining: remainingOf(result.obligation).toFixed(2),
        reversalEntryId: result.reversalEntryId,
        reversalNumber: result.reversalNumber,
        paymentWorkItemId: hold?.workItemId ?? null,
      },
    };
  },
});

registerCommand<z.output<typeof requestPaymentAuthorizationSchema>, PaymentAuthorizationData>(
  FINANCE_COMMANDS.paymentAuthorizationRequest,
  {
    schema: requestPaymentAuthorizationSchema,
    permission: 'finance.manage_obligations',
    aggregate: 'none',
    actorTypes: PEOPLE_AND_AGENTS,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      return { data: await requestPaymentAuthorizationInTx(tx, cmd.payload, ctx) };
    },
  }
);

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

function proposalQueued(expense: { aiProposal: unknown }): boolean {
  const record = expense.aiProposal as Record<string, unknown> | null;
  return record?.status === 'pending';
}

registerCommand<z.output<typeof captureExpenseSchema>, ExpenseCommandData>(
  FINANCE_COMMANDS.expenseCapture,
  {
    schema: captureExpenseSchema,
    permission: 'finance.capture_expense',
    aggregate: 'none',
    actorTypes: PEOPLE_AND_AGENTS,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      const { expense, matches } = await captureExpenseInTx(tx, cmd.payload, ctx);
      return {
        aggregateVersion: expense.version,
        data: toExpenseCommandData(expense, {
          proposalQueued: proposalQueued(expense),
          matches: matches
            .slice(0, 5)
            .map(({ expenseId, number, kind, reason }) => ({ expenseId, number, kind, reason })),
        }),
      };
    },
  }
);

registerCommand<z.output<typeof updateExpenseSchema>, ExpenseCommandData>(
  FINANCE_COMMANDS.expenseUpdate,
  {
    schema: updateExpenseSchema,
    permission: 'finance.capture_expense',
    aggregate: expenseAggregate,
    actorTypes: PEOPLE_AND_AGENTS,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      assertAggregateTarget(cmd, cmd.payload.expenseId, 'El gasto');
      const { expense, matches } = await updateExpenseInTx(tx, cmd.payload, ctx);
      return {
        data: toExpenseCommandData(expense, {
          matches: matches
            .slice(0, 5)
            .map(({ expenseId, number, kind, reason }) => ({ expenseId, number, kind, reason })),
        }),
      };
    },
  }
);

registerCommand(FINANCE_COMMANDS.expenseApplyProposal, {
  schema: applyProposalSchema,
  aggregate: expenseAggregate,
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    assertAggregateTarget(cmd, cmd.payload.expenseId, 'El gasto');
    const result = await applyProposalInTx(tx, cmd.payload, ctx);
    return {
      data: {
        applied: result.applied,
        fields: result.fields,
        duplicateStatus: result.expense.duplicateStatus,
      },
    };
  },
});

registerCommand(FINANCE_COMMANDS.expenseResolveDuplicate, {
  schema: resolveDuplicateSchema,
  permission: 'finance.capture_expense',
  aggregate: expenseAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.expenseId, 'El gasto');
    return { data: toExpenseCommandData(await resolveDuplicateInTx(tx, cmd.payload, ctx)) };
  },
});

registerCommand<z.output<typeof submitExpenseSchema>, ExpenseCommandData>(
  FINANCE_COMMANDS.expenseSubmit,
  {
    schema: submitExpenseSchema,
    permission: 'finance.capture_expense',
    aggregate: expenseAggregate,
    actorTypes: HUMAN_ONLY,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      assertAggregateTarget(cmd, cmd.payload.expenseId, 'El gasto');
      return { data: await submitExpenseInTx(tx, cmd.payload, ctx) };
    },
  }
);

registerCommand<z.output<typeof postExpenseSchema>, ExpenseCommandData>(
  FINANCE_COMMANDS.expensePost,
  {
    schema: postExpenseSchema,
    permission: 'finance.post',
    aggregate: expenseAggregate,
    actorTypes: HUMAN_ONLY,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      assertAggregateTarget(cmd, cmd.payload.expenseId, 'El gasto');
      return { data: await postExpenseInTx(tx, cmd.payload, ctx) };
    },
  }
);

registerCommand(FINANCE_COMMANDS.expenseReject, {
  schema: rejectExpenseSchema,
  permission: 'finance.capture_expense',
  aggregate: expenseAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.expenseId, 'El gasto');
    return { data: toExpenseCommandData(await rejectExpenseInTx(tx, cmd.payload, ctx)) };
  },
});

registerCommand(FINANCE_COMMANDS.expenseReverse, {
  schema: reverseExpenseSchema,
  permission: 'finance.post',
  aggregate: expenseAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.expenseId, 'El gasto');
    const { expense, reversalEntryId } = await reverseExpenseInTx(tx, cmd.payload, ctx);
    return { data: toExpenseCommandData(expense, { ledgerEntryId: reversalEntryId }) };
  },
});

registerCommand(FINANCE_COMMANDS.expenseTemplateCreate, {
  schema: expenseTemplateCreateSchema,
  permission: 'finance.capture_expense',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await createExpenseTemplateInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.expenseTemplateUpdate, {
  schema: expenseTemplateUpdateSchema,
  permission: 'finance.capture_expense',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await updateExpenseTemplateInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand<z.output<typeof captureFromTemplateSchema>, ExpenseCommandData>(
  FINANCE_COMMANDS.expenseCaptureFromTemplate,
  {
    schema: captureFromTemplateSchema,
    permission: 'finance.capture_expense',
    aggregate: 'none',
    actorTypes: PEOPLE_AND_AGENTS,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      const { expense, matches } = await captureFromTemplateInTx(tx, cmd.payload, ctx);
      return {
        aggregateVersion: expense.version,
        data: toExpenseCommandData(expense, {
          matches: matches
            .slice(0, 5)
            .map(({ expenseId, number, kind, reason }) => ({ expenseId, number, kind, reason })),
        }),
      };
    },
  }
);

registerCommand(FINANCE_COMMANDS.expenseRunRecurring, {
  schema: runRecurringSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    return { data: await runRecurringExpenseInTx(tx, cmd.payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

registerCommand(FINANCE_COMMANDS.employeeCreate, {
  schema: employeeCreateSchema,
  permission: 'finance.payroll',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await createEmployeeInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.employeeUpdate, {
  schema: employeeUpdateSchema,
  permission: 'finance.payroll',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await updateEmployeeInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.employeeAdvance, {
  schema: employeeAdvanceSchema,
  permission: 'finance.payroll',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await grantEmployeeAdvanceInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.payrollCreate, {
  schema: payrollCreateSchema,
  permission: 'finance.payroll',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    const data = await createPayrollRunInTx(tx, cmd.payload, ctx);
    return { aggregateVersion: data.version, data };
  },
});

registerCommand(FINANCE_COMMANDS.payrollUpdate, {
  schema: payrollUpdateSchema,
  permission: 'finance.payroll',
  aggregate: payrollAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.payrollRunId, 'La nómina');
    return { data: await updatePayrollRunInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.payrollSubmit, {
  schema: payrollRunOnlySchema,
  permission: 'finance.payroll',
  aggregate: payrollAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.payrollRunId, 'La nómina');
    return { data: await submitPayrollRunInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.payrollCreateObligations, {
  schema: payrollCreateObligationsSchema,
  permission: 'finance.payroll',
  aggregate: payrollAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.payrollRunId, 'La nómina');
    return { data: await createPayrollObligationsInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.payrollPayLine, {
  schema: payrollPayLineSchema,
  permission: 'finance.payroll',
  aggregate: payrollAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.payrollRunId, 'La nómina');
    return { data: await payPayrollLineInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.payrollClose, {
  schema: payrollRunOnlySchema,
  permission: 'finance.payroll',
  aggregate: payrollAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.payrollRunId, 'La nómina');
    return { data: await closePayrollRunInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.payrollCancel, {
  schema: payrollCancelSchema,
  permission: 'finance.payroll',
  aggregate: payrollAggregate,
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    assertAggregateTarget(cmd, cmd.payload.payrollRunId, 'La nómina');
    return { data: await cancelPayrollRunInTx(tx, cmd.payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

registerCommand(FINANCE_COMMANDS.collectionExpectCase, {
  schema: expectCaseSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    return { data: await expectReceivableForCaseInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand<z.output<typeof applyPaymentSchema>, ApplyPaymentResult>(
  FINANCE_COMMANDS.collectionApplyPayment,
  {
    schema: applyPaymentSchema,
    aggregate: 'none',
    actorTypes: SYSTEM_ONLY,
    audit: 'never',
    async handler(tx, cmd, ctx) {
      return { data: await applyPaymentInTx(tx, cmd.payload, ctx, { manual: false }) };
    },
  }
);

registerCommand<z.output<typeof applyPaymentSchema>, ApplyPaymentResult>(
  FINANCE_COMMANDS.collectionMatchPayment,
  {
    schema: applyPaymentSchema,
    permission: 'finance.manage_obligations',
    aggregate: 'none',
    actorTypes: HUMAN_ONLY,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      return { data: await applyPaymentInTx(tx, cmd.payload, ctx, { manual: true }) };
    },
  }
);

registerCommand(FINANCE_COMMANDS.collectionFlagPayment, {
  schema: flagPaymentSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    return { data: await flagPaymentInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.collectionRecordUnexpected, {
  schema: recordUnexpectedCollectionSchema,
  permission: 'finance.manage_obligations',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await recordUnexpectedCollectionInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.collectionFlagOverapplied, {
  schema: flagOverappliedSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    return { data: await flagOverappliedPaymentInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand(FINANCE_COMMANDS.collectionCancelVoided, {
  schema: cancelVoidedSchema,
  aggregate: 'none',
  actorTypes: SYSTEM_ONLY,
  audit: 'never',
  async handler(tx, cmd, ctx) {
    return { data: await cancelVoidedReceivablesInTx(tx, cmd.payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Closes
// ---------------------------------------------------------------------------

registerCommand<z.output<typeof dailyCloseSchema>, CloseResultData>(FINANCE_COMMANDS.closeDaily, {
  schema: dailyCloseSchema,
  permission: 'finance.close',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await runDailyCloseInTx(tx, cmd.payload, ctx) };
  },
});

registerCommand<z.output<typeof monthlyCloseSchema>, CloseResultData>(
  FINANCE_COMMANDS.closeMonthly,
  {
    schema: monthlyCloseSchema,
    permission: 'finance.close',
    aggregate: 'none',
    actorTypes: HUMAN_ONLY,
    async handler(tx, cmd, ctx) {
      await assertFinanceEnabledFor(ctx);
      return { data: await runMonthlyCloseInTx(tx, cmd.payload, ctx) };
    },
  }
);

registerCommand(FINANCE_COMMANDS.closeReopen, {
  schema: reopenPeriodSchema,
  permission: 'finance.close',
  aggregate: 'none',
  actorTypes: HUMAN_ONLY,
  audit: 'always',
  async handler(tx, cmd, ctx) {
    await assertFinanceEnabledFor(ctx);
    return { data: await reopenPeriodInTx(tx, cmd.payload, ctx) };
  },
});

// ---------------------------------------------------------------------------
// Uniform service signatures
// ---------------------------------------------------------------------------

type Options = FinanceCommandOptions;
const none = (type: string, id = 'new') => ({ type, id });

function run<D>(
  actor: CurrentUser,
  type: string,
  aggregate: { type: string; id: string },
  payload: unknown,
  opts?: Options
) {
  return runFinanceCommand<D>(actor, { type, aggregate, payload }, opts);
}

const idOf = (value: unknown) => String(value ?? '');

export const seedFinanceCatalog = (actor: CurrentUser, opts?: Options) =>
  run<{ created: number }>(
    actor,
    FINANCE_COMMANDS.catalogSeed,
    none('finance_catalog', 'seed'),
    {},
    opts
  );
export const createCashAccount = (
  actor: CurrentUser,
  input: z.input<typeof cashAccountCreateSchema>,
  opts?: Options
) =>
  run<CashAccountDTO>(
    actor,
    FINANCE_COMMANDS.cashAccountCreate,
    none('cash_account', `key:${idOf(input.key)}`),
    input,
    opts
  );
export const updateCashAccount = (
  actor: CurrentUser,
  input: z.input<typeof cashAccountUpdateSchema>,
  opts?: Options
) =>
  run<CashAccountDTO>(
    actor,
    FINANCE_COMMANDS.cashAccountUpdate,
    { type: FINANCE_OBJECT_TYPES.cashAccount, id: idOf(input.cashAccountId) },
    input,
    opts
  );
export const createCategory = (
  actor: CurrentUser,
  input: z.input<typeof categoryCreateSchema>,
  opts?: Options
) =>
  run<{ categoryId: string; key: string }>(
    actor,
    FINANCE_COMMANDS.categoryCreate,
    none('finance_category', `key:${idOf(input.key)}`),
    input,
    opts
  );
export const updateCategory = (
  actor: CurrentUser,
  input: z.input<typeof categoryUpdateSchema>,
  opts?: Options
) =>
  run<{ categoryId: string; status: string }>(
    actor,
    FINANCE_COMMANDS.categoryUpdate,
    none('finance_category', idOf(input.categoryId)),
    input,
    opts
  );
export const createCostCenter = (
  actor: CurrentUser,
  input: z.input<typeof costCenterCreateSchema>,
  opts?: Options
) =>
  run<{ costCenterId: string; key: string }>(
    actor,
    FINANCE_COMMANDS.costCenterCreate,
    none('cost_center', `key:${idOf(input.key)}`),
    input,
    opts
  );
export const updateCostCenter = (
  actor: CurrentUser,
  input: z.input<typeof costCenterUpdateSchema>,
  opts?: Options
) =>
  run<{ costCenterId: string; status: string }>(
    actor,
    FINANCE_COMMANDS.costCenterUpdate,
    none('cost_center', idOf(input.costCenterId)),
    input,
    opts
  );
export const setBudget = (
  actor: CurrentUser,
  input: z.input<typeof budgetSetSchema>,
  opts?: Options
) =>
  run<{ id: string; amount: string }>(
    actor,
    FINANCE_COMMANDS.budgetSet,
    none(
      'budget',
      `${idOf(input.periodKey)}:${idOf(input.costCenterId)}:${idOf(input.categoryId)}`
    ),
    input,
    opts
  );

export const postManualEntry = (
  actor: CurrentUser,
  input: z.input<typeof postManualEntrySchema>,
  opts?: Options
) =>
  run<LedgerEntryDTO>(actor, FINANCE_COMMANDS.ledgerPostManual, none('ledger_entry'), input, opts);
export const reverseEntry = (
  actor: CurrentUser,
  input: z.input<typeof reverseEntrySchema>,
  opts?: Options
) =>
  run<{ entryId: string; reversal: LedgerEntryDTO }>(
    actor,
    FINANCE_COMMANDS.ledgerReverse,
    none('ledger_entry', idOf(input.entryId)),
    input,
    opts
  );

export const createManualObligation = (
  actor: CurrentUser,
  input: z.input<typeof manualObligationSchema>,
  opts?: Options
) =>
  run<{ obligationId: string; number: string; ledgerEntryId: string | null }>(
    actor,
    FINANCE_COMMANDS.obligationCreate,
    none('obligation'),
    input,
    opts
  );
export const cancelObligationCommand = (
  actor: CurrentUser,
  input: z.input<typeof cancelObligationSchema>,
  opts?: Options
) =>
  run<{ obligationId: string; number: string; status: string }>(
    actor,
    FINANCE_COMMANDS.obligationCancel,
    { type: FINANCE_OBJECT_TYPES.obligation, id: idOf(input.obligationId) },
    input,
    opts
  );
export const writeOffObligation = (
  actor: CurrentUser,
  input: z.input<typeof writeOffObligationSchema>,
  opts?: Options
) =>
  run<{ obligationId: string; status: string; ledgerEntryId: string }>(
    actor,
    FINANCE_COMMANDS.obligationWriteOff,
    { type: FINANCE_OBJECT_TYPES.obligation, id: idOf(input.obligationId) },
    input,
    opts
  );
/** Renegocia la fecha de una obligación abierta: no toca el asiento ni el importe. */
export const rescheduleObligation = (
  actor: CurrentUser,
  input: z.input<typeof rescheduleObligationSchema>,
  opts?: Options
) =>
  run<RescheduleObligationData>(
    actor,
    FINANCE_COMMANDS.obligationReschedule,
    { type: FINANCE_OBJECT_TYPES.obligation, id: idOf(input.obligationId) },
    input,
    opts
  );
export const reverseSettlement = (
  actor: CurrentUser,
  input: z.input<typeof reverseSettlementSchema> & { obligationId: string },
  opts?: Options
) =>
  run<{
    obligationId: string;
    status: string;
    remaining: string;
    reversalEntryId: string;
    reversalNumber: string;
    paymentWorkItemId: string | null;
  }>(
    actor,
    FINANCE_COMMANDS.settlementReverse,
    { type: FINANCE_OBJECT_TYPES.obligation, id: idOf(input.obligationId) },
    { settlementId: input.settlementId, reason: input.reason, date: input.date },
    opts
  );
export const requestPaymentAuthorization = (
  actor: CurrentUser,
  input: z.input<typeof requestPaymentAuthorizationSchema>,
  opts?: Options
) =>
  run<PaymentAuthorizationData>(
    actor,
    FINANCE_COMMANDS.paymentAuthorizationRequest,
    none('obligation', idOf(input.obligationId)),
    input,
    opts
  );

export const captureExpense = (
  actor: CurrentUser,
  input: z.input<typeof captureExpenseSchema>,
  opts?: Options
) => run<ExpenseCommandData>(actor, FINANCE_COMMANDS.expenseCapture, none('expense'), input, opts);
export const updateExpense = (
  actor: CurrentUser,
  input: z.input<typeof updateExpenseSchema>,
  opts?: Options
) =>
  run<ExpenseCommandData>(
    actor,
    FINANCE_COMMANDS.expenseUpdate,
    { type: FINANCE_OBJECT_TYPES.expense, id: idOf(input.expenseId) },
    input,
    opts
  );
export const resolveExpenseDuplicate = (
  actor: CurrentUser,
  input: z.input<typeof resolveDuplicateSchema>,
  opts?: Options
) =>
  run<ExpenseCommandData>(
    actor,
    FINANCE_COMMANDS.expenseResolveDuplicate,
    { type: FINANCE_OBJECT_TYPES.expense, id: idOf(input.expenseId) },
    input,
    opts
  );
export const submitExpense = (
  actor: CurrentUser,
  input: z.input<typeof submitExpenseSchema>,
  opts?: Options
) =>
  run<ExpenseCommandData>(
    actor,
    FINANCE_COMMANDS.expenseSubmit,
    { type: FINANCE_OBJECT_TYPES.expense, id: idOf(input.expenseId) },
    input,
    opts
  );
export const postExpense = (
  actor: CurrentUser,
  input: z.input<typeof postExpenseSchema>,
  opts?: Options
) =>
  run<ExpenseCommandData>(
    actor,
    FINANCE_COMMANDS.expensePost,
    { type: FINANCE_OBJECT_TYPES.expense, id: idOf(input.expenseId) },
    input,
    opts
  );
export const rejectExpense = (
  actor: CurrentUser,
  input: z.input<typeof rejectExpenseSchema>,
  opts?: Options
) =>
  run<ExpenseCommandData>(
    actor,
    FINANCE_COMMANDS.expenseReject,
    { type: FINANCE_OBJECT_TYPES.expense, id: idOf(input.expenseId) },
    input,
    opts
  );
export const reverseExpense = (
  actor: CurrentUser,
  input: z.input<typeof reverseExpenseSchema>,
  opts?: Options
) =>
  run<ExpenseCommandData>(
    actor,
    FINANCE_COMMANDS.expenseReverse,
    { type: FINANCE_OBJECT_TYPES.expense, id: idOf(input.expenseId) },
    input,
    opts
  );
export const createExpenseTemplate = (
  actor: CurrentUser,
  input: z.input<typeof expenseTemplateCreateSchema>,
  opts?: Options
) =>
  run<{ templateId: string; nextRunAt: string | null }>(
    actor,
    FINANCE_COMMANDS.expenseTemplateCreate,
    none('expense_template'),
    input,
    opts
  );
export const updateExpenseTemplate = (
  actor: CurrentUser,
  input: z.input<typeof expenseTemplateUpdateSchema>,
  opts?: Options
) =>
  run<{ templateId: string; nextRunAt: string | null; active: boolean }>(
    actor,
    FINANCE_COMMANDS.expenseTemplateUpdate,
    none('expense_template', idOf(input.templateId)),
    input,
    opts
  );
export const captureExpenseFromTemplate = (
  actor: CurrentUser,
  input: z.input<typeof captureFromTemplateSchema>,
  opts?: Options
) =>
  run<ExpenseCommandData>(
    actor,
    FINANCE_COMMANDS.expenseCaptureFromTemplate,
    none('expense_template', idOf(input.templateId)),
    input,
    opts
  );

export const createEmployee = (
  actor: CurrentUser,
  input: z.input<typeof employeeCreateSchema>,
  opts?: Options
) =>
  run<{ employeeId: string; number: string }>(
    actor,
    FINANCE_COMMANDS.employeeCreate,
    none('employee'),
    input,
    opts
  );
export const updateEmployee = (
  actor: CurrentUser,
  input: z.input<typeof employeeUpdateSchema>,
  opts?: Options
) =>
  run<{ employeeId: string; active: boolean }>(
    actor,
    FINANCE_COMMANDS.employeeUpdate,
    none('employee', idOf(input.employeeId)),
    input,
    opts
  );
export const grantEmployeeAdvance = (
  actor: CurrentUser,
  input: z.input<typeof employeeAdvanceSchema>,
  opts?: Options
) =>
  run<{ obligationId: string; number: string; ledgerEntryId: string | null }>(
    actor,
    FINANCE_COMMANDS.employeeAdvance,
    none('employee', idOf(input.employeeId)),
    input,
    opts
  );
export const createPayrollRun = (
  actor: CurrentUser,
  input: z.input<typeof payrollCreateSchema>,
  opts?: Options
) =>
  run<{ payrollRunId: string; number: string; totalNet: string; version: number }>(
    actor,
    FINANCE_COMMANDS.payrollCreate,
    none('payroll_run'),
    input,
    opts
  );
export const updatePayrollRun = (
  actor: CurrentUser,
  input: z.input<typeof payrollUpdateSchema>,
  opts?: Options
) =>
  run<{ payrollRunId: string; totalNet: string }>(
    actor,
    FINANCE_COMMANDS.payrollUpdate,
    { type: FINANCE_OBJECT_TYPES.payrollRun, id: idOf(input.payrollRunId) },
    input,
    opts
  );
export const submitPayrollRun = (
  actor: CurrentUser,
  input: z.input<typeof payrollRunOnlySchema>,
  opts?: Options
) =>
  run<{
    payrollRunId: string;
    status: string;
    approvalRequestId: string;
    requiredApprovals: number;
  }>(
    actor,
    FINANCE_COMMANDS.payrollSubmit,
    { type: FINANCE_OBJECT_TYPES.payrollRun, id: idOf(input.payrollRunId) },
    input,
    opts
  );
export const createPayrollObligations = (
  actor: CurrentUser,
  input: z.input<typeof payrollCreateObligationsSchema>,
  opts?: Options
) =>
  run<{ payrollRunId: string; status: string; ledgerEntryId: string; obligationIds: string[] }>(
    actor,
    FINANCE_COMMANDS.payrollCreateObligations,
    { type: FINANCE_OBJECT_TYPES.payrollRun, id: idOf(input.payrollRunId) },
    input,
    opts
  );
export const payPayrollLine = (
  actor: CurrentUser,
  input: z.input<typeof payrollPayLineSchema>,
  opts?: Options
) =>
  run<{
    payrollRunId: string;
    runStatus: string;
    obligationId: string;
    settlementId: string;
    ledgerEntryId: string;
  }>(
    actor,
    FINANCE_COMMANDS.payrollPayLine,
    { type: FINANCE_OBJECT_TYPES.payrollRun, id: idOf(input.payrollRunId) },
    input,
    opts
  );
export const closePayrollRun = (
  actor: CurrentUser,
  input: z.input<typeof payrollRunOnlySchema>,
  opts?: Options
) =>
  run<{ payrollRunId: string; status: string }>(
    actor,
    FINANCE_COMMANDS.payrollClose,
    { type: FINANCE_OBJECT_TYPES.payrollRun, id: idOf(input.payrollRunId) },
    input,
    opts
  );
export const cancelPayrollRun = (
  actor: CurrentUser,
  input: z.input<typeof payrollCancelSchema>,
  opts?: Options
) =>
  run<{ payrollRunId: string; status: string; reversalEntryId: string | null }>(
    actor,
    FINANCE_COMMANDS.payrollCancel,
    { type: FINANCE_OBJECT_TYPES.payrollRun, id: idOf(input.payrollRunId) },
    input,
    opts
  );

export const matchPaymentToObligation = (
  actor: CurrentUser,
  input: z.input<typeof applyPaymentSchema>,
  opts?: Options
) =>
  run<ApplyPaymentResult>(
    actor,
    FINANCE_COMMANDS.collectionMatchPayment,
    { type: FINANCE_OBJECT_TYPES.customerPayment, id: idOf(input.zohoPaymentId) },
    input,
    opts
  );
export const recordUnexpectedCollection = (
  actor: CurrentUser,
  input: z.input<typeof recordUnexpectedCollectionSchema>,
  opts?: Options
) =>
  run<ApplyPaymentResult & { obligationId: string }>(
    actor,
    FINANCE_COMMANDS.collectionRecordUnexpected,
    { type: FINANCE_OBJECT_TYPES.customerPayment, id: idOf(input.zohoPaymentId) },
    input,
    opts
  );

export const runDailyClose = (
  actor: CurrentUser,
  input: z.input<typeof dailyCloseSchema>,
  opts?: Options
) =>
  run<CloseResultData>(
    actor,
    FINANCE_COMMANDS.closeDaily,
    none('period_close', `daily:${idOf(input.date)}`),
    input,
    opts
  );
export const runMonthlyClose = (
  actor: CurrentUser,
  input: z.input<typeof monthlyCloseSchema>,
  opts?: Options
) =>
  run<CloseResultData>(
    actor,
    FINANCE_COMMANDS.closeMonthly,
    none('period_close', `monthly:${idOf(input.periodKey)}`),
    input,
    opts
  );
export const reopenPeriod = (
  actor: CurrentUser,
  input: z.input<typeof reopenPeriodSchema>,
  opts?: Options
) =>
  run<{ closeId: string; kind: string; periodKey: string; status: string }>(
    actor,
    FINANCE_COMMANDS.closeReopen,
    none('period_close', `${idOf(input.kind)}:${idOf(input.periodKey)}`),
    input,
    opts
  );

export type { CommandResult };

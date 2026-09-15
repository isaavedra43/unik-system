-- CreateTable
CREATE TABLE "CashAccount" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "openingBalance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currentBalance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceCategory" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "isDirect" BOOLEAN NOT NULL DEFAULT false,
    "parentId" TEXT,
    "defaultCostCenterId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCenter" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "areaKey" TEXT,
    "parentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "periodKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "reversesEntryId" TEXT,
    "reversedByEntryId" TEXT,
    "postedByUserId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidenceObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "accountType" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "costCenterId" TEXT,
    "caseId" TEXT,
    "procurementOrderId" TEXT,
    "projectRef" TEXT,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Obligation" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "counterpartyType" TEXT NOT NULL,
    "counterpartyName" TEXT,
    "supplierId" TEXT,
    "zohoContactId" TEXT,
    "employeeId" TEXT,
    "caseId" TEXT,
    "procurementOrderId" TEXT,
    "payrollRunId" TEXT,
    "expenseId" TEXT,
    "zohoSalesOrderId" TEXT,
    "zohoInvoiceId" TEXT,
    "description" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "expectedAmount" DECIMAL(18,4) NOT NULL,
    "settledAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3),
    "expectedCashAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'expected',
    "categoryId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "ledgerEntryId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Obligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObligationSettlement" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cashAccountId" TEXT,
    "zohoPaymentId" TEXT,
    "externalRef" TEXT,
    "evidenceObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObligationSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "captureMode" TEXT NOT NULL DEFAULT 'form',
    "rawInput" TEXT,
    "aiProposal" JSONB,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "date" DATE NOT NULL,
    "supplierId" TEXT,
    "supplierNameFree" TEXT,
    "categoryId" TEXT,
    "costCenterId" TEXT,
    "cashAccountId" TEXT,
    "paymentMethod" TEXT,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "receiptObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "receiptHash" TEXT,
    "duplicateKey" TEXT,
    "duplicateOfId" TEXT,
    "duplicateStatus" TEXT NOT NULL DEFAULT 'none',
    "approvalRequestId" TEXT,
    "ledgerEntryId" TEXT,
    "obligationId" TEXT,
    "templateId" TEXT,
    "caseId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "postedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseSplit" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "caseId" TEXT,
    "projectRef" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "pct" DECIMAL(7,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "supplierId" TEXT,
    "defaultAmount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "recurrence" JSONB,
    "nextRunAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "costCenterId" TEXT NOT NULL DEFAULT '',
    "categoryId" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "userId" TEXT,
    "areaKey" TEXT,
    "costCenterId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "totalGross" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "approvalRequestId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollLine" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "gross" DECIMAL(18,4) NOT NULL,
    "deductions" JSONB NOT NULL DEFAULT '[]',
    "advancesApplied" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,4) NOT NULL,
    "costCenterId" TEXT,
    "obligationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodClose" (
    "id" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closedByUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "snapshot" JSONB,
    "checks" JSONB,
    "reopenReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeriodClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashAccount_key_key" ON "CashAccount"("key");

-- CreateIndex
CREATE INDEX "CashAccount_status_kind_idx" ON "CashAccount"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCategory_key_key" ON "FinanceCategory"("key");

-- CreateIndex
CREATE INDEX "FinanceCategory_kind_status_idx" ON "FinanceCategory"("kind", "status");

-- CreateIndex
CREATE INDEX "FinanceCategory_parentId_idx" ON "FinanceCategory"("parentId");

-- CreateIndex
CREATE INDEX "FinanceCategory_defaultCostCenterId_idx" ON "FinanceCategory"("defaultCostCenterId");

-- CreateIndex
CREATE UNIQUE INDEX "CostCenter_key_key" ON "CostCenter"("key");

-- CreateIndex
CREATE INDEX "CostCenter_areaKey_idx" ON "CostCenter"("areaKey");

-- CreateIndex
CREATE INDEX "CostCenter_parentId_idx" ON "CostCenter"("parentId");

-- CreateIndex
CREATE INDEX "CostCenter_status_idx" ON "CostCenter"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_number_key" ON "LedgerEntry"("number");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_reversesEntryId_key" ON "LedgerEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "LedgerEntry_periodKey_idx" ON "LedgerEntry"("periodKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_sourceType_sourceId_idx" ON "LedgerEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "LedgerEntry_kind_date_idx" ON "LedgerEntry"("kind", "date");

-- CreateIndex
CREATE INDEX "LedgerEntry_date_idx" ON "LedgerEntry"("date");

-- CreateIndex
CREATE INDEX "LedgerEntry_postedByUserId_postedAt_idx" ON "LedgerEntry"("postedByUserId", "postedAt");

-- CreateIndex
CREATE INDEX "LedgerLine_accountType_accountId_idx" ON "LedgerLine"("accountType", "accountId");

-- CreateIndex
CREATE INDEX "LedgerLine_caseId_idx" ON "LedgerLine"("caseId");

-- CreateIndex
CREATE INDEX "LedgerLine_costCenterId_idx" ON "LedgerLine"("costCenterId");

-- CreateIndex
CREATE INDEX "LedgerLine_procurementOrderId_idx" ON "LedgerLine"("procurementOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerLine_entryId_seq_key" ON "LedgerLine"("entryId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Obligation_number_key" ON "Obligation"("number");

-- CreateIndex
CREATE INDEX "Obligation_kind_status_dueAt_idx" ON "Obligation"("kind", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Obligation_zohoSalesOrderId_idx" ON "Obligation"("zohoSalesOrderId");

-- CreateIndex
CREATE INDEX "Obligation_supplierId_idx" ON "Obligation"("supplierId");

-- CreateIndex
CREATE INDEX "Obligation_zohoContactId_status_idx" ON "Obligation"("zohoContactId", "status");

-- CreateIndex
CREATE INDEX "Obligation_employeeId_status_idx" ON "Obligation"("employeeId", "status");

-- CreateIndex
CREATE INDEX "Obligation_status_expectedCashAt_idx" ON "Obligation"("status", "expectedCashAt");

-- CreateIndex
CREATE INDEX "Obligation_caseId_idx" ON "Obligation"("caseId");

-- CreateIndex
CREATE INDEX "Obligation_procurementOrderId_idx" ON "Obligation"("procurementOrderId");

-- CreateIndex
CREATE INDEX "Obligation_payrollRunId_idx" ON "Obligation"("payrollRunId");

-- CreateIndex
CREATE INDEX "Obligation_expenseId_idx" ON "Obligation"("expenseId");

-- CreateIndex
CREATE INDEX "Obligation_zohoInvoiceId_idx" ON "Obligation"("zohoInvoiceId");

-- CreateIndex
CREATE INDEX "Obligation_ledgerEntryId_idx" ON "Obligation"("ledgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "ObligationSettlement_externalRef_key" ON "ObligationSettlement"("externalRef");

-- CreateIndex
CREATE INDEX "ObligationSettlement_obligationId_settledAt_idx" ON "ObligationSettlement"("obligationId", "settledAt");

-- CreateIndex
CREATE INDEX "ObligationSettlement_ledgerEntryId_idx" ON "ObligationSettlement"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "ObligationSettlement_cashAccountId_settledAt_idx" ON "ObligationSettlement"("cashAccountId", "settledAt");

-- CreateIndex
CREATE INDEX "ObligationSettlement_zohoPaymentId_idx" ON "ObligationSettlement"("zohoPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_number_key" ON "Expense"("number");

-- CreateIndex
CREATE INDEX "Expense_duplicateKey_idx" ON "Expense"("duplicateKey");

-- CreateIndex
CREATE INDEX "Expense_status_date_idx" ON "Expense"("status", "date");

-- CreateIndex
CREATE INDEX "Expense_createdByUserId_status_idx" ON "Expense"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX "Expense_date_idx" ON "Expense"("date");

-- CreateIndex
CREATE INDEX "Expense_receiptHash_idx" ON "Expense"("receiptHash");

-- CreateIndex
CREATE INDEX "Expense_duplicateOfId_idx" ON "Expense"("duplicateOfId");

-- CreateIndex
CREATE INDEX "Expense_supplierId_date_idx" ON "Expense"("supplierId", "date");

-- CreateIndex
CREATE INDEX "Expense_categoryId_date_idx" ON "Expense"("categoryId", "date");

-- CreateIndex
CREATE INDEX "Expense_costCenterId_date_idx" ON "Expense"("costCenterId", "date");

-- CreateIndex
CREATE INDEX "Expense_approvalRequestId_idx" ON "Expense"("approvalRequestId");

-- CreateIndex
CREATE INDEX "Expense_templateId_idx" ON "Expense"("templateId");

-- CreateIndex
CREATE INDEX "Expense_caseId_idx" ON "Expense"("caseId");

-- CreateIndex
CREATE INDEX "ExpenseSplit_expenseId_idx" ON "ExpenseSplit"("expenseId");

-- CreateIndex
CREATE INDEX "ExpenseSplit_costCenterId_idx" ON "ExpenseSplit"("costCenterId");

-- CreateIndex
CREATE INDEX "ExpenseSplit_caseId_idx" ON "ExpenseSplit"("caseId");

-- CreateIndex
CREATE INDEX "ExpenseTemplate_active_nextRunAt_idx" ON "ExpenseTemplate"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "ExpenseTemplate_createdByUserId_idx" ON "ExpenseTemplate"("createdByUserId");

-- CreateIndex
CREATE INDEX "ExpenseTemplate_categoryId_idx" ON "ExpenseTemplate"("categoryId");

-- CreateIndex
CREATE INDEX "Budget_costCenterId_periodKey_idx" ON "Budget"("costCenterId", "periodKey");

-- CreateIndex
CREATE INDEX "Budget_categoryId_periodKey_idx" ON "Budget"("categoryId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_periodKey_costCenterId_categoryId_key" ON "Budget"("periodKey", "costCenterId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_number_key" ON "Employee"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_active_name_idx" ON "Employee"("active", "name");

-- CreateIndex
CREATE INDEX "Employee_areaKey_idx" ON "Employee"("areaKey");

-- CreateIndex
CREATE INDEX "Employee_costCenterId_idx" ON "Employee"("costCenterId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_number_key" ON "PayrollRun"("number");

-- CreateIndex
CREATE INDEX "PayrollRun_periodKey_status_idx" ON "PayrollRun"("periodKey", "status");

-- CreateIndex
CREATE INDEX "PayrollRun_status_createdAt_idx" ON "PayrollRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PayrollRun_approvalRequestId_idx" ON "PayrollRun"("approvalRequestId");

-- CreateIndex
CREATE INDEX "PayrollRun_createdByUserId_idx" ON "PayrollRun"("createdByUserId");

-- CreateIndex
CREATE INDEX "PayrollLine_employeeId_idx" ON "PayrollLine"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollLine_obligationId_idx" ON "PayrollLine"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollLine_payrollRunId_employeeId_key" ON "PayrollLine"("payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX "PeriodClose_kind_status_idx" ON "PeriodClose"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodClose_periodKey_kind_key" ON "PeriodClose"("periodKey", "kind");

-- AddForeignKey
ALTER TABLE "LedgerLine" ADD CONSTRAINT "LedgerLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObligationSettlement" ADD CONSTRAINT "ObligationSettlement_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseSplit" ADD CONSTRAINT "ExpenseSplit_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "taxRegNo" TEXT,
    "zohoContactId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "channels" JSONB NOT NULL DEFAULT '[]',
    "primaryPhone" TEXT,
    "primaryEmail" TEXT,
    "website" TEXT,
    "commContactId" TEXT,
    "paymentTermsDays" INTEGER,
    "paymentMode" TEXT NOT NULL DEFAULT 'prepaid',
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "leadTimeDaysDefault" INTEGER,
    "freightTerms" TEXT,
    "ratingOverall" DECIMAL(4,2),
    "ratingOnTime" DECIMAL(4,2),
    "ratingQuality" DECIMAL(4,2),
    "ratingPrice" DECIMAL(4,2),
    "evaluationsCount" INTEGER NOT NULL DEFAULT 0,
    "lastEvaluatedAt" TIMESTAMP(3),
    "sourceCandidateId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL DEFAULT '',
    "supplierSku" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "unitFactorToBase" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "lastPrice" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "lastQuotedAt" TIMESTAMP(3),
    "leadTimeDays" INTEGER,
    "minOrderQty" DECIMAL(18,4),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "caseId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "areaKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "neededBy" TIMESTAMP(3),
    "reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequestLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "demandId" TEXT,
    "allocationId" TEXT,
    "zohoItemId" TEXT,
    "consolidationKey" TEXT,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "qtyOrdered" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qtyReceived" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rfq" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dueAt" TIMESTAMP(3),
    "sourcingSearchId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rfq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqLine" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "requestLineId" TEXT,
    "zohoItemId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "specs" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RfqLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqInvitation" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "supplierId" TEXT,
    "candidateId" TEXT,
    "channel" TEXT NOT NULL,
    "accountId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RfqInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqResponse" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "invitationId" TEXT,
    "supplierId" TEXT,
    "candidateId" TEXT,
    "receivedVia" TEXT NOT NULL,
    "sourceMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "exchangeRate" DECIMAL(18,6),
    "taxIncluded" BOOLEAN NOT NULL DEFAULT false,
    "taxRate" DECIMAL(9,4),
    "freight" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "otherCosts" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER,
    "validUntil" TIMESTAMP(3),
    "paymentTerms" TEXT,
    "landedTotal" DECIMAL(18,4),
    "score" DECIMAL(9,4),
    "specMatch" DECIMAL(9,4),
    "riskScore" DECIMAL(9,4),
    "confidence" DECIMAL(4,3),
    "interpretation" JSONB,
    "status" TEXT NOT NULL DEFAULT 'parsed',
    "reviewedByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RfqResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfqResponseLine" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "rfqLineId" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitFactorToBase" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "landedUnitCost" DECIMAL(18,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RfqResponseLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "rfqResponseId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "freight" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paymentMode" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "obligationId" TEXT,
    "approvalRequestId" TEXT,
    "expectedAt" TIMESTAMP(3),
    "deliveryMode" TEXT NOT NULL DEFAULT 'warehouse',
    "warehouseId" TEXT,
    "directDeliveryCaseId" TEXT,
    "sentToSupplierAt" TIMESTAMP(3),
    "sentVia" TEXT,
    "conversationId" TEXT,
    "zohoPurchaseOrderId" TEXT,
    "evidenceObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "requestLineId" TEXT,
    "zohoItemId" TEXT,
    "supplierProductId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxRate" DECIMAL(9,4),
    "lineTotal" DECIMAL(18,4) NOT NULL,
    "qtyReceived" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qtyAccepted" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qtyRejected" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementAllocation" (
    "id" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "demandId" TEXT NOT NULL,
    "requestLineId" TEXT,
    "demandAllocationId" TEXT,
    "qty" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "receivedByUserId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL DEFAULT 'warehouse',
    "warehouseId" TEXT,
    "locationId" TEXT,
    "directConfirmedByUserId" TEXT,
    "evidenceObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "qtyReceived" DECIMAL(18,4) NOT NULL,
    "qtyAccepted" DECIMAL(18,4) NOT NULL,
    "qtyRejected" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "lotCode" TEXT,
    "stockMovementId" TEXT,
    "differenceKind" TEXT NOT NULL DEFAULT 'none',
    "incidentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourcingSearch" (
    "id" TEXT NOT NULL,
    "queryText" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "filters" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "rawResultObjectId" TEXT,
    "costUnits" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourcingSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourcingCandidate" (
    "id" TEXT NOT NULL,
    "searchId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "url" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "location" TEXT,
    "productsSummary" TEXT,
    "priceSnippets" JSONB NOT NULL DEFAULT '[]',
    "confidence" DECIMAL(4,3),
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'new',
    "supplierId" TEXT,
    "commContactId" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourcingCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierEvaluation" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "orderId" TEXT,
    "receiptId" TEXT,
    "onTime" INTEGER NOT NULL,
    "quality" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "communication" INTEGER NOT NULL,
    "comment" TEXT,
    "evaluatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_number_key" ON "Supplier"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_zohoContactId_key" ON "Supplier"("zohoContactId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_sourceCandidateId_key" ON "Supplier"("sourceCandidateId");

-- CreateIndex
CREATE INDEX "Supplier_name_idx" ON "Supplier"("name");

-- CreateIndex
CREATE INDEX "Supplier_status_idx" ON "Supplier"("status");

-- CreateIndex
CREATE INDEX "Supplier_taxRegNo_idx" ON "Supplier"("taxRegNo");

-- CreateIndex
CREATE INDEX "Supplier_commContactId_idx" ON "Supplier"("commContactId");

-- CreateIndex
CREATE INDEX "SupplierProduct_zohoItemId_idx" ON "SupplierProduct"("zohoItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_supplierId_zohoItemId_supplierSku_key" ON "SupplierProduct"("supplierId", "zohoItemId", "supplierSku");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_number_key" ON "PurchaseRequest"("number");

-- CreateIndex
CREATE INDEX "PurchaseRequest_status_createdAt_idx" ON "PurchaseRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseRequest_status_neededBy_idx" ON "PurchaseRequest"("status", "neededBy");

-- CreateIndex
CREATE INDEX "PurchaseRequest_caseId_idx" ON "PurchaseRequest"("caseId");

-- CreateIndex
CREATE INDEX "PurchaseRequest_requestedByUserId_status_idx" ON "PurchaseRequest"("requestedByUserId", "status");

-- CreateIndex
CREATE INDEX "PurchaseRequest_areaKey_status_idx" ON "PurchaseRequest"("areaKey", "status");

-- CreateIndex
CREATE INDEX "PurchaseRequestLine_requestId_idx" ON "PurchaseRequestLine"("requestId");

-- CreateIndex
CREATE INDEX "PurchaseRequestLine_demandId_idx" ON "PurchaseRequestLine"("demandId");

-- CreateIndex
CREATE INDEX "PurchaseRequestLine_allocationId_idx" ON "PurchaseRequestLine"("allocationId");

-- CreateIndex
CREATE INDEX "PurchaseRequestLine_zohoItemId_status_idx" ON "PurchaseRequestLine"("zohoItemId", "status");

-- CreateIndex
CREATE INDEX "PurchaseRequestLine_consolidationKey_status_idx" ON "PurchaseRequestLine"("consolidationKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Rfq_number_key" ON "Rfq"("number");

-- CreateIndex
CREATE INDEX "Rfq_status_dueAt_idx" ON "Rfq"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Rfq_status_createdAt_idx" ON "Rfq"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Rfq_createdByUserId_status_idx" ON "Rfq"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX "Rfq_sourcingSearchId_idx" ON "Rfq"("sourcingSearchId");

-- CreateIndex
CREATE INDEX "RfqLine_rfqId_idx" ON "RfqLine"("rfqId");

-- CreateIndex
CREATE INDEX "RfqLine_requestLineId_idx" ON "RfqLine"("requestLineId");

-- CreateIndex
CREATE INDEX "RfqInvitation_rfqId_status_idx" ON "RfqInvitation"("rfqId", "status");

-- CreateIndex
CREATE INDEX "RfqInvitation_supplierId_idx" ON "RfqInvitation"("supplierId");

-- CreateIndex
CREATE INDEX "RfqInvitation_candidateId_idx" ON "RfqInvitation"("candidateId");

-- CreateIndex
CREATE INDEX "RfqInvitation_conversationId_idx" ON "RfqInvitation"("conversationId");

-- CreateIndex
CREATE INDEX "RfqInvitation_status_sentAt_idx" ON "RfqInvitation"("status", "sentAt");

-- CreateIndex
CREATE INDEX "RfqResponse_rfqId_status_idx" ON "RfqResponse"("rfqId", "status");

-- CreateIndex
CREATE INDEX "RfqResponse_invitationId_idx" ON "RfqResponse"("invitationId");

-- CreateIndex
CREATE INDEX "RfqResponse_supplierId_createdAt_idx" ON "RfqResponse"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "RfqResponse_candidateId_idx" ON "RfqResponse"("candidateId");

-- CreateIndex
CREATE INDEX "RfqResponse_status_createdAt_idx" ON "RfqResponse"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RfqResponseLine_responseId_idx" ON "RfqResponseLine"("responseId");

-- CreateIndex
CREATE INDEX "RfqResponseLine_rfqLineId_idx" ON "RfqResponseLine"("rfqLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementOrder_number_key" ON "ProcurementOrder"("number");

-- CreateIndex
CREATE INDEX "ProcurementOrder_status_createdAt_idx" ON "ProcurementOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProcurementOrder_status_expectedAt_idx" ON "ProcurementOrder"("status", "expectedAt");

-- CreateIndex
CREATE INDEX "ProcurementOrder_supplierId_status_idx" ON "ProcurementOrder"("supplierId", "status");

-- CreateIndex
CREATE INDEX "ProcurementOrder_paymentStatus_status_idx" ON "ProcurementOrder"("paymentStatus", "status");

-- CreateIndex
CREATE INDEX "ProcurementOrder_createdByUserId_status_idx" ON "ProcurementOrder"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX "ProcurementOrder_rfqResponseId_idx" ON "ProcurementOrder"("rfqResponseId");

-- CreateIndex
CREATE INDEX "ProcurementOrder_obligationId_idx" ON "ProcurementOrder"("obligationId");

-- CreateIndex
CREATE INDEX "ProcurementOrder_approvalRequestId_idx" ON "ProcurementOrder"("approvalRequestId");

-- CreateIndex
CREATE INDEX "ProcurementOrder_directDeliveryCaseId_idx" ON "ProcurementOrder"("directDeliveryCaseId");

-- CreateIndex
CREATE INDEX "ProcurementOrder_warehouseId_status_idx" ON "ProcurementOrder"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "ProcurementOrder_conversationId_idx" ON "ProcurementOrder"("conversationId");

-- CreateIndex
CREATE INDEX "ProcurementOrder_zohoPurchaseOrderId_idx" ON "ProcurementOrder"("zohoPurchaseOrderId");

-- CreateIndex
CREATE INDEX "ProcurementOrderLine_orderId_idx" ON "ProcurementOrderLine"("orderId");

-- CreateIndex
CREATE INDEX "ProcurementOrderLine_requestLineId_idx" ON "ProcurementOrderLine"("requestLineId");

-- CreateIndex
CREATE INDEX "ProcurementOrderLine_zohoItemId_status_idx" ON "ProcurementOrderLine"("zohoItemId", "status");

-- CreateIndex
CREATE INDEX "ProcurementOrderLine_supplierProductId_idx" ON "ProcurementOrderLine"("supplierProductId");

-- CreateIndex
CREATE INDEX "ProcurementAllocation_demandId_idx" ON "ProcurementAllocation"("demandId");

-- CreateIndex
CREATE INDEX "ProcurementAllocation_demandAllocationId_idx" ON "ProcurementAllocation"("demandAllocationId");

-- CreateIndex
CREATE INDEX "ProcurementAllocation_requestLineId_idx" ON "ProcurementAllocation"("requestLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementAllocation_orderLineId_demandId_key" ON "ProcurementAllocation"("orderLineId", "demandId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_number_key" ON "GoodsReceipt"("number");

-- CreateIndex
CREATE INDEX "GoodsReceipt_orderId_idx" ON "GoodsReceipt"("orderId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_status_receivedAt_idx" ON "GoodsReceipt"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "GoodsReceipt_receivedByUserId_receivedAt_idx" ON "GoodsReceipt"("receivedByUserId", "receivedAt");

-- CreateIndex
CREATE INDEX "GoodsReceipt_warehouseId_receivedAt_idx" ON "GoodsReceipt"("warehouseId", "receivedAt");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_receiptId_idx" ON "GoodsReceiptLine"("receiptId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_orderLineId_idx" ON "GoodsReceiptLine"("orderLineId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_stockMovementId_idx" ON "GoodsReceiptLine"("stockMovementId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_incidentId_idx" ON "GoodsReceiptLine"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "SourcingSearch_queryHash_key" ON "SourcingSearch"("queryHash");

-- CreateIndex
CREATE INDEX "SourcingSearch_status_createdAt_idx" ON "SourcingSearch"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SourcingSearch_createdByUserId_createdAt_idx" ON "SourcingSearch"("createdByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "SourcingSearch_providerKey_executedAt_idx" ON "SourcingSearch"("providerKey", "executedAt");

-- CreateIndex
CREATE INDEX "SourcingSearch_expiresAt_idx" ON "SourcingSearch"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourcingCandidate_dedupeKey_key" ON "SourcingCandidate"("dedupeKey");

-- CreateIndex
CREATE INDEX "SourcingCandidate_searchId_idx" ON "SourcingCandidate"("searchId");

-- CreateIndex
CREATE INDEX "SourcingCandidate_status_updatedAt_idx" ON "SourcingCandidate"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SourcingCandidate_domain_idx" ON "SourcingCandidate"("domain");

-- CreateIndex
CREATE INDEX "SourcingCandidate_phone_idx" ON "SourcingCandidate"("phone");

-- CreateIndex
CREATE INDEX "SourcingCandidate_supplierId_idx" ON "SourcingCandidate"("supplierId");

-- CreateIndex
CREATE INDEX "SourcingCandidate_commContactId_idx" ON "SourcingCandidate"("commContactId");

-- CreateIndex
CREATE INDEX "SupplierEvaluation_supplierId_createdAt_idx" ON "SupplierEvaluation"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "SupplierEvaluation_orderId_idx" ON "SupplierEvaluation"("orderId");

-- CreateIndex
CREATE INDEX "SupplierEvaluation_receiptId_idx" ON "SupplierEvaluation"("receiptId");

-- CreateIndex
CREATE INDEX "SupplierEvaluation_evaluatedByUserId_idx" ON "SupplierEvaluation"("evaluatedByUserId");

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqInvitation" ADD CONSTRAINT "RfqInvitation_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqResponse" ADD CONSTRAINT "RfqResponse_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RfqResponseLine" ADD CONSTRAINT "RfqResponseLine_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "RfqResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementOrderLine" ADD CONSTRAINT "ProcurementOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementAllocation" ADD CONSTRAINT "ProcurementAllocation_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "ProcurementOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierEvaluation" ADD CONSTRAINT "SupplierEvaluation_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;


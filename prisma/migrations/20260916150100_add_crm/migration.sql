-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "probabilityDefault" DECIMAL(4,3) NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'open',
    "slaHours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "commContactId" TEXT,
    "zohoContactId" TEXT,
    "contactName" TEXT NOT NULL,
    "salespersonUserId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estimatedValue" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "probability" DECIMAL(4,3),
    "expectedCloseAt" TIMESTAMP(3),
    "nextActionAt" TIMESTAMP(3),
    "nextActionText" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "conversationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "voiceCallIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "zohoEstimateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "zohoSalesOrderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "caseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'open',
    "lostReason" TEXT,
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityActivity" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB,
    "userId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderWriteRequest" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "quoteId" TEXT,
    "zohoEstimateId" TEXT,
    "salesOrderId" TEXT,
    "zohoSalesOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrderWriteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadarSignal" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "opportunityId" TEXT,
    "conversationId" TEXT,
    "quoteId" TEXT,
    "zohoContactId" TEXT,
    "commContactId" TEXT,
    "customerName" TEXT,
    "salespersonUserId" TEXT,
    "score" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "data" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "snoozedUntil" TIMESTAMP(3),
    "aiExplanation" TEXT,
    "aiSuggestedMessage" TEXT,
    "aiGeneratedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RadarSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_key_key" ON "PipelineStage"("key");

-- CreateIndex
CREATE INDEX "PipelineStage_active_order_idx" ON "PipelineStage"("active", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_number_key" ON "Opportunity"("number");

-- CreateIndex
CREATE INDEX "Opportunity_salespersonUserId_status_idx" ON "Opportunity"("salespersonUserId", "status");

-- CreateIndex
CREATE INDEX "Opportunity_commContactId_idx" ON "Opportunity"("commContactId");

-- CreateIndex
CREATE INDEX "Opportunity_zohoContactId_idx" ON "Opportunity"("zohoContactId");

-- CreateIndex
CREATE INDEX "Opportunity_stageId_idx" ON "Opportunity"("stageId");

-- CreateIndex
CREATE INDEX "Opportunity_nextActionAt_idx" ON "Opportunity"("nextActionAt");

-- CreateIndex
CREATE INDEX "Opportunity_status_lastActivityAt_idx" ON "Opportunity"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "Opportunity_status_expectedCloseAt_idx" ON "Opportunity"("status", "expectedCloseAt");

-- CreateIndex
CREATE INDEX "Opportunity_conversationIds_idx" ON "Opportunity" USING GIN ("conversationIds");

-- CreateIndex
CREATE INDEX "Opportunity_voiceCallIds_idx" ON "Opportunity" USING GIN ("voiceCallIds");

-- CreateIndex
CREATE INDEX "Opportunity_zohoEstimateIds_idx" ON "Opportunity" USING GIN ("zohoEstimateIds");

-- CreateIndex
CREATE INDEX "Opportunity_zohoSalesOrderIds_idx" ON "Opportunity" USING GIN ("zohoSalesOrderIds");

-- CreateIndex
CREATE INDEX "Opportunity_caseIds_idx" ON "Opportunity" USING GIN ("caseIds");

-- CreateIndex
CREATE INDEX "OpportunityActivity_opportunityId_at_idx" ON "OpportunityActivity"("opportunityId", "at");

-- CreateIndex
CREATE INDEX "OpportunityActivity_refType_refId_idx" ON "OpportunityActivity"("refType", "refId");

-- CreateIndex
CREATE INDEX "OpportunityActivity_kind_at_idx" ON "OpportunityActivity"("kind", "at");

-- CreateIndex
CREATE INDEX "OpportunityActivity_userId_at_idx" ON "OpportunityActivity"("userId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderWriteRequest_requestKey_key" ON "SalesOrderWriteRequest"("requestKey");

-- CreateIndex
CREATE INDEX "SalesOrderWriteRequest_userId_createdAt_idx" ON "SalesOrderWriteRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SalesOrderWriteRequest_status_createdAt_idx" ON "SalesOrderWriteRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SalesOrderWriteRequest_opportunityId_idx" ON "SalesOrderWriteRequest"("opportunityId");

-- CreateIndex
CREATE INDEX "SalesOrderWriteRequest_quoteId_idx" ON "SalesOrderWriteRequest"("quoteId");

-- CreateIndex
CREATE INDEX "SalesOrderWriteRequest_zohoSalesOrderId_idx" ON "SalesOrderWriteRequest"("zohoSalesOrderId");

-- CreateIndex
CREATE INDEX "RadarSignal_salespersonUserId_status_score_idx" ON "RadarSignal"("salespersonUserId", "status", "score");

-- CreateIndex
CREATE INDEX "RadarSignal_status_expiresAt_idx" ON "RadarSignal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "RadarSignal_status_snoozedUntil_idx" ON "RadarSignal"("status", "snoozedUntil");

-- CreateIndex
CREATE INDEX "RadarSignal_opportunityId_idx" ON "RadarSignal"("opportunityId");

-- CreateIndex
CREATE INDEX "RadarSignal_conversationId_idx" ON "RadarSignal"("conversationId");

-- CreateIndex
CREATE INDEX "RadarSignal_zohoContactId_idx" ON "RadarSignal"("zohoContactId");

-- CreateIndex
CREATE UNIQUE INDEX "RadarSignal_kind_subjectKey_key" ON "RadarSignal"("kind", "subjectKey");

-- AddForeignKey
ALTER TABLE "OpportunityActivity" ADD CONSTRAINT "OpportunityActivity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;


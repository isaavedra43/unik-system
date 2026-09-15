-- Operations core (plan UNIK Neural Operations, Grupo A, migración 1).
-- Additive only: CREATE TABLE / CREATE INDEX / ADD CONSTRAINT. No DROP, no data changes.
-- Models: Area, OperationalCase, CaseDemand, DemandAllocation, ProcessVersion, CaseStep,
-- WorkItem, AreaRequest, Incident, OperationalEvent, OperationalCommand, EvidenceLink,
-- ObjectRelation, Sequence, ApprovalPolicy, ApprovalRequest.

-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "responsibleArea" TEXT NOT NULL,
    "leadUserId" TEXT,
    "chatChannelId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalCase" (
    "id" TEXT NOT NULL,
    "caseSeq" INTEGER NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "zohoSalesOrderId" TEXT,
    "salesOrderNumber" TEXT,
    "customerName" TEXT,
    "zohoCustomerId" TEXT,
    "salespersonName" TEXT,
    "locationId" TEXT,
    "locationName" TEXT,
    "deliveryMethod" TEXT,
    "orderDate" TIMESTAMP(3),
    "processVersionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "phase" TEXT NOT NULL DEFAULT 'planning',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "ownerUserId" TEXT NOT NULL,
    "promisedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chatChannelId" TEXT,
    "aiSummary" TEXT,
    "aiSummaryEventId" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseDemand" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "lineRef" TEXT NOT NULL,
    "zohoItemId" TEXT,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "baseUnit" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL DEFAULT '',
    "variantJson" JSONB,
    "locationId" TEXT,
    "requestedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fulfilledQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseDemand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemandAllocation" (
    "id" TEXT NOT NULL,
    "demandId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "warehouseId" TEXT,
    "stockReservationId" TEXT,
    "linkedType" TEXT,
    "linkedId" TEXT,
    "expectedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "deliveredQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemandAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessVersion" (
    "id" TEXT NOT NULL,
    "processKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseStep" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "processVersionId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'case',
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "demandId" TEXT,
    "allocationId" TEXT,
    "areaKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slaMinutes" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "exitEvidence" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "stepId" TEXT,
    "areaKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "ownerUserId" TEXT NOT NULL,
    "backupUserId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "escalatedAt" TIMESTAMP(3),
    "waitReason" TEXT,
    "waitUntil" TIMESTAMP(3),
    "objectType" TEXT,
    "objectId" TEXT,
    "requiredEvidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "result" JSONB,
    "completedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaRequest" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "fromAreaKey" TEXT NOT NULL,
    "toAreaKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "freeText" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'sent',
    "blocksDelivery" BOOLEAN NOT NULL DEFAULT false,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "backupUserId" TEXT,
    "workItemId" TEXT,
    "createdByType" TEXT NOT NULL,
    "createdById" TEXT,
    "chatMessageId" TEXT,
    "answer" JSONB,
    "answeredAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "areaKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "ownerUserId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalEvent" (
    "id" BIGSERIAL NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caseId" TEXT,
    "areaKey" TEXT,
    "type" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "commandId" TEXT,
    "objectType" TEXT,
    "objectId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "OperationalEvent_pkey" PRIMARY KEY ("id","occurredAt")
);

-- CreateTable
CREATE TABLE "OperationalCommand" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "expectedVersion" INTEGER,
    "payloadHash" TEXT NOT NULL,
    "deviceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "result" JSONB,
    "errorCode" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceLink" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "workItemId" TEXT,
    "stepId" TEXT,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageObjectId" TEXT,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectRelation" (
    "id" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObjectRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "key" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ApprovalPolicy" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "categoryId" TEXT,
    "minAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "maxAmount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "approverRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "policyId" TEXT,
    "requiredApprovals" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedByUserId" TEXT NOT NULL,
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "caseId" TEXT,
    "areaKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Area_key_key" ON "Area"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Area_chatChannelId_key" ON "Area"("chatChannelId");

-- CreateIndex
CREATE INDEX "Area_active_sortOrder_idx" ON "Area"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "Area_leadUserId_idx" ON "Area"("leadUserId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalCase_caseSeq_key" ON "OperationalCase"("caseSeq");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalCase_caseNumber_key" ON "OperationalCase"("caseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalCase_chatChannelId_key" ON "OperationalCase"("chatChannelId");

-- CreateIndex
CREATE INDEX "OperationalCase_status_lastActivityAt_idx" ON "OperationalCase"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "OperationalCase_zohoSalesOrderId_idx" ON "OperationalCase"("zohoSalesOrderId");

-- CreateIndex
CREATE INDEX "OperationalCase_ownerUserId_status_idx" ON "OperationalCase"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "OperationalCase_phase_status_idx" ON "OperationalCase"("phase", "status");

-- CreateIndex
CREATE INDEX "OperationalCase_locationId_status_idx" ON "OperationalCase"("locationId", "status");

-- CreateIndex
CREATE INDEX "OperationalCase_promisedAt_idx" ON "OperationalCase"("promisedAt");

-- CreateIndex
CREATE INDEX "OperationalCase_openedAt_idx" ON "OperationalCase"("openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalCase_kind_sourceType_sourceId_key" ON "OperationalCase"("kind", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CaseDemand_zohoItemId_status_idx" ON "CaseDemand"("zohoItemId", "status");

-- CreateIndex
CREATE INDEX "CaseDemand_sku_status_idx" ON "CaseDemand"("sku", "status");

-- CreateIndex
CREATE INDEX "CaseDemand_status_idx" ON "CaseDemand"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CaseDemand_caseId_lineRef_key" ON "CaseDemand"("caseId", "lineRef");

-- CreateIndex
CREATE INDEX "DemandAllocation_caseId_status_idx" ON "DemandAllocation"("caseId", "status");

-- CreateIndex
CREATE INDEX "DemandAllocation_demandId_idx" ON "DemandAllocation"("demandId");

-- CreateIndex
CREATE INDEX "DemandAllocation_linkedType_linkedId_idx" ON "DemandAllocation"("linkedType", "linkedId");

-- CreateIndex
CREATE INDEX "DemandAllocation_stockReservationId_idx" ON "DemandAllocation"("stockReservationId");

-- CreateIndex
CREATE INDEX "DemandAllocation_source_status_idx" ON "DemandAllocation"("source", "status");

-- CreateIndex
CREATE INDEX "ProcessVersion_processKey_active_idx" ON "ProcessVersion"("processKey", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessVersion_processKey_version_key" ON "ProcessVersion"("processKey", "version");

-- CreateIndex
CREATE INDEX "CaseStep_areaKey_status_idx" ON "CaseStep"("areaKey", "status");

-- CreateIndex
CREATE INDEX "CaseStep_status_dueAt_idx" ON "CaseStep"("status", "dueAt");

-- CreateIndex
CREATE INDEX "CaseStep_demandId_idx" ON "CaseStep"("demandId");

-- CreateIndex
CREATE INDEX "CaseStep_allocationId_idx" ON "CaseStep"("allocationId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseStep_caseId_stepKey_scopeKey_key" ON "CaseStep"("caseId", "stepKey", "scopeKey");

-- CreateIndex
CREATE INDEX "WorkItem_status_dueAt_idx" ON "WorkItem"("status", "dueAt");

-- CreateIndex
CREATE INDEX "WorkItem_areaKey_status_dueAt_idx" ON "WorkItem"("areaKey", "status", "dueAt");

-- CreateIndex
CREATE INDEX "WorkItem_ownerUserId_status_idx" ON "WorkItem"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "WorkItem_backupUserId_status_idx" ON "WorkItem"("backupUserId", "status");

-- CreateIndex
CREATE INDEX "WorkItem_caseId_idx" ON "WorkItem"("caseId");

-- CreateIndex
CREATE INDEX "WorkItem_stepId_idx" ON "WorkItem"("stepId");

-- CreateIndex
CREATE INDEX "WorkItem_objectType_objectId_idx" ON "WorkItem"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "AreaRequest_toAreaKey_status_dueAt_idx" ON "AreaRequest"("toAreaKey", "status", "dueAt");

-- CreateIndex
CREATE INDEX "AreaRequest_fromAreaKey_status_idx" ON "AreaRequest"("fromAreaKey", "status");

-- CreateIndex
CREATE INDEX "AreaRequest_caseId_idx" ON "AreaRequest"("caseId");

-- CreateIndex
CREATE INDEX "AreaRequest_ownerUserId_status_idx" ON "AreaRequest"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "AreaRequest_status_dueAt_idx" ON "AreaRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX "AreaRequest_objectType_objectId_idx" ON "AreaRequest"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "AreaRequest_workItemId_idx" ON "AreaRequest"("workItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_dedupeKey_key" ON "Incident"("dedupeKey");

-- CreateIndex
CREATE INDEX "Incident_status_severity_openedAt_idx" ON "Incident"("status", "severity", "openedAt");

-- CreateIndex
CREATE INDEX "Incident_areaKey_status_idx" ON "Incident"("areaKey", "status");

-- CreateIndex
CREATE INDEX "Incident_caseId_idx" ON "Incident"("caseId");

-- CreateIndex
CREATE INDEX "Incident_kind_status_idx" ON "Incident"("kind", "status");

-- CreateIndex
CREATE INDEX "Incident_ownerUserId_status_idx" ON "Incident"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "OperationalEvent_caseId_id_idx" ON "OperationalEvent"("caseId", "id");

-- CreateIndex
CREATE INDEX "OperationalEvent_type_occurredAt_idx" ON "OperationalEvent"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "OperationalEvent_commandId_idx" ON "OperationalEvent"("commandId");

-- CreateIndex
CREATE INDEX "OperationalEvent_areaKey_occurredAt_idx" ON "OperationalEvent"("areaKey", "occurredAt");

-- CreateIndex
CREATE INDEX "OperationalEvent_objectType_objectId_idx" ON "OperationalEvent"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "OperationalEvent_recordedAt_idx" ON "OperationalEvent"("recordedAt");

-- CreateIndex
CREATE INDEX "OperationalEvent_actorId_occurredAt_idx" ON "OperationalEvent"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "OperationalCommand_aggregateType_aggregateId_idx" ON "OperationalCommand"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "OperationalCommand_deviceId_receivedAt_idx" ON "OperationalCommand"("deviceId", "receivedAt");

-- CreateIndex
CREATE INDEX "OperationalCommand_status_receivedAt_idx" ON "OperationalCommand"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "OperationalCommand_actorId_receivedAt_idx" ON "OperationalCommand"("actorId", "receivedAt");

-- CreateIndex
CREATE INDEX "EvidenceLink_objectType_objectId_idx" ON "EvidenceLink"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "EvidenceLink_caseId_idx" ON "EvidenceLink"("caseId");

-- CreateIndex
CREATE INDEX "EvidenceLink_workItemId_idx" ON "EvidenceLink"("workItemId");

-- CreateIndex
CREATE INDEX "EvidenceLink_stepId_idx" ON "EvidenceLink"("stepId");

-- CreateIndex
CREATE INDEX "ObjectRelation_toType_toId_idx" ON "ObjectRelation"("toType", "toId");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectRelation_fromType_fromId_toType_toId_relation_key" ON "ObjectRelation"("fromType", "fromId", "toType", "toId", "relation");

-- CreateIndex
CREATE INDEX "ApprovalPolicy_scope_active_minAmount_idx" ON "ApprovalPolicy"("scope", "active", "minAmount");

-- CreateIndex
CREATE INDEX "ApprovalPolicy_categoryId_idx" ON "ApprovalPolicy"("categoryId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_targetType_targetId_idx" ON "ApprovalRequest"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_scope_idx" ON "ApprovalRequest"("status", "scope");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_expiresAt_idx" ON "ApprovalRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_requestedByUserId_status_idx" ON "ApprovalRequest"("requestedByUserId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_areaKey_status_idx" ON "ApprovalRequest"("areaKey", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_caseId_idx" ON "ApprovalRequest"("caseId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_policyId_idx" ON "ApprovalRequest"("policyId");

-- AddForeignKey
ALTER TABLE "CaseDemand" ADD CONSTRAINT "CaseDemand_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OperationalCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandAllocation" ADD CONSTRAINT "DemandAllocation_demandId_fkey" FOREIGN KEY ("demandId") REFERENCES "CaseDemand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseStep" ADD CONSTRAINT "CaseStep_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OperationalCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;


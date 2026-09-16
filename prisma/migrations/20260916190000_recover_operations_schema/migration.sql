-- Recovery for databases whose Prisma migration ledger recorded the Neural Operations
-- migrations while their DDL was absent. This migration is additive and idempotent:
-- it creates only missing operational tables, indexes, columns, and foreign keys.
-- It intentionally contains no DROP, TRUNCATE, UPDATE, or DELETE statements.

-- Reconciled from 20260916120000_add_operations_core.
-- Operations core (plan UNIK Neural Operations, Grupo A, migración 1).
-- Additive only: CREATE TABLE / CREATE INDEX / ADD CONSTRAINT. No DROP, no data changes.
-- Models: Area, OperationalCase, CaseDemand, DemandAllocation, ProcessVersion, CaseStep,
-- WorkItem, AreaRequest, Incident, OperationalEvent, OperationalCommand, EvidenceLink,
-- ObjectRelation, Sequence, ApprovalPolicy, ApprovalRequest.

-- CreateTable
CREATE TABLE IF NOT EXISTS "Area" (
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
CREATE TABLE IF NOT EXISTS "OperationalCase" (
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
CREATE TABLE IF NOT EXISTS "CaseDemand" (
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
CREATE TABLE IF NOT EXISTS "DemandAllocation" (
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
CREATE TABLE IF NOT EXISTS "ProcessVersion" (
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
CREATE TABLE IF NOT EXISTS "CaseStep" (
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
CREATE TABLE IF NOT EXISTS "WorkItem" (
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
CREATE TABLE IF NOT EXISTS "AreaRequest" (
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
CREATE TABLE IF NOT EXISTS "Incident" (
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
CREATE TABLE IF NOT EXISTS "OperationalEvent" (
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
CREATE TABLE IF NOT EXISTS "OperationalCommand" (
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
CREATE TABLE IF NOT EXISTS "EvidenceLink" (
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
CREATE TABLE IF NOT EXISTS "ObjectRelation" (
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
CREATE TABLE IF NOT EXISTS "Sequence" (
    "key" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApprovalPolicy" (
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
CREATE TABLE IF NOT EXISTS "ApprovalRequest" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "Area_key_key" ON "Area"("key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Area_chatChannelId_key" ON "Area"("chatChannelId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Area_active_sortOrder_idx" ON "Area"("active", "sortOrder");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Area_leadUserId_idx" ON "Area"("leadUserId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OperationalCase_caseSeq_key" ON "OperationalCase"("caseSeq");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OperationalCase_caseNumber_key" ON "OperationalCase"("caseNumber");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OperationalCase_chatChannelId_key" ON "OperationalCase"("chatChannelId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCase_status_lastActivityAt_idx" ON "OperationalCase"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCase_zohoSalesOrderId_idx" ON "OperationalCase"("zohoSalesOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCase_ownerUserId_status_idx" ON "OperationalCase"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCase_phase_status_idx" ON "OperationalCase"("phase", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCase_locationId_status_idx" ON "OperationalCase"("locationId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCase_promisedAt_idx" ON "OperationalCase"("promisedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCase_openedAt_idx" ON "OperationalCase"("openedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OperationalCase_kind_sourceType_sourceId_key" ON "OperationalCase"("kind", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaseDemand_zohoItemId_status_idx" ON "CaseDemand"("zohoItemId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaseDemand_sku_status_idx" ON "CaseDemand"("sku", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaseDemand_status_idx" ON "CaseDemand"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CaseDemand_caseId_lineRef_key" ON "CaseDemand"("caseId", "lineRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DemandAllocation_caseId_status_idx" ON "DemandAllocation"("caseId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DemandAllocation_demandId_idx" ON "DemandAllocation"("demandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DemandAllocation_linkedType_linkedId_idx" ON "DemandAllocation"("linkedType", "linkedId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DemandAllocation_stockReservationId_idx" ON "DemandAllocation"("stockReservationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DemandAllocation_source_status_idx" ON "DemandAllocation"("source", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcessVersion_processKey_active_idx" ON "ProcessVersion"("processKey", "active");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProcessVersion_processKey_version_key" ON "ProcessVersion"("processKey", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaseStep_areaKey_status_idx" ON "CaseStep"("areaKey", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaseStep_status_dueAt_idx" ON "CaseStep"("status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaseStep_demandId_idx" ON "CaseStep"("demandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CaseStep_allocationId_idx" ON "CaseStep"("allocationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CaseStep_caseId_stepKey_scopeKey_key" ON "CaseStep"("caseId", "stepKey", "scopeKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkItem_status_dueAt_idx" ON "WorkItem"("status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkItem_areaKey_status_dueAt_idx" ON "WorkItem"("areaKey", "status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkItem_ownerUserId_status_idx" ON "WorkItem"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkItem_backupUserId_status_idx" ON "WorkItem"("backupUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkItem_caseId_idx" ON "WorkItem"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkItem_stepId_idx" ON "WorkItem"("stepId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkItem_objectType_objectId_idx" ON "WorkItem"("objectType", "objectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AreaRequest_toAreaKey_status_dueAt_idx" ON "AreaRequest"("toAreaKey", "status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AreaRequest_fromAreaKey_status_idx" ON "AreaRequest"("fromAreaKey", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AreaRequest_caseId_idx" ON "AreaRequest"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AreaRequest_ownerUserId_status_idx" ON "AreaRequest"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AreaRequest_status_dueAt_idx" ON "AreaRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AreaRequest_objectType_objectId_idx" ON "AreaRequest"("objectType", "objectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AreaRequest_workItemId_idx" ON "AreaRequest"("workItemId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Incident_dedupeKey_key" ON "Incident"("dedupeKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Incident_status_severity_openedAt_idx" ON "Incident"("status", "severity", "openedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Incident_areaKey_status_idx" ON "Incident"("areaKey", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Incident_caseId_idx" ON "Incident"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Incident_kind_status_idx" ON "Incident"("kind", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Incident_ownerUserId_status_idx" ON "Incident"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalEvent_caseId_id_idx" ON "OperationalEvent"("caseId", "id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalEvent_type_occurredAt_idx" ON "OperationalEvent"("type", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalEvent_commandId_idx" ON "OperationalEvent"("commandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalEvent_areaKey_occurredAt_idx" ON "OperationalEvent"("areaKey", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalEvent_objectType_objectId_idx" ON "OperationalEvent"("objectType", "objectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalEvent_recordedAt_idx" ON "OperationalEvent"("recordedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalEvent_actorId_occurredAt_idx" ON "OperationalEvent"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCommand_aggregateType_aggregateId_idx" ON "OperationalCommand"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCommand_deviceId_receivedAt_idx" ON "OperationalCommand"("deviceId", "receivedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCommand_status_receivedAt_idx" ON "OperationalCommand"("status", "receivedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OperationalCommand_actorId_receivedAt_idx" ON "OperationalCommand"("actorId", "receivedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvidenceLink_objectType_objectId_idx" ON "EvidenceLink"("objectType", "objectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvidenceLink_caseId_idx" ON "EvidenceLink"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvidenceLink_workItemId_idx" ON "EvidenceLink"("workItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EvidenceLink_stepId_idx" ON "EvidenceLink"("stepId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ObjectRelation_toType_toId_idx" ON "ObjectRelation"("toType", "toId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ObjectRelation_fromType_fromId_toType_toId_relation_key" ON "ObjectRelation"("fromType", "fromId", "toType", "toId", "relation");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalPolicy_scope_active_minAmount_idx" ON "ApprovalPolicy"("scope", "active", "minAmount");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalPolicy_categoryId_idx" ON "ApprovalPolicy"("categoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_targetType_targetId_idx" ON "ApprovalRequest"("targetType", "targetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_status_scope_idx" ON "ApprovalRequest"("status", "scope");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_status_expiresAt_idx" ON "ApprovalRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_requestedByUserId_status_idx" ON "ApprovalRequest"("requestedByUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_areaKey_status_idx" ON "ApprovalRequest"("areaKey", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_caseId_idx" ON "ApprovalRequest"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRequest_policyId_idx" ON "ApprovalRequest"("policyId");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "CaseDemand" ADD CONSTRAINT "CaseDemand_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OperationalCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "DemandAllocation" ADD CONSTRAINT "DemandAllocation_demandId_fkey" FOREIGN KEY ("demandId") REFERENCES "CaseDemand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "CaseStep" ADD CONSTRAINT "CaseStep_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OperationalCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reconciled from 20260916130000_add_inventory_logistics_core.
-- CreateTable
CREATE TABLE IF NOT EXISTS "Warehouse" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zohoLocationId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StorageLocation" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "kind" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductInventoryProfile" (
    "id" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL,
    "baseUnit" TEXT NOT NULL,
    "conversions" JSONB NOT NULL DEFAULT '[]',
    "tolerancePct" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "isBulk" BOOLEAN NOT NULL DEFAULT false,
    "trackingPolicy" TEXT NOT NULL DEFAULT 'none',
    "variantAxes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultSource" TEXT NOT NULL DEFAULT 'stock',
    "confidence" TEXT NOT NULL DEFAULT 'UNCOUNTED',
    "consecutiveGoodCounts" INTEGER NOT NULL DEFAULT 0,
    "lastCountAt" TIMESTAMP(3),
    "controlledAt" TIMESTAMP(3),
    "weightKgPerBaseUnit" DECIMAL(18,4),
    "areaM2PerBaseUnit" DECIMAL(18,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductInventoryProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StockItem" (
    "id" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL DEFAULT '',
    "variantJson" JSONB,
    "containerKey" TEXT NOT NULL DEFAULT '',
    "baseline" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "receipts" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "returns" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "produced" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "issued" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "consumed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "adjustments" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "blocked" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "assignedToProduction" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "knownQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lastCountedAt" TIMESTAMP(3),
    "originProductionOrderId" TEXT,
    "dimensions" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StockMovement" (
    "id" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "originalQuantity" DECIMAL(18,4) NOT NULL,
    "originalUnit" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "commandId" TEXT,
    "actorId" TEXT NOT NULL,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StockReservation" (
    "id" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "demandId" TEXT NOT NULL,
    "allocationId" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "confidenceAtReserve" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StockCount" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'spot',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "startedBy" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StockCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "expectedQty" DECIMAL(18,4) NOT NULL,
    "countedQty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "diffQty" DECIMAL(18,4) NOT NULL,
    "withinTolerance" BOOLEAN NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT 'pending',
    "countedBy" TEXT NOT NULL,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LegacyCommitmentClaim" (
    "id" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reference" TEXT,
    "caseId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "claimedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyCommitmentClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Vehicle" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "capacityKg" DECIMAL(18,4),
    "capacityM2" DECIMAL(18,4),
    "capacityPieces" INTEGER,
    "maintenanceUntil" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Driver" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "licenseNumber" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeliveryOrder" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "allocationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "packageId" TEXT,
    "zohoPackageId" TEXT,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "carrier" TEXT,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "tripId" TEXT,
    "plannedDate" TIMESTAMP(3),
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "addressLine" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "lat" DECIMAL(10,7),
    "lng" DECIMAL(10,7),
    "shipmentInput" JSONB,
    "zohoShipmentId" TEXT,
    "zohoReadback" JSONB,
    "conflictDetail" JSONB,
    "zohoSyncState" TEXT NOT NULL DEFAULT 'not_required',
    "zohoLastAttemptAt" TIMESTAMP(3),
    "zohoError" TEXT,
    "deliveredLines" JSONB,
    "partialReason" TEXT,
    "parentDeliveryOrderId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Trip" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TripStop" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "deliveryOrderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "etaAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "lat" DECIMAL(10,7),
    "lng" DECIMAL(10,7),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DeliveryEvidence" (
    "id" TEXT NOT NULL,
    "deliveryOrderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageObjectId" TEXT,
    "deliveredLines" JSONB,
    "note" TEXT,
    "lat" DECIMAL(10,7),
    "lng" DECIMAL(10,7),
    "commandId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Warehouse_key_key" ON "Warehouse"("key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Warehouse_zohoLocationId_key" ON "Warehouse"("zohoLocationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Warehouse_active_idx" ON "Warehouse"("active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StorageLocation_warehouseId_active_idx" ON "StorageLocation"("warehouseId", "active");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StorageLocation_warehouseId_code_key" ON "StorageLocation"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductInventoryProfile_zohoItemId_key" ON "ProductInventoryProfile"("zohoItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductInventoryProfile_confidence_idx" ON "ProductInventoryProfile"("confidence");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductInventoryProfile_trackingPolicy_idx" ON "ProductInventoryProfile"("trackingPolicy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockItem_warehouseId_locationId_idx" ON "StockItem"("warehouseId", "locationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockItem_originProductionOrderId_idx" ON "StockItem"("originProductionOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockItem_containerKey_idx" ON "StockItem"("containerKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StockItem_zohoItemId_warehouseId_locationId_variantKey_cont_key" ON "StockItem"("zohoItemId", "warehouseId", "locationId", "variantKey", "containerKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockMovement_stockItemId_occurredAt_idx" ON "StockMovement"("stockItemId", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockMovement_referenceType_referenceId_idx" ON "StockMovement"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockMovement_zohoItemId_warehouseId_occurredAt_idx" ON "StockMovement"("zohoItemId", "warehouseId", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockMovement_kind_occurredAt_idx" ON "StockMovement"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockMovement_commandId_idx" ON "StockMovement"("commandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockReservation_stockItemId_status_idx" ON "StockReservation"("stockItemId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockReservation_zohoItemId_warehouseId_status_idx" ON "StockReservation"("zohoItemId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockReservation_caseId_idx" ON "StockReservation"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockReservation_demandId_idx" ON "StockReservation"("demandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockReservation_allocationId_idx" ON "StockReservation"("allocationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockReservation_status_createdAt_idx" ON "StockReservation"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockCount_warehouseId_status_idx" ON "StockCount"("warehouseId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockCount_status_createdAt_idx" ON "StockCount"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockCount_startedBy_idx" ON "StockCount"("startedBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockCountLine_stockItemId_countedAt_idx" ON "StockCountLine"("stockItemId", "countedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockCountLine_resolution_idx" ON "StockCountLine"("resolution");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StockCountLine_countId_stockItemId_key" ON "StockCountLine"("countId", "stockItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LegacyCommitmentClaim_zohoItemId_warehouseId_status_idx" ON "LegacyCommitmentClaim"("zohoItemId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LegacyCommitmentClaim_status_expiresAt_idx" ON "LegacyCommitmentClaim"("status", "expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LegacyCommitmentClaim_caseId_idx" ON "LegacyCommitmentClaim"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LegacyCommitmentClaim_claimedBy_status_idx" ON "LegacyCommitmentClaim"("claimedBy", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Vehicle_code_key" ON "Vehicle"("code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_active_idx" ON "Vehicle"("active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Vehicle_plate_idx" ON "Vehicle"("plate");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Driver_userId_key" ON "Driver"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Driver_active_idx" ON "Driver"("active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryOrder_caseId_idx" ON "DeliveryOrder"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryOrder_status_plannedDate_idx" ON "DeliveryOrder"("status", "plannedDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryOrder_tripId_idx" ON "DeliveryOrder"("tripId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryOrder_zohoPackageId_idx" ON "DeliveryOrder"("zohoPackageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryOrder_packageId_idx" ON "DeliveryOrder"("packageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryOrder_zohoSyncState_zohoLastAttemptAt_idx" ON "DeliveryOrder"("zohoSyncState", "zohoLastAttemptAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryOrder_parentDeliveryOrderId_idx" ON "DeliveryOrder"("parentDeliveryOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryOrder_driverId_plannedDate_idx" ON "DeliveryOrder"("driverId", "plannedDate");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Trip_number_key" ON "Trip"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trip_date_status_idx" ON "Trip"("date", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trip_driverId_date_idx" ON "Trip"("driverId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trip_vehicleId_date_idx" ON "Trip"("vehicleId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trip_status_idx" ON "Trip"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TripStop_tripId_sequence_idx" ON "TripStop"("tripId", "sequence");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TripStop_deliveryOrderId_idx" ON "TripStop"("deliveryOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TripStop_status_idx" ON "TripStop"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TripStop_tripId_deliveryOrderId_key" ON "TripStop"("tripId", "deliveryOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryEvidence_deliveryOrderId_createdAt_idx" ON "DeliveryEvidence"("deliveryOrderId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryEvidence_storageObjectId_idx" ON "DeliveryEvidence"("storageObjectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DeliveryEvidence_commandId_idx" ON "DeliveryEvidence"("commandId");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "TripStop" ADD CONSTRAINT "TripStop_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reconciled from 20260916140000_add_purchases.
-- CreateTable
CREATE TABLE IF NOT EXISTS "Supplier" (
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
CREATE TABLE IF NOT EXISTS "SupplierProduct" (
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
CREATE TABLE IF NOT EXISTS "PurchaseRequest" (
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
CREATE TABLE IF NOT EXISTS "PurchaseRequestLine" (
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
CREATE TABLE IF NOT EXISTS "Rfq" (
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
CREATE TABLE IF NOT EXISTS "RfqLine" (
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
CREATE TABLE IF NOT EXISTS "RfqInvitation" (
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
CREATE TABLE IF NOT EXISTS "RfqResponse" (
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
CREATE TABLE IF NOT EXISTS "RfqResponseLine" (
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
CREATE TABLE IF NOT EXISTS "ProcurementOrder" (
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
CREATE TABLE IF NOT EXISTS "ProcurementOrderLine" (
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
CREATE TABLE IF NOT EXISTS "ProcurementAllocation" (
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
CREATE TABLE IF NOT EXISTS "GoodsReceipt" (
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
CREATE TABLE IF NOT EXISTS "GoodsReceiptLine" (
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
CREATE TABLE IF NOT EXISTS "SourcingSearch" (
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
CREATE TABLE IF NOT EXISTS "SourcingCandidate" (
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
CREATE TABLE IF NOT EXISTS "SupplierEvaluation" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "Supplier_number_key" ON "Supplier"("number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Supplier_zohoContactId_key" ON "Supplier"("zohoContactId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Supplier_sourceCandidateId_key" ON "Supplier"("sourceCandidateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Supplier_name_idx" ON "Supplier"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Supplier_status_idx" ON "Supplier"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Supplier_taxRegNo_idx" ON "Supplier"("taxRegNo");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Supplier_commContactId_idx" ON "Supplier"("commContactId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierProduct_zohoItemId_idx" ON "SupplierProduct"("zohoItemId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierProduct_supplierId_zohoItemId_supplierSku_key" ON "SupplierProduct"("supplierId", "zohoItemId", "supplierSku");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseRequest_number_key" ON "PurchaseRequest"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequest_status_createdAt_idx" ON "PurchaseRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequest_status_neededBy_idx" ON "PurchaseRequest"("status", "neededBy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequest_caseId_idx" ON "PurchaseRequest"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequest_requestedByUserId_status_idx" ON "PurchaseRequest"("requestedByUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequest_areaKey_status_idx" ON "PurchaseRequest"("areaKey", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequestLine_requestId_idx" ON "PurchaseRequestLine"("requestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequestLine_demandId_idx" ON "PurchaseRequestLine"("demandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequestLine_allocationId_idx" ON "PurchaseRequestLine"("allocationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequestLine_zohoItemId_status_idx" ON "PurchaseRequestLine"("zohoItemId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequestLine_consolidationKey_status_idx" ON "PurchaseRequestLine"("consolidationKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Rfq_number_key" ON "Rfq"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Rfq_status_dueAt_idx" ON "Rfq"("status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Rfq_status_createdAt_idx" ON "Rfq"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Rfq_createdByUserId_status_idx" ON "Rfq"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Rfq_sourcingSearchId_idx" ON "Rfq"("sourcingSearchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqLine_rfqId_idx" ON "RfqLine"("rfqId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqLine_requestLineId_idx" ON "RfqLine"("requestLineId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqInvitation_rfqId_status_idx" ON "RfqInvitation"("rfqId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqInvitation_supplierId_idx" ON "RfqInvitation"("supplierId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqInvitation_candidateId_idx" ON "RfqInvitation"("candidateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqInvitation_conversationId_idx" ON "RfqInvitation"("conversationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqInvitation_status_sentAt_idx" ON "RfqInvitation"("status", "sentAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqResponse_rfqId_status_idx" ON "RfqResponse"("rfqId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqResponse_invitationId_idx" ON "RfqResponse"("invitationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqResponse_supplierId_createdAt_idx" ON "RfqResponse"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqResponse_candidateId_idx" ON "RfqResponse"("candidateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqResponse_status_createdAt_idx" ON "RfqResponse"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqResponseLine_responseId_idx" ON "RfqResponseLine"("responseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RfqResponseLine_rfqLineId_idx" ON "RfqResponseLine"("rfqLineId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProcurementOrder_number_key" ON "ProcurementOrder"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_status_createdAt_idx" ON "ProcurementOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_status_expectedAt_idx" ON "ProcurementOrder"("status", "expectedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_supplierId_status_idx" ON "ProcurementOrder"("supplierId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_paymentStatus_status_idx" ON "ProcurementOrder"("paymentStatus", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_createdByUserId_status_idx" ON "ProcurementOrder"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_rfqResponseId_idx" ON "ProcurementOrder"("rfqResponseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_obligationId_idx" ON "ProcurementOrder"("obligationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_approvalRequestId_idx" ON "ProcurementOrder"("approvalRequestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_directDeliveryCaseId_idx" ON "ProcurementOrder"("directDeliveryCaseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_warehouseId_status_idx" ON "ProcurementOrder"("warehouseId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_conversationId_idx" ON "ProcurementOrder"("conversationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrder_zohoPurchaseOrderId_idx" ON "ProcurementOrder"("zohoPurchaseOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrderLine_orderId_idx" ON "ProcurementOrderLine"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrderLine_requestLineId_idx" ON "ProcurementOrderLine"("requestLineId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrderLine_zohoItemId_status_idx" ON "ProcurementOrderLine"("zohoItemId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementOrderLine_supplierProductId_idx" ON "ProcurementOrderLine"("supplierProductId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementAllocation_demandId_idx" ON "ProcurementAllocation"("demandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementAllocation_demandAllocationId_idx" ON "ProcurementAllocation"("demandAllocationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementAllocation_requestLineId_idx" ON "ProcurementAllocation"("requestLineId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProcurementAllocation_orderLineId_demandId_key" ON "ProcurementAllocation"("orderLineId", "demandId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "GoodsReceipt_number_key" ON "GoodsReceipt"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoodsReceipt_orderId_idx" ON "GoodsReceipt"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoodsReceipt_status_receivedAt_idx" ON "GoodsReceipt"("status", "receivedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoodsReceipt_receivedByUserId_receivedAt_idx" ON "GoodsReceipt"("receivedByUserId", "receivedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoodsReceipt_warehouseId_receivedAt_idx" ON "GoodsReceipt"("warehouseId", "receivedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_receiptId_idx" ON "GoodsReceiptLine"("receiptId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_orderLineId_idx" ON "GoodsReceiptLine"("orderLineId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_stockMovementId_idx" ON "GoodsReceiptLine"("stockMovementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_incidentId_idx" ON "GoodsReceiptLine"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SourcingSearch_queryHash_key" ON "SourcingSearch"("queryHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingSearch_status_createdAt_idx" ON "SourcingSearch"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingSearch_createdByUserId_createdAt_idx" ON "SourcingSearch"("createdByUserId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingSearch_providerKey_executedAt_idx" ON "SourcingSearch"("providerKey", "executedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingSearch_expiresAt_idx" ON "SourcingSearch"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SourcingCandidate_dedupeKey_key" ON "SourcingCandidate"("dedupeKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingCandidate_searchId_idx" ON "SourcingCandidate"("searchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingCandidate_status_updatedAt_idx" ON "SourcingCandidate"("status", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingCandidate_domain_idx" ON "SourcingCandidate"("domain");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingCandidate_phone_idx" ON "SourcingCandidate"("phone");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingCandidate_supplierId_idx" ON "SourcingCandidate"("supplierId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SourcingCandidate_commContactId_idx" ON "SourcingCandidate"("commContactId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierEvaluation_supplierId_createdAt_idx" ON "SupplierEvaluation"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierEvaluation_orderId_idx" ON "SupplierEvaluation"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierEvaluation_receiptId_idx" ON "SupplierEvaluation"("receiptId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierEvaluation_evaluatedByUserId_idx" ON "SupplierEvaluation"("evaluatedByUserId");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "RfqLine" ADD CONSTRAINT "RfqLine_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "RfqInvitation" ADD CONSTRAINT "RfqInvitation_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "RfqResponse" ADD CONSTRAINT "RfqResponse_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "RfqResponseLine" ADD CONSTRAINT "RfqResponseLine_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "RfqResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "ProcurementOrderLine" ADD CONSTRAINT "ProcurementOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "ProcurementAllocation" ADD CONSTRAINT "ProcurementAllocation_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "ProcurementOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "SupplierEvaluation" ADD CONSTRAINT "SupplierEvaluation_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reconciled from 20260916140100_add_manufacturing.
-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkCenter" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "warehouseId" TEXT,
    "capacityPerShift" DECIMAL(18,4) NOT NULL,
    "capacityUnit" TEXT NOT NULL,
    "shifts" JSONB NOT NULL DEFAULT '[]',
    "costPerHour" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Bom" (
    "id" TEXT NOT NULL,
    "outputZohoItemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "outputQty" DECIMAL(18,4) NOT NULL,
    "outputUnit" TEXT NOT NULL,
    "expectedYield" DECIMAL(5,4),
    "scrapAllowancePct" DECIMAL(6,3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BomLine" (
    "id" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "inputZohoItemId" TEXT NOT NULL,
    "qtyPerOutput" DECIMAL(18,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "substituteZohoItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scrapPct" DECIMAL(6,3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BomLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BomOperation" (
    "id" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "workCenterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stdMinutes" INTEGER NOT NULL,
    "setupMinutes" INTEGER NOT NULL DEFAULT 0,
    "qcRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BomOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductionOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'transformation',
    "bomId" TEXT,
    "caseId" TEXT,
    "demandId" TEXT,
    "demandAllocationId" TEXT,
    "outputZohoItemId" TEXT NOT NULL,
    "outputName" TEXT,
    "plannedQty" DECIMAL(18,4) NOT NULL,
    "plannedUnit" TEXT NOT NULL,
    "producedQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "scrapQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "leftoverQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "plannedStartAt" TIMESTAMP(3),
    "plannedEndAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "workCenterId" TEXT,
    "releaseTarget" TEXT NOT NULL DEFAULT 'inventory',
    "outputWarehouseId" TEXT NOT NULL,
    "outputLocationId" TEXT,
    "blockedReason" TEXT,
    "inputs" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductionOperation" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "workCenterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assignedUserId" TEXT,
    "plannedStartAt" TIMESTAMP(3),
    "plannedMinutes" INTEGER,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "actualMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MaterialConsumption" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "operationId" TEXT,
    "inputZohoItemId" TEXT NOT NULL,
    "stockItemId" TEXT,
    "reservationId" TEXT,
    "qtyPlanned" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "qtyActual" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "substitutedForZohoItemId" TEXT,
    "stockMovementId" TEXT,
    "approvalRequestId" TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductionOutput" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "dimensions" JSONB,
    "stockMovementId" TEXT,
    "stockItemId" TEXT,
    "locationId" TEXT,
    "qualityCheckId" TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "QualityCheck" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "operationId" TEXT,
    "result" TEXT NOT NULL,
    "checklist" JSONB,
    "notes" TEXT,
    "evidenceObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inspectedByUserId" TEXT NOT NULL,
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkCenter_key_key" ON "WorkCenter"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkCenter_status_idx" ON "WorkCenter"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkCenter_warehouseId_idx" ON "WorkCenter"("warehouseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Bom_outputZohoItemId_status_idx" ON "Bom"("outputZohoItemId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Bom_status_idx" ON "Bom"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Bom_outputZohoItemId_version_key" ON "Bom"("outputZohoItemId", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomLine_bomId_idx" ON "BomLine"("bomId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomLine_inputZohoItemId_idx" ON "BomLine"("inputZohoItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomOperation_bomId_seq_idx" ON "BomOperation"("bomId", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BomOperation_workCenterId_idx" ON "BomOperation"("workCenterId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductionOrder_number_key" ON "ProductionOrder"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_status_plannedStartAt_idx" ON "ProductionOrder"("status", "plannedStartAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_status_createdAt_idx" ON "ProductionOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_workCenterId_plannedStartAt_idx" ON "ProductionOrder"("workCenterId", "plannedStartAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_caseId_idx" ON "ProductionOrder"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_demandId_idx" ON "ProductionOrder"("demandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_demandAllocationId_idx" ON "ProductionOrder"("demandAllocationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_bomId_idx" ON "ProductionOrder"("bomId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_outputZohoItemId_status_idx" ON "ProductionOrder"("outputZohoItemId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOrder_createdByUserId_status_idx" ON "ProductionOrder"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOperation_productionOrderId_seq_idx" ON "ProductionOperation"("productionOrderId", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOperation_workCenterId_status_plannedStartAt_idx" ON "ProductionOperation"("workCenterId", "status", "plannedStartAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOperation_assignedUserId_status_idx" ON "ProductionOperation"("assignedUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaterialConsumption_productionOrderId_kind_idx" ON "MaterialConsumption"("productionOrderId", "kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaterialConsumption_operationId_idx" ON "MaterialConsumption"("operationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaterialConsumption_inputZohoItemId_createdAt_idx" ON "MaterialConsumption"("inputZohoItemId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaterialConsumption_reservationId_idx" ON "MaterialConsumption"("reservationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaterialConsumption_stockItemId_idx" ON "MaterialConsumption"("stockItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaterialConsumption_stockMovementId_idx" ON "MaterialConsumption"("stockMovementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MaterialConsumption_approvalRequestId_idx" ON "MaterialConsumption"("approvalRequestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOutput_productionOrderId_kind_idx" ON "ProductionOutput"("productionOrderId", "kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOutput_zohoItemId_createdAt_idx" ON "ProductionOutput"("zohoItemId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOutput_stockMovementId_idx" ON "ProductionOutput"("stockMovementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOutput_stockItemId_idx" ON "ProductionOutput"("stockItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductionOutput_qualityCheckId_idx" ON "ProductionOutput"("qualityCheckId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QualityCheck_productionOrderId_inspectedAt_idx" ON "QualityCheck"("productionOrderId", "inspectedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QualityCheck_operationId_idx" ON "QualityCheck"("operationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QualityCheck_result_inspectedAt_idx" ON "QualityCheck"("result", "inspectedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QualityCheck_inspectedByUserId_inspectedAt_idx" ON "QualityCheck"("inspectedByUserId", "inspectedAt");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "BomOperation" ADD CONSTRAINT "BomOperation_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "ProductionOperation" ADD CONSTRAINT "ProductionOperation_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "MaterialConsumption" ADD CONSTRAINT "MaterialConsumption_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "ProductionOutput" ADD CONSTRAINT "ProductionOutput_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "QualityCheck" ADD CONSTRAINT "QualityCheck_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reconciled from 20260916150000_add_finance.
-- CreateTable
CREATE TABLE IF NOT EXISTS "CashAccount" (
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
CREATE TABLE IF NOT EXISTS "FinanceCategory" (
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
CREATE TABLE IF NOT EXISTS "CostCenter" (
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
CREATE TABLE IF NOT EXISTS "LedgerEntry" (
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
CREATE TABLE IF NOT EXISTS "LedgerLine" (
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
CREATE TABLE IF NOT EXISTS "Obligation" (
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
CREATE TABLE IF NOT EXISTS "ObligationSettlement" (
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
CREATE TABLE IF NOT EXISTS "Expense" (
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
CREATE TABLE IF NOT EXISTS "ExpenseSplit" (
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
CREATE TABLE IF NOT EXISTS "ExpenseTemplate" (
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
CREATE TABLE IF NOT EXISTS "Budget" (
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
CREATE TABLE IF NOT EXISTS "Employee" (
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
CREATE TABLE IF NOT EXISTS "PayrollRun" (
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
CREATE TABLE IF NOT EXISTS "PayrollLine" (
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
CREATE TABLE IF NOT EXISTS "PeriodClose" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "CashAccount_key_key" ON "CashAccount"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CashAccount_status_kind_idx" ON "CashAccount"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FinanceCategory_key_key" ON "FinanceCategory"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FinanceCategory_kind_status_idx" ON "FinanceCategory"("kind", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FinanceCategory_parentId_idx" ON "FinanceCategory"("parentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FinanceCategory_defaultCostCenterId_idx" ON "FinanceCategory"("defaultCostCenterId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CostCenter_key_key" ON "CostCenter"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CostCenter_areaKey_idx" ON "CostCenter"("areaKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CostCenter_parentId_idx" ON "CostCenter"("parentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CostCenter_status_idx" ON "CostCenter"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_number_key" ON "LedgerEntry"("number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_reversesEntryId_key" ON "LedgerEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerEntry_periodKey_idx" ON "LedgerEntry"("periodKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerEntry_sourceType_sourceId_idx" ON "LedgerEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerEntry_kind_date_idx" ON "LedgerEntry"("kind", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerEntry_date_idx" ON "LedgerEntry"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerEntry_postedByUserId_postedAt_idx" ON "LedgerEntry"("postedByUserId", "postedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerLine_accountType_accountId_idx" ON "LedgerLine"("accountType", "accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerLine_caseId_idx" ON "LedgerLine"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerLine_costCenterId_idx" ON "LedgerLine"("costCenterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LedgerLine_procurementOrderId_idx" ON "LedgerLine"("procurementOrderId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerLine_entryId_seq_key" ON "LedgerLine"("entryId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Obligation_number_key" ON "Obligation"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_kind_status_dueAt_idx" ON "Obligation"("kind", "status", "dueAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_zohoSalesOrderId_idx" ON "Obligation"("zohoSalesOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_supplierId_idx" ON "Obligation"("supplierId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_zohoContactId_status_idx" ON "Obligation"("zohoContactId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_employeeId_status_idx" ON "Obligation"("employeeId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_status_expectedCashAt_idx" ON "Obligation"("status", "expectedCashAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_caseId_idx" ON "Obligation"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_procurementOrderId_idx" ON "Obligation"("procurementOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_payrollRunId_idx" ON "Obligation"("payrollRunId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_expenseId_idx" ON "Obligation"("expenseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_zohoInvoiceId_idx" ON "Obligation"("zohoInvoiceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Obligation_ledgerEntryId_idx" ON "Obligation"("ledgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ObligationSettlement_externalRef_key" ON "ObligationSettlement"("externalRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ObligationSettlement_obligationId_settledAt_idx" ON "ObligationSettlement"("obligationId", "settledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ObligationSettlement_ledgerEntryId_idx" ON "ObligationSettlement"("ledgerEntryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ObligationSettlement_cashAccountId_settledAt_idx" ON "ObligationSettlement"("cashAccountId", "settledAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ObligationSettlement_zohoPaymentId_idx" ON "ObligationSettlement"("zohoPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Expense_number_key" ON "Expense"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_duplicateKey_idx" ON "Expense"("duplicateKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_status_date_idx" ON "Expense"("status", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_createdByUserId_status_idx" ON "Expense"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_date_idx" ON "Expense"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_receiptHash_idx" ON "Expense"("receiptHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_duplicateOfId_idx" ON "Expense"("duplicateOfId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_supplierId_date_idx" ON "Expense"("supplierId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_categoryId_date_idx" ON "Expense"("categoryId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_costCenterId_date_idx" ON "Expense"("costCenterId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_approvalRequestId_idx" ON "Expense"("approvalRequestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_templateId_idx" ON "Expense"("templateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Expense_caseId_idx" ON "Expense"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExpenseSplit_expenseId_idx" ON "ExpenseSplit"("expenseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExpenseSplit_costCenterId_idx" ON "ExpenseSplit"("costCenterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExpenseSplit_caseId_idx" ON "ExpenseSplit"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExpenseTemplate_active_nextRunAt_idx" ON "ExpenseTemplate"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExpenseTemplate_createdByUserId_idx" ON "ExpenseTemplate"("createdByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExpenseTemplate_categoryId_idx" ON "ExpenseTemplate"("categoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Budget_costCenterId_periodKey_idx" ON "Budget"("costCenterId", "periodKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Budget_categoryId_periodKey_idx" ON "Budget"("categoryId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Budget_periodKey_costCenterId_categoryId_key" ON "Budget"("periodKey", "costCenterId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_number_key" ON "Employee"("number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_active_name_idx" ON "Employee"("active", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_areaKey_idx" ON "Employee"("areaKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_costCenterId_idx" ON "Employee"("costCenterId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollRun_number_key" ON "PayrollRun"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollRun_periodKey_status_idx" ON "PayrollRun"("periodKey", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollRun_status_createdAt_idx" ON "PayrollRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollRun_approvalRequestId_idx" ON "PayrollRun"("approvalRequestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollRun_createdByUserId_idx" ON "PayrollRun"("createdByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollLine_employeeId_idx" ON "PayrollLine"("employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollLine_obligationId_idx" ON "PayrollLine"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollLine_payrollRunId_employeeId_key" ON "PayrollLine"("payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PeriodClose_kind_status_idx" ON "PeriodClose"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PeriodClose_periodKey_kind_key" ON "PeriodClose"("periodKey", "kind");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "LedgerLine" ADD CONSTRAINT "LedgerLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "ObligationSettlement" ADD CONSTRAINT "ObligationSettlement_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "ExpenseSplit" ADD CONSTRAINT "ExpenseSplit_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reconciled from 20260916150100_add_crm.
-- CreateTable
CREATE TABLE IF NOT EXISTS "PipelineStage" (
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
CREATE TABLE IF NOT EXISTS "Opportunity" (
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
CREATE TABLE IF NOT EXISTS "OpportunityActivity" (
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
CREATE TABLE IF NOT EXISTS "SalesOrderWriteRequest" (
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
CREATE TABLE IF NOT EXISTS "RadarSignal" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_key_key" ON "PipelineStage"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PipelineStage_active_order_idx" ON "PipelineStage"("active", "order");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Opportunity_number_key" ON "Opportunity"("number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_salespersonUserId_status_idx" ON "Opportunity"("salespersonUserId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_commContactId_idx" ON "Opportunity"("commContactId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_zohoContactId_idx" ON "Opportunity"("zohoContactId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_stageId_idx" ON "Opportunity"("stageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_nextActionAt_idx" ON "Opportunity"("nextActionAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_status_lastActivityAt_idx" ON "Opportunity"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_status_expectedCloseAt_idx" ON "Opportunity"("status", "expectedCloseAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_conversationIds_idx" ON "Opportunity" USING GIN ("conversationIds");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_voiceCallIds_idx" ON "Opportunity" USING GIN ("voiceCallIds");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_zohoEstimateIds_idx" ON "Opportunity" USING GIN ("zohoEstimateIds");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_zohoSalesOrderIds_idx" ON "Opportunity" USING GIN ("zohoSalesOrderIds");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Opportunity_caseIds_idx" ON "Opportunity" USING GIN ("caseIds");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OpportunityActivity_opportunityId_at_idx" ON "OpportunityActivity"("opportunityId", "at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OpportunityActivity_refType_refId_idx" ON "OpportunityActivity"("refType", "refId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OpportunityActivity_kind_at_idx" ON "OpportunityActivity"("kind", "at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OpportunityActivity_userId_at_idx" ON "OpportunityActivity"("userId", "at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SalesOrderWriteRequest_requestKey_key" ON "SalesOrderWriteRequest"("requestKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SalesOrderWriteRequest_userId_createdAt_idx" ON "SalesOrderWriteRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SalesOrderWriteRequest_status_createdAt_idx" ON "SalesOrderWriteRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SalesOrderWriteRequest_opportunityId_idx" ON "SalesOrderWriteRequest"("opportunityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SalesOrderWriteRequest_quoteId_idx" ON "SalesOrderWriteRequest"("quoteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SalesOrderWriteRequest_zohoSalesOrderId_idx" ON "SalesOrderWriteRequest"("zohoSalesOrderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RadarSignal_salespersonUserId_status_score_idx" ON "RadarSignal"("salespersonUserId", "status", "score");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RadarSignal_status_expiresAt_idx" ON "RadarSignal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RadarSignal_status_snoozedUntil_idx" ON "RadarSignal"("status", "snoozedUntil");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RadarSignal_opportunityId_idx" ON "RadarSignal"("opportunityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RadarSignal_conversationId_idx" ON "RadarSignal"("conversationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RadarSignal_zohoContactId_idx" ON "RadarSignal"("zohoContactId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RadarSignal_kind_subjectKey_key" ON "RadarSignal"("kind", "subjectKey");

-- AddForeignKey
DO $$
BEGIN
  ALTER TABLE "OpportunityActivity" ADD CONSTRAINT "OpportunityActivity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reconciled from 20260916160000_add_dashboards_control_tower.
-- CreateTable
CREATE TABLE IF NOT EXISTS "DashboardSnapshot" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CtCaseVariant" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "processKey" TEXT NOT NULL,
    "processVersion" INTEGER NOT NULL,
    "variantHash" TEXT NOT NULL,
    "sequence" TEXT[],
    "stepCount" INTEGER NOT NULL,
    "durationMin" INTEGER,
    "conformant" BOOLEAN NOT NULL,
    "violations" JSONB,
    "reworkCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtCaseVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CtStepMetricDaily" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "processKey" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "areaKey" TEXT NOT NULL,
    "started" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "p50ActiveMin" DOUBLE PRECISION,
    "p90ActiveMin" DOUBLE PRECISION,
    "avgActiveMin" DOUBLE PRECISION,
    "p50WaitMin" DOUBLE PRECISION,
    "p90WaitMin" DOUBLE PRECISION,
    "breached" INTEGER NOT NULL DEFAULT 0,
    "reworked" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtStepMetricDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CtHandoffDaily" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "fromAreaKey" TEXT NOT NULL,
    "toAreaKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "p50ResponseMin" DOUBLE PRECISION,
    "p90ResponseMin" DOUBLE PRECISION,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtHandoffDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CtBlockCauseDaily" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "causeType" TEXT NOT NULL,
    "causeKey" TEXT NOT NULL,
    "causeLabel" TEXT NOT NULL,
    "blocks" INTEGER NOT NULL DEFAULT 0,
    "waitMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtBlockCauseDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CtProjectionWatermark" (
    "key" TEXT NOT NULL,
    "lastEventId" BIGINT NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastDurationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtProjectionWatermark_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CtGraphScene" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "perspectiveKey" TEXT NOT NULL,
    "roots" JSONB NOT NULL,
    "filters" JSONB,
    "layout" JSONB,
    "at" TIMESTAMP(3),
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CtGraphScene_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DashboardSnapshot_scopeType_scopeKey_key" ON "DashboardSnapshot"("scopeType", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CtCaseVariant_caseId_key" ON "CtCaseVariant"("caseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtCaseVariant_processKey_variantHash_idx" ON "CtCaseVariant"("processKey", "variantHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtCaseVariant_processKey_processVersion_idx" ON "CtCaseVariant"("processKey", "processVersion");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtStepMetricDaily_processKey_day_idx" ON "CtStepMetricDaily"("processKey", "day");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtStepMetricDaily_areaKey_day_idx" ON "CtStepMetricDaily"("areaKey", "day");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CtStepMetricDaily_day_processKey_stepKey_key" ON "CtStepMetricDaily"("day", "processKey", "stepKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtHandoffDaily_fromAreaKey_day_idx" ON "CtHandoffDaily"("fromAreaKey", "day");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtHandoffDaily_toAreaKey_day_idx" ON "CtHandoffDaily"("toAreaKey", "day");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CtHandoffDaily_day_fromAreaKey_toAreaKey_kind_key" ON "CtHandoffDaily"("day", "fromAreaKey", "toAreaKey", "kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtBlockCauseDaily_causeType_day_idx" ON "CtBlockCauseDaily"("causeType", "day");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CtBlockCauseDaily_day_causeType_causeKey_key" ON "CtBlockCauseDaily"("day", "causeType", "causeKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtGraphScene_userId_idx" ON "CtGraphScene"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CtGraphScene_shared_perspectiveKey_idx" ON "CtGraphScene"("shared", "perspectiveKey");

-- Reconciled from 20260916170400_add_procurement_allocation_direct_delivered.
-- AlterTable
ALTER TABLE "ProcurementAllocation" ADD COLUMN IF NOT EXISTS "directDeliveredQty" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- Reconciled from 20260916180000_add_approval_policy_expiry.
-- Per-policy exception for the global approval deadline. NULL keeps the policy
-- on the Operations configuration default (initially 24 hours).
ALTER TABLE "ApprovalPolicy"
  ADD COLUMN IF NOT EXISTS "expiresAfterMinutes" INTEGER;

DO $$
BEGIN
  ALTER TABLE "ApprovalPolicy"
    ADD CONSTRAINT "ApprovalPolicy_expiresAfterMinutes_allowed"
    CHECK (
      "expiresAfterMinutes" IS NULL OR
      "expiresAfterMinutes" IN (30, 60, 120, 360, 720, 1440, 2880, 4320, 10080)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reconciled from 20260916184500_add_delivery_container_scans.
-- Physical container scans for loading and dispatch. Additive only; the
-- delivery record remains the authoritative proof of customer receipt.
CREATE TABLE IF NOT EXISTS "DeliveryContainerScan" (
    "id" TEXT NOT NULL,
    "deliveryOrderId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "containerKey" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "scannedBy" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "commandId" TEXT,

    CONSTRAINT "DeliveryContainerScan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryContainerScan_deliveryOrderId_stockItemId_phase_key"
ON "DeliveryContainerScan"("deliveryOrderId", "stockItemId", "phase");

CREATE INDEX IF NOT EXISTS "DeliveryContainerScan_deliveryOrderId_phase_scannedAt_idx"
ON "DeliveryContainerScan"("deliveryOrderId", "phase", "scannedAt");

CREATE INDEX IF NOT EXISTS "DeliveryContainerScan_stockItemId_scannedAt_idx"
ON "DeliveryContainerScan"("stockItemId", "scannedAt");

CREATE INDEX IF NOT EXISTS "DeliveryContainerScan_commandId_idx"
ON "DeliveryContainerScan"("commandId");

-- Agent identity layer can also have been recorded without completing its DDL.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "botKind" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isBot" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "internal_chat_message" ADD COLUMN IF NOT EXISTS "meta" JSONB;
ALTER TABLE "AiProposal" ADD COLUMN IF NOT EXISTS "approverScope" JSONB;
ALTER TABLE "AiProposal" ADD COLUMN IF NOT EXISTS "secondDecidedAt" TIMESTAMP(3);
ALTER TABLE "AiProposal" ADD COLUMN IF NOT EXISTS "secondDecisionBy" TEXT;
ALTER TABLE "AiUserPreference" ADD COLUMN IF NOT EXISTS "surfaceModes" JSONB;

CREATE TABLE IF NOT EXISTS "AgentIdentity" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "areaKey" TEXT,
    "displayName" TEXT NOT NULL,
    "botUserId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'active',
    "dailyTokenBudget" INTEGER NOT NULL DEFAULT 150000,
    "monthlyCostBudgetUsd" DECIMAL(10,4) NOT NULL DEFAULT 40,
    "maxTurnsPerCasePerDay" INTEGER NOT NULL DEFAULT 4,
    "quietHours" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AgentIdentity_key_key" ON "AgentIdentity"("key");
CREATE UNIQUE INDEX IF NOT EXISTS "AgentIdentity_areaKey_key" ON "AgentIdentity"("areaKey");
CREATE UNIQUE INDEX IF NOT EXISTS "AgentIdentity_botUserId_key" ON "AgentIdentity"("botUserId");
CREATE INDEX IF NOT EXISTS "AgentIdentity_kind_mode_idx" ON "AgentIdentity"("kind", "mode");

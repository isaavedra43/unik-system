-- CreateTable
CREATE TABLE "WorkCenter" (
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
CREATE TABLE "Bom" (
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
CREATE TABLE "BomLine" (
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
CREATE TABLE "BomOperation" (
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
CREATE TABLE "ProductionOrder" (
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
CREATE TABLE "ProductionOperation" (
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
CREATE TABLE "MaterialConsumption" (
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
CREATE TABLE "ProductionOutput" (
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
CREATE TABLE "QualityCheck" (
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
CREATE UNIQUE INDEX "WorkCenter_key_key" ON "WorkCenter"("key");

-- CreateIndex
CREATE INDEX "WorkCenter_status_idx" ON "WorkCenter"("status");

-- CreateIndex
CREATE INDEX "WorkCenter_warehouseId_idx" ON "WorkCenter"("warehouseId");

-- CreateIndex
CREATE INDEX "Bom_outputZohoItemId_status_idx" ON "Bom"("outputZohoItemId", "status");

-- CreateIndex
CREATE INDEX "Bom_status_idx" ON "Bom"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Bom_outputZohoItemId_version_key" ON "Bom"("outputZohoItemId", "version");

-- CreateIndex
CREATE INDEX "BomLine_bomId_idx" ON "BomLine"("bomId");

-- CreateIndex
CREATE INDEX "BomLine_inputZohoItemId_idx" ON "BomLine"("inputZohoItemId");

-- CreateIndex
CREATE INDEX "BomOperation_bomId_seq_idx" ON "BomOperation"("bomId", "seq");

-- CreateIndex
CREATE INDEX "BomOperation_workCenterId_idx" ON "BomOperation"("workCenterId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_number_key" ON "ProductionOrder"("number");

-- CreateIndex
CREATE INDEX "ProductionOrder_status_plannedStartAt_idx" ON "ProductionOrder"("status", "plannedStartAt");

-- CreateIndex
CREATE INDEX "ProductionOrder_status_createdAt_idx" ON "ProductionOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProductionOrder_workCenterId_plannedStartAt_idx" ON "ProductionOrder"("workCenterId", "plannedStartAt");

-- CreateIndex
CREATE INDEX "ProductionOrder_caseId_idx" ON "ProductionOrder"("caseId");

-- CreateIndex
CREATE INDEX "ProductionOrder_demandId_idx" ON "ProductionOrder"("demandId");

-- CreateIndex
CREATE INDEX "ProductionOrder_demandAllocationId_idx" ON "ProductionOrder"("demandAllocationId");

-- CreateIndex
CREATE INDEX "ProductionOrder_bomId_idx" ON "ProductionOrder"("bomId");

-- CreateIndex
CREATE INDEX "ProductionOrder_outputZohoItemId_status_idx" ON "ProductionOrder"("outputZohoItemId", "status");

-- CreateIndex
CREATE INDEX "ProductionOrder_createdByUserId_status_idx" ON "ProductionOrder"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX "ProductionOperation_productionOrderId_seq_idx" ON "ProductionOperation"("productionOrderId", "seq");

-- CreateIndex
CREATE INDEX "ProductionOperation_workCenterId_status_plannedStartAt_idx" ON "ProductionOperation"("workCenterId", "status", "plannedStartAt");

-- CreateIndex
CREATE INDEX "ProductionOperation_assignedUserId_status_idx" ON "ProductionOperation"("assignedUserId", "status");

-- CreateIndex
CREATE INDEX "MaterialConsumption_productionOrderId_kind_idx" ON "MaterialConsumption"("productionOrderId", "kind");

-- CreateIndex
CREATE INDEX "MaterialConsumption_operationId_idx" ON "MaterialConsumption"("operationId");

-- CreateIndex
CREATE INDEX "MaterialConsumption_inputZohoItemId_createdAt_idx" ON "MaterialConsumption"("inputZohoItemId", "createdAt");

-- CreateIndex
CREATE INDEX "MaterialConsumption_reservationId_idx" ON "MaterialConsumption"("reservationId");

-- CreateIndex
CREATE INDEX "MaterialConsumption_stockItemId_idx" ON "MaterialConsumption"("stockItemId");

-- CreateIndex
CREATE INDEX "MaterialConsumption_stockMovementId_idx" ON "MaterialConsumption"("stockMovementId");

-- CreateIndex
CREATE INDEX "MaterialConsumption_approvalRequestId_idx" ON "MaterialConsumption"("approvalRequestId");

-- CreateIndex
CREATE INDEX "ProductionOutput_productionOrderId_kind_idx" ON "ProductionOutput"("productionOrderId", "kind");

-- CreateIndex
CREATE INDEX "ProductionOutput_zohoItemId_createdAt_idx" ON "ProductionOutput"("zohoItemId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductionOutput_stockMovementId_idx" ON "ProductionOutput"("stockMovementId");

-- CreateIndex
CREATE INDEX "ProductionOutput_stockItemId_idx" ON "ProductionOutput"("stockItemId");

-- CreateIndex
CREATE INDEX "ProductionOutput_qualityCheckId_idx" ON "ProductionOutput"("qualityCheckId");

-- CreateIndex
CREATE INDEX "QualityCheck_productionOrderId_inspectedAt_idx" ON "QualityCheck"("productionOrderId", "inspectedAt");

-- CreateIndex
CREATE INDEX "QualityCheck_operationId_idx" ON "QualityCheck"("operationId");

-- CreateIndex
CREATE INDEX "QualityCheck_result_inspectedAt_idx" ON "QualityCheck"("result", "inspectedAt");

-- CreateIndex
CREATE INDEX "QualityCheck_inspectedByUserId_inspectedAt_idx" ON "QualityCheck"("inspectedByUserId", "inspectedAt");

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomOperation" ADD CONSTRAINT "BomOperation_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOperation" ADD CONSTRAINT "ProductionOperation_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialConsumption" ADD CONSTRAINT "MaterialConsumption_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOutput" ADD CONSTRAINT "ProductionOutput_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityCheck" ADD CONSTRAINT "QualityCheck_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;


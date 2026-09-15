-- CreateTable
CREATE TABLE "Warehouse" (
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
CREATE TABLE "StorageLocation" (
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
CREATE TABLE "ProductInventoryProfile" (
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
CREATE TABLE "StockItem" (
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
CREATE TABLE "StockMovement" (
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
CREATE TABLE "StockReservation" (
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
CREATE TABLE "StockCount" (
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
CREATE TABLE "StockCountLine" (
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
CREATE TABLE "LegacyCommitmentClaim" (
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
CREATE TABLE "Vehicle" (
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
CREATE TABLE "Driver" (
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
CREATE TABLE "DeliveryOrder" (
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
CREATE TABLE "Trip" (
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
CREATE TABLE "TripStop" (
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
CREATE TABLE "DeliveryEvidence" (
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
CREATE UNIQUE INDEX "Warehouse_key_key" ON "Warehouse"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_zohoLocationId_key" ON "Warehouse"("zohoLocationId");

-- CreateIndex
CREATE INDEX "Warehouse_active_idx" ON "Warehouse"("active");

-- CreateIndex
CREATE INDEX "StorageLocation_warehouseId_active_idx" ON "StorageLocation"("warehouseId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_warehouseId_code_key" ON "StorageLocation"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProductInventoryProfile_zohoItemId_key" ON "ProductInventoryProfile"("zohoItemId");

-- CreateIndex
CREATE INDEX "ProductInventoryProfile_confidence_idx" ON "ProductInventoryProfile"("confidence");

-- CreateIndex
CREATE INDEX "ProductInventoryProfile_trackingPolicy_idx" ON "ProductInventoryProfile"("trackingPolicy");

-- CreateIndex
CREATE INDEX "StockItem_warehouseId_locationId_idx" ON "StockItem"("warehouseId", "locationId");

-- CreateIndex
CREATE INDEX "StockItem_originProductionOrderId_idx" ON "StockItem"("originProductionOrderId");

-- CreateIndex
CREATE INDEX "StockItem_containerKey_idx" ON "StockItem"("containerKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_zohoItemId_warehouseId_locationId_variantKey_cont_key" ON "StockItem"("zohoItemId", "warehouseId", "locationId", "variantKey", "containerKey");

-- CreateIndex
CREATE INDEX "StockMovement_stockItemId_occurredAt_idx" ON "StockMovement"("stockItemId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_referenceType_referenceId_idx" ON "StockMovement"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "StockMovement_zohoItemId_warehouseId_occurredAt_idx" ON "StockMovement"("zohoItemId", "warehouseId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_kind_occurredAt_idx" ON "StockMovement"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_commandId_idx" ON "StockMovement"("commandId");

-- CreateIndex
CREATE INDEX "StockReservation_stockItemId_status_idx" ON "StockReservation"("stockItemId", "status");

-- CreateIndex
CREATE INDEX "StockReservation_zohoItemId_warehouseId_status_idx" ON "StockReservation"("zohoItemId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "StockReservation_caseId_idx" ON "StockReservation"("caseId");

-- CreateIndex
CREATE INDEX "StockReservation_demandId_idx" ON "StockReservation"("demandId");

-- CreateIndex
CREATE INDEX "StockReservation_allocationId_idx" ON "StockReservation"("allocationId");

-- CreateIndex
CREATE INDEX "StockReservation_status_createdAt_idx" ON "StockReservation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StockCount_warehouseId_status_idx" ON "StockCount"("warehouseId", "status");

-- CreateIndex
CREATE INDEX "StockCount_status_createdAt_idx" ON "StockCount"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StockCount_startedBy_idx" ON "StockCount"("startedBy");

-- CreateIndex
CREATE INDEX "StockCountLine_stockItemId_countedAt_idx" ON "StockCountLine"("stockItemId", "countedAt");

-- CreateIndex
CREATE INDEX "StockCountLine_resolution_idx" ON "StockCountLine"("resolution");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_stockItemId_key" ON "StockCountLine"("countId", "stockItemId");

-- CreateIndex
CREATE INDEX "LegacyCommitmentClaim_zohoItemId_warehouseId_status_idx" ON "LegacyCommitmentClaim"("zohoItemId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "LegacyCommitmentClaim_status_expiresAt_idx" ON "LegacyCommitmentClaim"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "LegacyCommitmentClaim_caseId_idx" ON "LegacyCommitmentClaim"("caseId");

-- CreateIndex
CREATE INDEX "LegacyCommitmentClaim_claimedBy_status_idx" ON "LegacyCommitmentClaim"("claimedBy", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_code_key" ON "Vehicle"("code");

-- CreateIndex
CREATE INDEX "Vehicle_active_idx" ON "Vehicle"("active");

-- CreateIndex
CREATE INDEX "Vehicle_plate_idx" ON "Vehicle"("plate");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");

-- CreateIndex
CREATE INDEX "Driver_active_idx" ON "Driver"("active");

-- CreateIndex
CREATE INDEX "DeliveryOrder_caseId_idx" ON "DeliveryOrder"("caseId");

-- CreateIndex
CREATE INDEX "DeliveryOrder_status_plannedDate_idx" ON "DeliveryOrder"("status", "plannedDate");

-- CreateIndex
CREATE INDEX "DeliveryOrder_tripId_idx" ON "DeliveryOrder"("tripId");

-- CreateIndex
CREATE INDEX "DeliveryOrder_zohoPackageId_idx" ON "DeliveryOrder"("zohoPackageId");

-- CreateIndex
CREATE INDEX "DeliveryOrder_packageId_idx" ON "DeliveryOrder"("packageId");

-- CreateIndex
CREATE INDEX "DeliveryOrder_zohoSyncState_zohoLastAttemptAt_idx" ON "DeliveryOrder"("zohoSyncState", "zohoLastAttemptAt");

-- CreateIndex
CREATE INDEX "DeliveryOrder_parentDeliveryOrderId_idx" ON "DeliveryOrder"("parentDeliveryOrderId");

-- CreateIndex
CREATE INDEX "DeliveryOrder_driverId_plannedDate_idx" ON "DeliveryOrder"("driverId", "plannedDate");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_number_key" ON "Trip"("number");

-- CreateIndex
CREATE INDEX "Trip_date_status_idx" ON "Trip"("date", "status");

-- CreateIndex
CREATE INDEX "Trip_driverId_date_idx" ON "Trip"("driverId", "date");

-- CreateIndex
CREATE INDEX "Trip_vehicleId_date_idx" ON "Trip"("vehicleId", "date");

-- CreateIndex
CREATE INDEX "Trip_status_idx" ON "Trip"("status");

-- CreateIndex
CREATE INDEX "TripStop_tripId_sequence_idx" ON "TripStop"("tripId", "sequence");

-- CreateIndex
CREATE INDEX "TripStop_deliveryOrderId_idx" ON "TripStop"("deliveryOrderId");

-- CreateIndex
CREATE INDEX "TripStop_status_idx" ON "TripStop"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TripStop_tripId_deliveryOrderId_key" ON "TripStop"("tripId", "deliveryOrderId");

-- CreateIndex
CREATE INDEX "DeliveryEvidence_deliveryOrderId_createdAt_idx" ON "DeliveryEvidence"("deliveryOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryEvidence_storageObjectId_idx" ON "DeliveryEvidence"("storageObjectId");

-- CreateIndex
CREATE INDEX "DeliveryEvidence_commandId_idx" ON "DeliveryEvidence"("commandId");

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripStop" ADD CONSTRAINT "TripStop_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;


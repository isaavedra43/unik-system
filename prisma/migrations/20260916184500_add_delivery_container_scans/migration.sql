-- Physical container scans for loading and dispatch. Additive only; the
-- delivery record remains the authoritative proof of customer receipt.
CREATE TABLE "DeliveryContainerScan" (
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

CREATE UNIQUE INDEX "DeliveryContainerScan_deliveryOrderId_stockItemId_phase_key"
ON "DeliveryContainerScan"("deliveryOrderId", "stockItemId", "phase");

CREATE INDEX "DeliveryContainerScan_deliveryOrderId_phase_scannedAt_idx"
ON "DeliveryContainerScan"("deliveryOrderId", "phase", "scannedAt");

CREATE INDEX "DeliveryContainerScan_stockItemId_scannedAt_idx"
ON "DeliveryContainerScan"("stockItemId", "scannedAt");

CREATE INDEX "DeliveryContainerScan_commandId_idx"
ON "DeliveryContainerScan"("commandId");

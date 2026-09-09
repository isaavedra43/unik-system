-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "zohoPackageId" TEXT NOT NULL,
    "packageNumber" TEXT,
    "status" TEXT,
    "date" TIMESTAMP(3),
    "shipmentType" TEXT,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "deliveryMethod" TEXT,
    "shippingCharge" DECIMAL(18,4),
    "zohoSalesOrderId" TEXT,
    "zohoCustomerId" TEXT,
    "customerName" TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Package_zohoPackageId_key" ON "Package"("zohoPackageId");

-- CreateIndex
CREATE INDEX "Package_status_idx" ON "Package"("status");

-- CreateIndex
CREATE INDEX "Package_zohoSalesOrderId_idx" ON "Package"("zohoSalesOrderId");

-- CreateIndex
CREATE INDEX "Package_zohoCustomerId_idx" ON "Package"("zohoCustomerId");

-- CreateIndex
CREATE INDEX "Package_sourceSnapshotId_idx" ON "Package"("sourceSnapshotId");

-- CreateTable
CREATE TABLE "PackageItem" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "zohoItemId" TEXT,
    "name" TEXT,
    "sku" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(18,4),
    "unit" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PackageItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PackageItem_packageId_idx" ON "PackageItem"("packageId");

-- CreateIndex
CREATE INDEX "PackageItem_zohoItemId_idx" ON "PackageItem"("zohoItemId");

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE;

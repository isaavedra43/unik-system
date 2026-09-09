-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "zohoItemId" TEXT NOT NULL,
    "name" TEXT,
    "sku" TEXT,
    "status" TEXT,
    "productType" TEXT,
    "description" TEXT,
    "rate" DECIMAL(18,4),
    "unit" TEXT,
    "currencyCode" TEXT,
    "taxName" TEXT,
    "taxPercentage" DECIMAL(18,4),
    "isTaxable" BOOLEAN,
    "stockOnHand" DECIMAL(18,4),
    "availableStock" DECIMAL(18,4),
    "reorderLevel" DECIMAL(18,4),
    "purchaseRate" DECIMAL(18,4),
    "categoryName" TEXT,
    "categoryId" TEXT,
    "manufacturer" TEXT,
    "brand" TEXT,
    "zohoVendorId" TEXT,
    "vendorName" TEXT,
    "satProductCode" TEXT,
    "satUnitCode" TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_zohoItemId_key" ON "Product"("zohoItemId");

-- CreateIndex
CREATE INDEX "Product_name_idx" ON "Product"("name");

-- CreateIndex
CREATE INDEX "Product_sku_idx" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_status_idx" ON "Product"("status");

-- CreateIndex
CREATE INDEX "Product_categoryName_idx" ON "Product"("categoryName");

-- CreateIndex
CREATE INDEX "Product_sourceSnapshotId_idx" ON "Product"("sourceSnapshotId");

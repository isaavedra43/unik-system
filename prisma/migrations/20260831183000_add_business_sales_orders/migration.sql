-- AlterTable
ALTER TABLE "IntegrationSnapshot" ADD COLUMN     "normalizationErrorCode" TEXT,
ADD COLUMN     "normalizationVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "normalizedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL,
    "zohoSalesOrderId" TEXT NOT NULL,
    "salesOrderNumber" TEXT,
    "referenceNumber" TEXT,
    "orderDate" DATE,
    "createdTime" TIMESTAMP(3),
    "status" TEXT,
    "subStatus" TEXT,
    "paidStatus" TEXT,
    "invoicedStatus" TEXT,
    "shippedStatus" TEXT,
    "zohoCustomerId" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "zohoSalespersonId" TEXT,
    "salespersonName" TEXT,
    "paymentMethod" TEXT,
    "deliveryMethod" TEXT,
    "deliveryMethodId" TEXT,
    "locationId" TEXT,
    "locationName" TEXT,
    "branchId" TEXT,
    "branchName" TEXT,
    "shippingAttention" TEXT,
    "shippingAddressLine1" TEXT,
    "shippingAddressLine2" TEXT,
    "shippingCity" TEXT,
    "shippingState" TEXT,
    "shippingPostalCode" TEXT,
    "shippingCountry" TEXT,
    "shippingPhone" TEXT,
    "currencyCode" TEXT,
    "subtotal" DECIMAL(18,4),
    "discountTotal" DECIMAL(18,4),
    "taxTotal" DECIMAL(18,4),
    "shippingCharge" DECIMAL(18,4),
    "adjustment" DECIMAL(18,4),
    "total" DECIMAL(18,4),
    "balance" DECIMAL(18,4),
    "notes" TEXT,
    "saleMadeInWarehouse" BOOLEAN,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderItem" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "zohoLineItemId" TEXT,
    "zohoItemId" TEXT,
    "sku" TEXT,
    "name" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(18,4),
    "unit" TEXT,
    "rate" DECIMAL(18,4),
    "discountAmount" DECIMAL(18,4),
    "taxName" TEXT,
    "taxPercentage" DECIMAL(18,4),
    "taxAmount" DECIMAL(18,4),
    "lineTotal" DECIMAL(18,4),
    "locationId" TEXT,
    "locationName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_zohoSalesOrderId_key" ON "SalesOrder"("zohoSalesOrderId");

-- CreateIndex
CREATE INDEX "SalesOrder_salesOrderNumber_idx" ON "SalesOrder"("salesOrderNumber");

-- CreateIndex
CREATE INDEX "SalesOrder_status_idx" ON "SalesOrder"("status");

-- CreateIndex
CREATE INDEX "SalesOrder_customerName_idx" ON "SalesOrder"("customerName");

-- CreateIndex
CREATE INDEX "SalesOrder_paymentMethod_idx" ON "SalesOrder"("paymentMethod");

-- CreateIndex
CREATE INDEX "SalesOrder_deliveryMethod_idx" ON "SalesOrder"("deliveryMethod");

-- CreateIndex
CREATE INDEX "SalesOrder_salespersonName_idx" ON "SalesOrder"("salespersonName");

-- CreateIndex
CREATE INDEX "SalesOrder_orderDate_idx" ON "SalesOrder"("orderDate");

-- CreateIndex
CREATE INDEX "SalesOrder_locationName_idx" ON "SalesOrder"("locationName");

-- CreateIndex
CREATE INDEX "SalesOrder_sourceSnapshotId_idx" ON "SalesOrder"("sourceSnapshotId");

-- CreateIndex
CREATE INDEX "SalesOrderItem_salesOrderId_idx" ON "SalesOrderItem"("salesOrderId");

-- CreateIndex
CREATE INDEX "IntegrationSnapshot_source_entityType_normalizationVersion_idx" ON "IntegrationSnapshot"("source", "entityType", "normalizationVersion");

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;


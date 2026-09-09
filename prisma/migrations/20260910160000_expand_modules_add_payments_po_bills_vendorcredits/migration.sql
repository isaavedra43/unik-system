-- Migration: Expand existing modules + add CustomerPayments, PurchaseOrders, Bills, VendorCredits
-- Additive only: no DROP TABLE, no DROP COLUMN

-- =====================================================
-- 1. Contact: add address, contact person, and additional fields
-- =====================================================
ALTER TABLE "Contact" ADD COLUMN "billingAddress" TEXT;
ALTER TABLE "Contact" ADD COLUMN "billingCity" TEXT;
ALTER TABLE "Contact" ADD COLUMN "billingState" TEXT;
ALTER TABLE "Contact" ADD COLUMN "billingZip" TEXT;
ALTER TABLE "Contact" ADD COLUMN "billingCountry" TEXT;
ALTER TABLE "Contact" ADD COLUMN "billingFax" TEXT;
ALTER TABLE "Contact" ADD COLUMN "shippingAddress" TEXT;
ALTER TABLE "Contact" ADD COLUMN "shippingCity" TEXT;
ALTER TABLE "Contact" ADD COLUMN "shippingState" TEXT;
ALTER TABLE "Contact" ADD COLUMN "shippingZip" TEXT;
ALTER TABLE "Contact" ADD COLUMN "shippingCountry" TEXT;
ALTER TABLE "Contact" ADD COLUMN "shippingFax" TEXT;
ALTER TABLE "Contact" ADD COLUMN "firstName" TEXT;
ALTER TABLE "Contact" ADD COLUMN "lastName" TEXT;
ALTER TABLE "Contact" ADD COLUMN "mobile" TEXT;
ALTER TABLE "Contact" ADD COLUMN "designation" TEXT;
ALTER TABLE "Contact" ADD COLUMN "department" TEXT;
ALTER TABLE "Contact" ADD COLUMN "customerSubType" TEXT;
ALTER TABLE "Contact" ADD COLUMN "portalStatus" TEXT;
ALTER TABLE "Contact" ADD COLUMN "ownerName" TEXT;
ALTER TABLE "Contact" ADD COLUMN "source" TEXT;
ALTER TABLE "Contact" ADD COLUMN "photoUrl" TEXT;
ALTER TABLE "Contact" ADD COLUMN "primaryContactId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "creditLimitExceededAmount" DECIMAL(18,4);
ALTER TABLE "Contact" ADD COLUMN "notes" TEXT;

-- =====================================================
-- 2. Product: add additional Zoho fields
-- =====================================================
ALTER TABLE "Product" ADD COLUMN "itemType" TEXT;
ALTER TABLE "Product" ADD COLUMN "source" TEXT;
ALTER TABLE "Product" ADD COLUMN "taxPreference" TEXT;
ALTER TABLE "Product" ADD COLUMN "purchaseTaxName" TEXT;
ALTER TABLE "Product" ADD COLUMN "purchaseAccountName" TEXT;
ALTER TABLE "Product" ADD COLUMN "salesAccountName" TEXT;
ALTER TABLE "Product" ADD COLUMN "inventoryAccountName" TEXT;
ALTER TABLE "Product" ADD COLUMN "inventoryValuationMethod" TEXT;
ALTER TABLE "Product" ADD COLUMN "zohoCreatedTime" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN "zohoLastModifiedTime" TIMESTAMP(3);

-- =====================================================
-- 3. Package: add shipping address and additional fields
-- =====================================================
ALTER TABLE "Package" ADD COLUMN "shippingAttention" TEXT;
ALTER TABLE "Package" ADD COLUMN "shippingAddress" TEXT;
ALTER TABLE "Package" ADD COLUMN "shippingCity" TEXT;
ALTER TABLE "Package" ADD COLUMN "shippingState" TEXT;
ALTER TABLE "Package" ADD COLUMN "shippingZip" TEXT;
ALTER TABLE "Package" ADD COLUMN "shippingCountry" TEXT;
ALTER TABLE "Package" ADD COLUMN "shippingPhone" TEXT;
ALTER TABLE "Package" ADD COLUMN "shipmentDate" TIMESTAMP(3);
ALTER TABLE "Package" ADD COLUMN "shipmentStatus" TEXT;
ALTER TABLE "Package" ADD COLUMN "isCarrierShipment" BOOLEAN;
ALTER TABLE "Package" ADD COLUMN "isTrackingEnabled" BOOLEAN;
ALTER TABLE "Package" ADD COLUMN "labelFormat" TEXT;
ALTER TABLE "Package" ADD COLUMN "salesChannel" TEXT;
ALTER TABLE "Package" ADD COLUMN "salesorderNumber" TEXT;
ALTER TABLE "Package" ADD COLUMN "quantity" DECIMAL(18,4);
ALTER TABLE "Package" ADD COLUMN "lastDetailFetchedAt" TIMESTAMP(3);

-- =====================================================
-- 4. Invoice: add address and additional fields
-- =====================================================
ALTER TABLE "Invoice" ADD COLUMN "billingAddress" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billingCity" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billingState" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billingZip" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "billingCountry" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "shippingAddress" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "shippingCity" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "shippingState" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "shippingZip" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "shippingCountry" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "notes" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "terms" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "referenceNumber" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "exchangeRate" DECIMAL(18,6);
ALTER TABLE "Invoice" ADD COLUMN "discount" DECIMAL(18,4);
ALTER TABLE "Invoice" ADD COLUMN "discountType" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "isDiscountBeforeTax" BOOLEAN;
ALTER TABLE "Invoice" ADD COLUMN "zohoCreatedTime" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "zohoLastModifiedTime" TIMESTAMP(3);

-- =====================================================
-- 5. CustomerPayment: new table
-- =====================================================
CREATE TABLE "CustomerPayment" (
    "id"                     TEXT NOT NULL,
    "zohoPaymentId"          TEXT NOT NULL,
    "paymentNumber"          TEXT,
    "paymentMode"            TEXT,
    "status"                 TEXT,
    "date"                   TIMESTAMP(3),
    "amount"                 DECIMAL(18,4),
    "balance"                DECIMAL(18,4),
    "zohoCustomerId"         TEXT,
    "customerName"           TEXT,
    "currencyCode"           TEXT,
    "referenceNumber"        TEXT,
    "description"            TEXT,
    "exchangeRate"           DECIMAL(18,6),
    "bankCharges"            DECIMAL(18,4),
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId"       TEXT NOT NULL,
    "normalizedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerPayment_zohoPaymentId_key" ON "CustomerPayment"("zohoPaymentId");
CREATE INDEX "CustomerPayment_zohoCustomerId_idx" ON "CustomerPayment"("zohoCustomerId");
CREATE INDEX "CustomerPayment_date_idx" ON "CustomerPayment"("date");
CREATE INDEX "CustomerPayment_status_idx" ON "CustomerPayment"("status");
CREATE INDEX "CustomerPayment_sourceSnapshotId_idx" ON "CustomerPayment"("sourceSnapshotId");

-- =====================================================
-- 6. PurchaseOrder + PurchaseOrderItem: new tables
-- =====================================================
CREATE TABLE "PurchaseOrder" (
    "id"                     TEXT NOT NULL,
    "zohoPurchaseOrderId"    TEXT NOT NULL,
    "purchaseOrderNumber"    TEXT,
    "status"                 TEXT,
    "date"                   TIMESTAMP(3),
    "dueDate"                TIMESTAMP(3),
    "deliveryDate"           TIMESTAMP(3),
    "zohoVendorId"           TEXT,
    "vendorName"             TEXT,
    "currencyCode"           TEXT,
    "subTotal"               DECIMAL(18,4),
    "taxTotal"               DECIMAL(18,4),
    "discountTotal"          DECIMAL(18,4),
    "shippingCharge"         DECIMAL(18,4),
    "total"                  DECIMAL(18,4),
    "balance"                DECIMAL(18,4),
    "salespersonName"        TEXT,
    "notes"                  TEXT,
    "referenceNumber"        TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId"       TEXT NOT NULL,
    "normalizedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PurchaseOrder_zohoPurchaseOrderId_key" ON "PurchaseOrder"("zohoPurchaseOrderId");
CREATE INDEX "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");
CREATE INDEX "PurchaseOrder_zohoVendorId_idx" ON "PurchaseOrder"("zohoVendorId");
CREATE INDEX "PurchaseOrder_date_idx" ON "PurchaseOrder"("date");
CREATE INDEX "PurchaseOrder_sourceSnapshotId_idx" ON "PurchaseOrder"("sourceSnapshotId");

CREATE TABLE "PurchaseOrderItem" (
    "id"              TEXT NOT NULL,
    "purchaseOrderId"  TEXT NOT NULL,
    "zohoItemId"      TEXT,
    "name"            TEXT,
    "description"     TEXT,
    "quantity"        DECIMAL(18,4),
    "rate"            DECIMAL(18,4),
    "unit"            TEXT,
    "lineTotal"       DECIMAL(18,4),
    "taxName"         TEXT,
    "taxPercentage"   DECIMAL(18,4),
    "taxAmount"       DECIMAL(18,4),
    "sortOrder"       INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId");
CREATE INDEX "PurchaseOrderItem_zohoItemId_idx" ON "PurchaseOrderItem"("zohoItemId");
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE;

-- =====================================================
-- 7. Bill: new table
-- =====================================================
CREATE TABLE "Bill" (
    "id"                     TEXT NOT NULL,
    "zohoBillId"             TEXT NOT NULL,
    "billNumber"             TEXT,
    "status"                 TEXT,
    "date"                   TIMESTAMP(3),
    "dueDate"                TIMESTAMP(3),
    "zohoVendorId"           TEXT,
    "vendorName"             TEXT,
    "zohoPurchaseOrderId"    TEXT,
    "currencyCode"           TEXT,
    "subTotal"               DECIMAL(18,4),
    "taxTotal"               DECIMAL(18,4),
    "total"                  DECIMAL(18,4),
    "balance"                DECIMAL(18,4),
    "vendorCreditsApplied"   DECIMAL(18,4),
    "notes"                  TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId"       TEXT NOT NULL,
    "normalizedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Bill_zohoBillId_key" ON "Bill"("zohoBillId");
CREATE INDEX "Bill_status_idx" ON "Bill"("status");
CREATE INDEX "Bill_zohoVendorId_idx" ON "Bill"("zohoVendorId");
CREATE INDEX "Bill_zohoPurchaseOrderId_idx" ON "Bill"("zohoPurchaseOrderId");
CREATE INDEX "Bill_date_idx" ON "Bill"("date");
CREATE INDEX "Bill_sourceSnapshotId_idx" ON "Bill"("sourceSnapshotId");

-- =====================================================
-- 8. VendorCredit: new table
-- =====================================================
CREATE TABLE "VendorCredit" (
    "id"                     TEXT NOT NULL,
    "zohoVendorCreditId"     TEXT NOT NULL,
    "vendorCreditNumber"     TEXT,
    "status"                 TEXT,
    "date"                   TIMESTAMP(3),
    "zohoVendorId"           TEXT,
    "vendorName"             TEXT,
    "currencyCode"           TEXT,
    "total"                  DECIMAL(18,4),
    "balance"                DECIMAL(18,4),
    "notes"                  TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId"       TEXT NOT NULL,
    "normalizedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorCredit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VendorCredit_zohoVendorCreditId_key" ON "VendorCredit"("zohoVendorCreditId");
CREATE INDEX "VendorCredit_status_idx" ON "VendorCredit"("status");
CREATE INDEX "VendorCredit_zohoVendorId_idx" ON "VendorCredit"("zohoVendorId");
CREATE INDEX "VendorCredit_date_idx" ON "VendorCredit"("date");
CREATE INDEX "VendorCredit_sourceSnapshotId_idx" ON "VendorCredit"("sourceSnapshotId");

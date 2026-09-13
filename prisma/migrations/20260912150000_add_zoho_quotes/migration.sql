-- Zoho Books estimates (cotizaciones) synced + created from UNIK.

CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "zohoEstimateId" TEXT NOT NULL,
    "estimateNumber" TEXT,
    "referenceNumber" TEXT,
    "status" TEXT,
    "date" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "zohoCustomerId" TEXT,
    "customerName" TEXT,
    "currencyId" TEXT,
    "currencyCode" TEXT,
    "exchangeRate" DECIMAL(18,6),
    "subTotal" DECIMAL(18,4),
    "taxTotal" DECIMAL(18,4),
    "discountTotal" DECIMAL(18,4),
    "discount" DECIMAL(18,4),
    "discountType" TEXT,
    "isDiscountBeforeTax" BOOLEAN,
    "isInclusiveTax" BOOLEAN,
    "shippingCharge" DECIMAL(18,4),
    "adjustment" DECIMAL(18,4),
    "adjustmentDescription" TEXT,
    "total" DECIMAL(18,4),
    "salespersonId" TEXT,
    "salespersonName" TEXT,
    "templateId" TEXT,
    "templateName" TEXT,
    "billingAddress" TEXT,
    "billingStreet2" TEXT,
    "billingCity" TEXT,
    "billingState" TEXT,
    "billingZip" TEXT,
    "billingCountry" TEXT,
    "shippingAddress" TEXT,
    "shippingStreet2" TEXT,
    "shippingCity" TEXT,
    "shippingState" TEXT,
    "shippingZip" TEXT,
    "shippingCountry" TEXT,
    "notes" TEXT,
    "terms" TEXT,
    "customFields" JSONB,
    "isViewedByClient" BOOLEAN,
    "acceptedDate" TIMESTAMP(3),
    "declinedDate" TIMESTAMP(3),
    "zohoCreatedTime" TIMESTAMP(3),
    "zohoLastModifiedTime" TIMESTAMP(3),
    "createdInUnik" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "lastEditedByUserId" TEXT,
    "lastEditedInUnikAt" TIMESTAMP(3),
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Quote_zohoEstimateId_key" ON "Quote"("zohoEstimateId");
CREATE INDEX "Quote_status_idx" ON "Quote"("status");
CREATE INDEX "Quote_zohoCustomerId_idx" ON "Quote"("zohoCustomerId");
CREATE INDEX "Quote_date_idx" ON "Quote"("date");
CREATE INDEX "Quote_expiryDate_idx" ON "Quote"("expiryDate");
CREATE INDEX "Quote_estimateNumber_idx" ON "Quote"("estimateNumber");
CREATE INDEX "Quote_sourceSnapshotId_idx" ON "Quote"("sourceSnapshotId");

CREATE TABLE "QuoteItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "zohoLineItemId" TEXT,
    "zohoItemId" TEXT,
    "sku" TEXT,
    "name" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(18,4),
    "rate" DECIMAL(18,4),
    "unit" TEXT,
    "discount" TEXT,
    "discountAmount" DECIMAL(18,4),
    "taxId" TEXT,
    "taxName" TEXT,
    "taxPercentage" DECIMAL(18,4),
    "taxAmount" DECIMAL(18,4),
    "lineTotal" DECIMAL(18,4),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");
CREATE INDEX "QuoteItem_zohoItemId_idx" ON "QuoteItem"("zohoItemId");

ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "QuoteWriteRequest" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quoteId" TEXT,
    "zohoEstimateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "QuoteWriteRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuoteWriteRequest_requestKey_key" ON "QuoteWriteRequest"("requestKey");
CREATE INDEX "QuoteWriteRequest_userId_createdAt_idx" ON "QuoteWriteRequest"("userId", "createdAt");
CREATE INDEX "QuoteWriteRequest_status_createdAt_idx" ON "QuoteWriteRequest"("status", "createdAt");

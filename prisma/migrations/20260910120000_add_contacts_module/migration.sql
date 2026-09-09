-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "zohoContactId" TEXT NOT NULL,
    "contactType" TEXT,
    "contactName" TEXT,
    "companyName" TEXT,
    "currencyCode" TEXT,
    "paymentTerms" INTEGER,
    "paymentTermsLabel" TEXT,
    "status" TEXT,
    "outstandingReceivable" DECIMAL(18,4),
    "outstandingPayable" DECIMAL(18,4),
    "unusedCreditsReceivable" DECIMAL(18,4),
    "unusedCreditsPayable" DECIMAL(18,4),
    "primaryEmail" TEXT,
    "primaryPhone" TEXT,
    "website" TEXT,
    "languageCode" TEXT,
    "taxRegNo" TEXT,
    "taxTreatment" TEXT,
    "taxRegime" TEXT,
    "legalName" TEXT,
    "isTdsRegistered" BOOLEAN,
    "sourceRemoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "sourceSnapshotId" TEXT NOT NULL,
    "normalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_zohoContactId_key" ON "Contact"("zohoContactId");

-- CreateIndex
CREATE INDEX "Contact_contactType_idx" ON "Contact"("contactType");

-- CreateIndex
CREATE INDEX "Contact_contactName_idx" ON "Contact"("contactName");

-- CreateIndex
CREATE INDEX "Contact_companyName_idx" ON "Contact"("companyName");

-- CreateIndex
CREATE INDEX "Contact_status_idx" ON "Contact"("status");

-- CreateIndex
CREATE INDEX "Contact_sourceSnapshotId_idx" ON "Contact"("sourceSnapshotId");

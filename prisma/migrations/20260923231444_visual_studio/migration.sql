-- DropForeignKey
ALTER TABLE "InvoiceItem" DROP CONSTRAINT "InvoiceItem_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "PackageItem" DROP CONSTRAINT "PackageItem_packageId_fkey";

-- DropForeignKey
ALTER TABLE "PurchaseOrderItem" DROP CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey";

-- AlterTable
ALTER TABLE "internal_chat_config" ALTER COLUMN "id" SET DEFAULT 'singleton',
ALTER COLUMN "value" DROP DEFAULT;

-- CreateTable
CREATE TABLE "VisualProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "contactId" TEXT,
    "quoteId" TEXT,
    "salesOrderId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "label" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualSurface" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "maskObjectId" TEXT NOT NULL,
    "promptSpec" JSONB NOT NULL,
    "maskHistory" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualSurface_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualProposal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "surfaceId" TEXT,
    "productId" TEXT,
    "mode" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "providerJobId" TEXT,
    "costCredits" DECIMAL(12,4),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultObjectId" TEXT,
    "error" TEXT,
    "version" INTEGER NOT NULL,
    "generationParams" JSONB,
    "selectedAt" TIMESTAMP(3),
    "selectedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMedia" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'reference',
    "label" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisualProject_status_idx" ON "VisualProject"("status");

-- CreateIndex
CREATE INDEX "VisualProject_contactId_idx" ON "VisualProject"("contactId");

-- CreateIndex
CREATE INDEX "VisualProject_quoteId_idx" ON "VisualProject"("quoteId");

-- CreateIndex
CREATE INDEX "VisualProject_createdById_idx" ON "VisualProject"("createdById");

-- CreateIndex
CREATE INDEX "VisualAsset_projectId_kind_idx" ON "VisualAsset"("projectId", "kind");

-- CreateIndex
CREATE INDEX "VisualAsset_objectId_idx" ON "VisualAsset"("objectId");

-- CreateIndex
CREATE INDEX "VisualSurface_projectId_idx" ON "VisualSurface"("projectId");

-- CreateIndex
CREATE INDEX "VisualSurface_assetId_idx" ON "VisualSurface"("assetId");

-- CreateIndex
CREATE INDEX "VisualProposal_projectId_version_idx" ON "VisualProposal"("projectId", "version");

-- CreateIndex
CREATE INDEX "VisualProposal_status_idx" ON "VisualProposal"("status");

-- CreateIndex
CREATE INDEX "VisualProposal_providerJobId_idx" ON "VisualProposal"("providerJobId");

-- CreateIndex
CREATE INDEX "VisualProposal_productId_idx" ON "VisualProposal"("productId");

-- CreateIndex
CREATE INDEX "ProductMedia_productId_idx" ON "ProductMedia"("productId");

-- CreateIndex
CREATE INDEX "ProductMedia_objectId_idx" ON "ProductMedia"("objectId");

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAttachment" ADD CONSTRAINT "AiAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AiMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProject" ADD CONSTRAINT "VisualProject_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProject" ADD CONSTRAINT "VisualProject_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProject" ADD CONSTRAINT "VisualProject_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProject" ADD CONSTRAINT "VisualProject_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VisualProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "StorageObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSurface" ADD CONSTRAINT "VisualSurface_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VisualProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSurface" ADD CONSTRAINT "VisualSurface_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "VisualAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSurface" ADD CONSTRAINT "VisualSurface_maskObjectId_fkey" FOREIGN KEY ("maskObjectId") REFERENCES "StorageObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSurface" ADD CONSTRAINT "VisualSurface_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VisualProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_surfaceId_fkey" FOREIGN KEY ("surfaceId") REFERENCES "VisualSurface"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_resultObjectId_fkey" FOREIGN KEY ("resultObjectId") REFERENCES "StorageObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "StorageObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "IntegrationEntityState_source_entityType_needsSync_remoteModifi" RENAME TO "IntegrationEntityState_source_entityType_needsSync_remoteMo_idx";

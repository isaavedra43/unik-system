-- Visual Studio module. Idempotent + production-safe:
--  - IF NOT EXISTS on every CREATE (safe re-run after a partial/failed attempt)
--  - Foreign keys added NOT VALID inside pg_constraint guards: existing rows are
--    never re-validated (synced data may contain orphans); new writes ARE enforced.
--  - Renames/alters guarded so they no-op when the object is missing or renamed.

-- DropForeignKey (idempotent)
ALTER TABLE "InvoiceItem" DROP CONSTRAINT IF EXISTS "InvoiceItem_invoiceId_fkey";
ALTER TABLE "PackageItem" DROP CONSTRAINT IF EXISTS "PackageItem_packageId_fkey";
ALTER TABLE "PurchaseOrderItem" DROP CONSTRAINT IF EXISTS "PurchaseOrderItem_purchaseOrderId_fkey";

-- AlterTable (only if the columns exist)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'internal_chat_config' AND column_name = 'id'
  ) THEN
    ALTER TABLE "internal_chat_config" ALTER COLUMN "id" SET DEFAULT 'singleton';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'internal_chat_config' AND column_name = 'value'
  ) THEN
    ALTER TABLE "internal_chat_config" ALTER COLUMN "value" DROP DEFAULT;
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "VisualProject" (
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
CREATE TABLE IF NOT EXISTS "VisualAsset" (
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
CREATE TABLE IF NOT EXISTS "VisualSurface" (
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
CREATE TABLE IF NOT EXISTS "VisualProposal" (
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
CREATE TABLE IF NOT EXISTS "ProductMedia" (
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
CREATE INDEX IF NOT EXISTS "VisualProject_status_idx" ON "VisualProject"("status");
CREATE INDEX IF NOT EXISTS "VisualProject_contactId_idx" ON "VisualProject"("contactId");
CREATE INDEX IF NOT EXISTS "VisualProject_quoteId_idx" ON "VisualProject"("quoteId");
CREATE INDEX IF NOT EXISTS "VisualProject_createdById_idx" ON "VisualProject"("createdById");
CREATE INDEX IF NOT EXISTS "VisualAsset_projectId_kind_idx" ON "VisualAsset"("projectId", "kind");
CREATE INDEX IF NOT EXISTS "VisualAsset_objectId_idx" ON "VisualAsset"("objectId");
CREATE INDEX IF NOT EXISTS "VisualSurface_projectId_idx" ON "VisualSurface"("projectId");
CREATE INDEX IF NOT EXISTS "VisualSurface_assetId_idx" ON "VisualSurface"("assetId");
CREATE INDEX IF NOT EXISTS "VisualProposal_projectId_version_idx" ON "VisualProposal"("projectId", "version");
CREATE INDEX IF NOT EXISTS "VisualProposal_status_idx" ON "VisualProposal"("status");
CREATE INDEX IF NOT EXISTS "VisualProposal_providerJobId_idx" ON "VisualProposal"("providerJobId");
CREATE INDEX IF NOT EXISTS "VisualProposal_productId_idx" ON "VisualProposal"("productId");
CREATE INDEX IF NOT EXISTS "ProductMedia_productId_idx" ON "ProductMedia"("productId");
CREATE INDEX IF NOT EXISTS "ProductMedia_objectId_idx" ON "ProductMedia"("objectId");

-- Foreign keys: added NOT VALID so synced production data can never block the
-- deploy. The constraint still enforces every new insert/update; existing
-- orphans are left in place (they were already there, invisible to the app).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PackageItem_packageId_fkey') THEN
    ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceItem_invoiceId_fkey') THEN
    ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrderItem_purchaseOrderId_fkey') THEN
    ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiAttachment_messageId_fkey') THEN
    ALTER TABLE "AiAttachment" ADD CONSTRAINT "AiAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AiMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProject_contactId_fkey') THEN
    ALTER TABLE "VisualProject" ADD CONSTRAINT "VisualProject_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProject_quoteId_fkey') THEN
    ALTER TABLE "VisualProject" ADD CONSTRAINT "VisualProject_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProject_salesOrderId_fkey') THEN
    ALTER TABLE "VisualProject" ADD CONSTRAINT "VisualProject_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProject_createdById_fkey') THEN
    ALTER TABLE "VisualProject" ADD CONSTRAINT "VisualProject_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualAsset_projectId_fkey') THEN
    ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VisualProject"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualAsset_objectId_fkey') THEN
    ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "StorageObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualAsset_createdById_fkey') THEN
    ALTER TABLE "VisualAsset" ADD CONSTRAINT "VisualAsset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualSurface_projectId_fkey') THEN
    ALTER TABLE "VisualSurface" ADD CONSTRAINT "VisualSurface_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VisualProject"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualSurface_assetId_fkey') THEN
    ALTER TABLE "VisualSurface" ADD CONSTRAINT "VisualSurface_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "VisualAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualSurface_maskObjectId_fkey') THEN
    ALTER TABLE "VisualSurface" ADD CONSTRAINT "VisualSurface_maskObjectId_fkey" FOREIGN KEY ("maskObjectId") REFERENCES "StorageObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualSurface_createdById_fkey') THEN
    ALTER TABLE "VisualSurface" ADD CONSTRAINT "VisualSurface_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProposal_projectId_fkey') THEN
    ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VisualProject"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProposal_surfaceId_fkey') THEN
    ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_surfaceId_fkey" FOREIGN KEY ("surfaceId") REFERENCES "VisualSurface"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProposal_productId_fkey') THEN
    ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProposal_resultObjectId_fkey') THEN
    ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_resultObjectId_fkey" FOREIGN KEY ("resultObjectId") REFERENCES "StorageObject"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VisualProposal_createdById_fkey') THEN
    ALTER TABLE "VisualProposal" ADD CONSTRAINT "VisualProposal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProductMedia_productId_fkey') THEN
    ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProductMedia_objectId_fkey') THEN
    ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "StorageObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProductMedia_createdById_fkey') THEN
    ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

-- RenameIndex (only when the old index exists and the new one does not)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'IntegrationEntityState_source_entityType_needsSync_remoteModifi' AND relkind = 'i')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'IntegrationEntityState_source_entityType_needsSync_remoteMo_idx' AND relkind = 'i') THEN
    ALTER INDEX "IntegrationEntityState_source_entityType_needsSync_remoteModifi" RENAME TO "IntegrationEntityState_source_entityType_needsSync_remoteMo_idx";
  END IF;
END $$;

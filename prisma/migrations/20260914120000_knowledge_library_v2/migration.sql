-- Approved library v2: shareable-document hints, expiry and file metadata per version. Additive only.

ALTER TABLE "KnowledgeSource" ADD COLUMN "useWhen" TEXT;
ALTER TABLE "KnowledgeSource" ADD COLUMN "category" TEXT;
ALTER TABLE "KnowledgeSource" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "KnowledgeSource_category_idx" ON "KnowledgeSource"("category");

ALTER TABLE "KnowledgeSourceVersion" ADD COLUMN "fileName" TEXT;
ALTER TABLE "KnowledgeSourceVersion" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "KnowledgeSourceVersion" ADD COLUMN "sizeBytes" INTEGER;
ALTER TABLE "KnowledgeSourceVersion" ADD COLUMN "pageCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KnowledgeSourceVersion" ADD COLUMN "autoApprove" BOOLEAN NOT NULL DEFAULT false;

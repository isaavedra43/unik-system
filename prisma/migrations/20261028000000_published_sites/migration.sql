-- Published sites (UNIVERSO): websites the agents build and publish at
-- /sites/{slug}. Additive + idempotent: IF NOT EXISTS everywhere, no foreign
-- keys (ownerUserId is enforced in the service layer), no data rewrites.

-- CreateTable
CREATE TABLE IF NOT EXISTS "PublishedSite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "agentId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "files" JSONB NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'published',
    "visits" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishedSite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PublishedSite_slug_key" ON "PublishedSite"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublishedSite_ownerUserId_updatedAt_idx" ON "PublishedSite"("ownerUserId", "updatedAt");

-- CreateTable
CREATE TABLE "ComposioToolkitPolicy" (
    "id" TEXT NOT NULL,
    "toolkitSlug" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "allowedRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effectOverrides" JSONB NOT NULL DEFAULT '{}',
    "disabledTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComposioToolkitPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComposioToolkitPolicy_toolkitSlug_key" ON "ComposioToolkitPolicy"("toolkitSlug");

-- CreateIndex
CREATE INDEX "ComposioToolkitPolicy_enabled_idx" ON "ComposioToolkitPolicy"("enabled");


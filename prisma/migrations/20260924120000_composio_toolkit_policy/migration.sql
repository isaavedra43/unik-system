-- Composio toolkit governance. Additive + re-runnable (AGENTS.md → Migraciones):
-- every statement no-ops when the object already exists, so a re-run after a
-- failed deploy converges instead of aborting.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ComposioToolkitPolicy" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "ComposioToolkitPolicy_toolkitSlug_key" ON "ComposioToolkitPolicy"("toolkitSlug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ComposioToolkitPolicy_enabled_idx" ON "ComposioToolkitPolicy"("enabled");

-- UNIVERSO: runtime multiagente — Tenant, Agent(+Version/Grant), AgentRun/Task/Event,
-- AgentMessage, Workspace/Lease, Trigger + columnas tenantId/agentId en tablas
-- existentes. Aditiva e idempotente: IF NOT EXISTS en todo, sin FKs nuevas
-- (acoplamiento flojo por convención del módulo) — segura de re-correr.

-- AlterTable
ALTER TABLE "AiConversation" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "AiToolCall" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "AiApiCall" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeSource" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "VenueSession" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "BrowserProfile" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "AgentEpisode" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "AgentFact" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "AgentPlaybook" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Mission" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "parentMissionId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- AlterTable
ALTER TABLE "VenuePlaybook" ADD COLUMN IF NOT EXISTS "agentId" TEXT,
ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TenantMembership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Agent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'unik',
    "ownerUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'specialist',
    "name" TEXT NOT NULL,
    "purpose" TEXT,
    "persona" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "currentVersionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "autonomy" TEXT NOT NULL DEFAULT 'approval',
    "venuePolicy" TEXT NOT NULL DEFAULT 'shared',
    "modelDefault" TEXT,
    "toolAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budgetUsd" DECIMAL(10,2),
    "budgetPeriod" TEXT NOT NULL DEFAULT 'month',
    "maxSpawnDepth" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentVersion" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "modelPolicy" JSONB,
    "toolPolicy" JSONB,
    "memoryPolicy" JSONB,
    "workspacePolicy" JSONB,
    "approvalPolicy" JSONB,
    "maxDelegations" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentGrant" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'allow',
    "limits" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'unik',
    "agentId" TEXT NOT NULL,
    "agentVersionId" TEXT,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "parentRunId" TEXT,
    "rootRunId" TEXT NOT NULL,
    "taskId" TEXT,
    "missionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "route" TEXT,
    "modelId" TEXT,
    "reasoningEffort" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "modelCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "toolsCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "venueCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "deadlineAt" TIMESTAMP(3),
    "traceId" TEXT NOT NULL,
    "runtime" TEXT NOT NULL DEFAULT 'LEGACY',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'unik',
    "rootRunId" TEXT NOT NULL,
    "parentRunId" TEXT NOT NULL,
    "assignedAgentId" TEXT,
    "objective" TEXT NOT NULL,
    "capsule" JSONB NOT NULL,
    "expectedOutput" JSONB,
    "allowedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "forbiddenTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budgetUsd" DECIMAL(10,2),
    "deadlineAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "evidence" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "spanId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'unik',
    "fromAgentId" TEXT NOT NULL,
    "toAgentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'report',
    "summary" TEXT NOT NULL,
    "payload" JSONB,
    "conversationId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Workspace" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'unik',
    "agentId" TEXT,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'shared',
    "venueSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkspaceLease" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "venueSessionId" TEXT,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Trigger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'unik',
    "agentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trigger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Tenant_status_idx" ON "Tenant"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TenantMembership_userId_idx" ON "TenantMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TenantMembership_tenantId_userId_key" ON "TenantMembership"("tenantId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Agent_tenantId_ownerUserId_status_sortOrder_idx" ON "Agent"("tenantId", "ownerUserId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Agent_ownerUserId_kind_idx" ON "Agent"("ownerUserId", "kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentVersion_agentId_createdAt_idx" ON "AgentVersion"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentGrant_agentId_capability_key" ON "AgentGrant"("agentId", "capability");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRun_tenantId_agentId_startedAt_idx" ON "AgentRun"("tenantId", "agentId", "startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRun_rootRunId_idx" ON "AgentRun"("rootRunId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRun_status_startedAt_idx" ON "AgentRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRun_conversationId_idx" ON "AgentRun"("conversationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentTask_rootRunId_status_idx" ON "AgentTask"("rootRunId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentTask_status_idx" ON "AgentTask"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentTask_assignedAgentId_idx" ON "AgentTask"("assignedAgentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentEvent_runId_createdAt_idx" ON "AgentEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentEvent_type_createdAt_idx" ON "AgentEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentMessage_tenantId_toAgentId_readAt_idx" ON "AgentMessage"("tenantId", "toAgentId", "readAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentMessage_conversationId_createdAt_idx" ON "AgentMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Workspace_tenantId_agentId_idx" ON "Workspace"("tenantId", "agentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Workspace_userId_kind_status_idx" ON "Workspace"("userId", "kind", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkspaceLease_agentRunId_idx" ON "WorkspaceLease"("agentRunId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkspaceLease_workspaceId_releasedAt_idx" ON "WorkspaceLease"("workspaceId", "releasedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trigger_enabled_nextRunAt_idx" ON "Trigger"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trigger_tenantId_agentId_idx" ON "Trigger"("tenantId", "agentId");


-- Tenant semilla: toda la data existente vive en 'unik' hasta que llegue la
-- segunda empresa (las columnas tenantId quedan NULL y se resuelven como
-- 'unik' en la capa de aplicación vía DEFAULT_TENANT).
INSERT INTO "Tenant" ("id", "name", "slug", "status", "createdAt")
SELECT 'unik', 'UNIK', 'unik', 'active', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Tenant" WHERE "id" = 'unik');

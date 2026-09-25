-- Agent memory (episodic/semantic/procedural), missions, and venue playbooks.
-- Additive + idempotent: IF NOT EXISTS everywhere; the FK is guarded and
-- NOT VALID so it can never fail on existing data.

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentEpisode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "summary" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "entities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "toolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "importance" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentFact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "attribute" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'observation',
    "sourceRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentPlaybook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsTemplate" JSONB NOT NULL,
    "note" TEXT,
    "successCount" INTEGER NOT NULL DEFAULT 1,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPlaybook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Mission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "plan" JSONB,
    "budgetUsd" DECIMAL(10,2),
    "spentUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "schedule" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "venueSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MissionEvent" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "VenuePlaybook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "params" JSONB,
    "requiresHost" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenuePlaybook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentEpisode_userId_createdAt_idx" ON "AgentEpisode"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentEpisode_userId_importance_idx" ON "AgentEpisode"("userId", "importance");
CREATE INDEX IF NOT EXISTS "AgentFact_userId_status_entity_idx" ON "AgentFact"("userId", "status", "entity");
CREATE INDEX IF NOT EXISTS "AgentFact_userId_entity_attribute_idx" ON "AgentFact"("userId", "entity", "attribute");
CREATE INDEX IF NOT EXISTS "AgentPlaybook_userId_successCount_idx" ON "AgentPlaybook"("userId", "successCount");
CREATE INDEX IF NOT EXISTS "AgentPlaybook_userId_trigger_idx" ON "AgentPlaybook"("userId", "trigger");
CREATE INDEX IF NOT EXISTS "Mission_userId_status_idx" ON "Mission"("userId", "status");
CREATE INDEX IF NOT EXISTS "Mission_status_nextRunAt_idx" ON "Mission"("status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "MissionEvent_missionId_createdAt_idx" ON "MissionEvent"("missionId", "createdAt");
CREATE INDEX IF NOT EXISTS "VenuePlaybook_userId_status_idx" ON "VenuePlaybook"("userId", "status");

-- AddForeignKey (guarded + NOT VALID)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MissionEvent_missionId_fkey') THEN
    ALTER TABLE "MissionEvent" ADD CONSTRAINT "MissionEvent_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

-- Agents layer (plan UNIK Neural Operations, Grupo A, migración 2).
-- Additive only: nullable/defaulted ADD COLUMN on User, internal_chat_message, AiProposal,
-- AiUserPreference, plus CREATE TABLE AgentIdentity with its indexes. No DROP, no data changes.
-- AiProposal.status gains the value awaiting_second_approval (String column, no DDL needed).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "botKind" TEXT,
ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "internal_chat_message" ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "AiProposal" ADD COLUMN     "approverScope" JSONB,
ADD COLUMN     "secondDecidedAt" TIMESTAMP(3),
ADD COLUMN     "secondDecisionBy" TEXT;

-- AlterTable
ALTER TABLE "AiUserPreference" ADD COLUMN     "surfaceModes" JSONB;

-- CreateTable
CREATE TABLE "AgentIdentity" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "areaKey" TEXT,
    "displayName" TEXT NOT NULL,
    "botUserId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'active',
    "dailyTokenBudget" INTEGER NOT NULL DEFAULT 150000,
    "monthlyCostBudgetUsd" DECIMAL(10,4) NOT NULL DEFAULT 40,
    "maxTurnsPerCasePerDay" INTEGER NOT NULL DEFAULT 4,
    "quietHours" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdentity_key_key" ON "AgentIdentity"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdentity_areaKey_key" ON "AgentIdentity"("areaKey");

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdentity_botUserId_key" ON "AgentIdentity"("botUserId");

-- CreateIndex
CREATE INDEX "AgentIdentity_kind_mode_idx" ON "AgentIdentity"("kind", "mode");


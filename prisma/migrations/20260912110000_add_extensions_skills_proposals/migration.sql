-- Extensions runtime: MCP servers, custom APIs, plugins, skills, connections,
-- proposals (approvals), execution audit and usage meters.
-- ADDITIVE ONLY: new tables and indexes. No DROP, no data rewrite.

-- CreateTable
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currentVersionId" TEXT,
    "allowedRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedPorts" INTEGER[] DEFAULT ARRAY[443]::INTEGER[],
    "config" JSONB,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionVersion" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reviewNotes" TEXT,
    "publishedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "lastTestedAt" TIMESTAMP(3),
    "lastTestResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtensionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionCapability" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "localName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "outputSchema" JSONB,
    "schemaHash" TEXT NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'read',
    "approvalPolicy" TEXT NOT NULL DEFAULT 'require_approval',
    "dataScope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredPermission" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 15000,
    "maxResultBytes" INTEGER NOT NULL DEFAULT 65536,
    "connectionScope" TEXT NOT NULL DEFAULT 'none',
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "remoteChanged" BOOLEAN NOT NULL DEFAULT false,
    "operation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtensionCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionConnection" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "keyId" TEXT,
    "secretCiphertext" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "refreshLockedUntil" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtensionConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProposal" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "userId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolVersion" TEXT,
    "capabilityId" TEXT,
    "connectionId" TEXT,
    "argsHash" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "recipient" TEXT,
    "fileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contextHash" TEXT,
    "effect" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decisionBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionExecution" (
    "id" TEXT NOT NULL,
    "extensionId" TEXT,
    "capabilityId" TEXT,
    "connectionId" TEXT,
    "userId" TEXT,
    "toolName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "requestBytes" INTEGER NOT NULL DEFAULT 0,
    "responseBytes" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "proposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "extensionId" TEXT,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillRun" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "skillVersion" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "inputs" JSONB NOT NULL,
    "state" JSONB NOT NULL,
    "currentStep" TEXT,
    "proposalId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SkillRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageMeter" (
    "id" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageMeter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Extension_namespace_key" ON "Extension"("namespace");

-- CreateIndex
CREATE INDEX "Extension_kind_status_idx" ON "Extension"("kind", "status");

-- CreateIndex
CREATE INDEX "ExtensionVersion_extensionId_status_idx" ON "ExtensionVersion"("extensionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionVersion_extensionId_version_key" ON "ExtensionVersion"("extensionId", "version");

-- CreateIndex
CREATE INDEX "ExtensionCapability_extensionId_enabled_idx" ON "ExtensionCapability"("extensionId", "enabled");

-- CreateIndex
CREATE INDEX "ExtensionCapability_name_idx" ON "ExtensionCapability"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionCapability_versionId_localName_key" ON "ExtensionCapability"("versionId", "localName");

-- CreateIndex
CREATE INDEX "ExtensionConnection_extensionId_scopeType_idx" ON "ExtensionConnection"("extensionId", "scopeType");

-- CreateIndex
CREATE INDEX "ExtensionConnection_ownerUserId_idx" ON "ExtensionConnection"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_state_key" ON "OAuthState"("state");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "AiProposal_userId_status_idx" ON "AiProposal"("userId", "status");

-- CreateIndex
CREATE INDEX "AiProposal_conversationId_idx" ON "AiProposal"("conversationId");

-- CreateIndex
CREATE INDEX "AiProposal_status_expiresAt_idx" ON "AiProposal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ExtensionExecution_extensionId_createdAt_idx" ON "ExtensionExecution"("extensionId", "createdAt");

-- CreateIndex
CREATE INDEX "ExtensionExecution_userId_createdAt_idx" ON "ExtensionExecution"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ExtensionExecution_status_createdAt_idx" ON "ExtensionExecution"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_key_key" ON "Skill"("key");

-- CreateIndex
CREATE INDEX "Skill_ownerUserId_scope_idx" ON "Skill"("ownerUserId", "scope");

-- CreateIndex
CREATE INDEX "Skill_status_scope_idx" ON "Skill"("status", "scope");

-- CreateIndex
CREATE INDEX "SkillRun_skillId_status_idx" ON "SkillRun"("skillId", "status");

-- CreateIndex
CREATE INDEX "SkillRun_userId_createdAt_idx" ON "SkillRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SkillRun_proposalId_idx" ON "SkillRun"("proposalId");

-- CreateIndex
CREATE INDEX "UsageMeter_dimension_period_idx" ON "UsageMeter"("dimension", "period");

-- CreateIndex
CREATE UNIQUE INDEX "UsageMeter_dimension_key_period_unit_key" ON "UsageMeter"("dimension", "key", "period", "unit");

-- AddForeignKey
ALTER TABLE "ExtensionVersion" ADD CONSTRAINT "ExtensionVersion_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionCapability" ADD CONSTRAINT "ExtensionCapability_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionCapability" ADD CONSTRAINT "ExtensionCapability_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ExtensionVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionConnection" ADD CONSTRAINT "ExtensionConnection_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionExecution" ADD CONSTRAINT "ExtensionExecution_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRun" ADD CONSTRAINT "SkillRun_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Copilot personalization + memory + approved knowledge library, visual
-- studio (documents, versions, templates, exports), omnichannel
-- communications (accounts, contacts, conversations, messages, notes,
-- responsibles, internal requests, quotes, commitments, consent, campaigns)
-- and voice (LiveKit calls, participants, transcript segments, supervision).
-- ADDITIVE ONLY: new tables and indexes. No DROP, no data rewrite.

-- CreateTable
CREATE TABLE "AiUserPreference" (
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'on_request',
    "tone" TEXT NOT NULL DEFAULT 'profesional',
    "language" TEXT NOT NULL DEFAULT 'es',
    "depth" TEXT NOT NULL DEFAULT 'normal',
    "format" TEXT NOT NULL DEFAULT 'markdown',
    "customInstructions" TEXT,
    "memoryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUserPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AiMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currentVersionId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSourceVersion" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageObjectId" TEXT,
    "sourceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "sha256" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeSourceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "section" TEXT,
    "content" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioDocument" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'document',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "currentVersionId" TEXT,
    "approvedVersionId" TEXT,
    "templateId" TEXT,
    "conversationId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sharedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudioDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioDocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageObjectId" TEXT,
    "changeSummary" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'document',
    "description" TEXT,
    "content" JSONB NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "ownerUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'published',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudioTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioExport" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "storageObjectId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "verification" JSONB,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "StudioExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommAccount" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "connectionId" TEXT,
    "teamKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "webhookSecret" TEXT,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommContact" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "phone" TEXT,
    "telegramId" TEXT,
    "email" TEXT,
    "zohoContactId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "duplicateOfId" TEXT,
    "duplicateReviewStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommConversation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedToUserId" TEXT,
    "subject" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "externalId" TEXT,
    "body" TEXT,
    "mediaObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "sentByUserId" TEXT,
    "proposalId" TEXT,
    "campaignId" TEXT,
    "templateKey" TEXT,
    "providerMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "CommMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommNote" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Responsible" (
    "id" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "backupUserId" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Responsible_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalRequest" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "requesterUserId" TEXT NOT NULL,
    "assigneeUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "dueAt" TIMESTAMP(3),
    "fileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "commConversationId" TEXT,
    "aiConversationId" TEXT,
    "contactId" TEXT,
    "dossier" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "InternalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalRequestEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "actorUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "number" TEXT,
    "customerName" TEXT NOT NULL,
    "contactId" TEXT,
    "zohoCustomerId" TEXT,
    "items" JSONB NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT,
    "zohoEstimateId" TEXT,
    "documentId" TEXT,
    "requestId" TEXT,
    "proposalId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "invalidationReason" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commitment" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "contactId" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "sourceId" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Commitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "audienceSnapshot" JSONB,
    "contentSnapshot" JSONB,
    "budgetLimit" DECIMAL(18,4),
    "budgetSpent" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "costPerMessage" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "batchSize" INTEGER NOT NULL DEFAULT 500,
    "ratePerMinute" INTEGER NOT NULL DEFAULT 60,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "stats" JSONB,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "personalization" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "batchNo" INTEGER NOT NULL DEFAULT 0,
    "messageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceCall" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'livekit',
    "roomName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ringing',
    "fromIdentity" TEXT,
    "toIdentity" TEXT,
    "externalNumber" TEXT,
    "accountId" TEXT,
    "contactId" TEXT,
    "initiatedByUserId" TEXT,
    "aiState" TEXT NOT NULL DEFAULT 'off',
    "aiPausedAt" TIMESTAMP(3),
    "aiGeneration" INTEGER NOT NULL DEFAULT 0,
    "recordingState" TEXT NOT NULL DEFAULT 'off',
    "egressId" TEXT,
    "recordingObjectId" TEXT,
    "transcriptObjectId" TEXT,
    "summary" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "recordingExpiresAt" TIMESTAMP(3),
    "transcriptExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceParticipant" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "userId" TEXT,
    "role" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "muted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VoiceParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceTranscriptSegment" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "speakerIdentity" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceTranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceSupervision" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "supervisorUserId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "VoiceSupervision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiMemory_userId_status_createdAt_idx" ON "AiMemory"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeSource_status_visibility_idx" ON "KnowledgeSource"("status", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSourceVersion_sourceId_version_key" ON "KnowledgeSourceVersion"("sourceId", "version");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_versionId_ordinal_idx" ON "KnowledgeChunk"("versionId", "ordinal");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_sourceId_idx" ON "KnowledgeChunk"("sourceId");

-- CreateIndex
CREATE INDEX "StudioDocument_ownerUserId_updatedAt_idx" ON "StudioDocument"("ownerUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "StudioDocument_status_idx" ON "StudioDocument"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StudioDocumentVersion_documentId_version_key" ON "StudioDocumentVersion"("documentId", "version");

-- CreateIndex
CREATE INDEX "StudioTemplate_scope_status_idx" ON "StudioTemplate"("scope", "status");

-- CreateIndex
CREATE INDEX "StudioExport_documentId_createdAt_idx" ON "StudioExport"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "CommAccount_status_idx" ON "CommAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CommAccount_provider_identifier_key" ON "CommAccount"("provider", "identifier");

-- CreateIndex
CREATE INDEX "CommContact_phone_idx" ON "CommContact"("phone");

-- CreateIndex
CREATE INDEX "CommContact_telegramId_idx" ON "CommContact"("telegramId");

-- CreateIndex
CREATE INDEX "CommContact_zohoContactId_idx" ON "CommContact"("zohoContactId");

-- CreateIndex
CREATE INDEX "CommContact_duplicateReviewStatus_idx" ON "CommContact"("duplicateReviewStatus");

-- CreateIndex
CREATE INDEX "CommConversation_accountId_status_lastMessageAt_idx" ON "CommConversation"("accountId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "CommConversation_assignedToUserId_status_idx" ON "CommConversation"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "CommConversation_contactId_idx" ON "CommConversation"("contactId");

-- CreateIndex
CREATE INDEX "CommMessage_conversationId_createdAt_idx" ON "CommMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "CommMessage_campaignId_status_idx" ON "CommMessage"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommMessage_accountId_externalId_key" ON "CommMessage"("accountId", "externalId");

-- CreateIndex
CREATE INDEX "CommNote_conversationId_createdAt_idx" ON "CommNote"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Responsible_area_key" ON "Responsible"("area");

-- CreateIndex
CREATE INDEX "InternalRequest_assigneeUserId_status_idx" ON "InternalRequest"("assigneeUserId", "status");

-- CreateIndex
CREATE INDEX "InternalRequest_requesterUserId_status_idx" ON "InternalRequest"("requesterUserId", "status");

-- CreateIndex
CREATE INDEX "InternalRequest_status_dueAt_idx" ON "InternalRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX "InternalRequestEvent_requestId_createdAt_idx" ON "InternalRequestEvent"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_status_updatedAt_idx" ON "Quote"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Quote_contactId_idx" ON "Quote"("contactId");

-- CreateIndex
CREATE INDEX "Commitment_ownerUserId_status_dueAt_idx" ON "Commitment"("ownerUserId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Commitment_contactId_idx" ON "Commitment"("contactId");

-- CreateIndex
CREATE INDEX "ConsentRecord_contactId_channel_recordedAt_idx" ON "ConsentRecord"("contactId", "channel", "recordedAt");

-- CreateIndex
CREATE INDEX "Campaign_status_scheduledAt_idx" ON "Campaign"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_status_batchNo_idx" ON "CampaignRecipient"("campaignId", "status", "batchNo");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_contactId_key" ON "CampaignRecipient"("campaignId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceCall_roomName_key" ON "VoiceCall"("roomName");

-- CreateIndex
CREATE INDEX "VoiceCall_status_createdAt_idx" ON "VoiceCall"("status", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceCall_initiatedByUserId_createdAt_idx" ON "VoiceCall"("initiatedByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceCall_contactId_idx" ON "VoiceCall"("contactId");

-- CreateIndex
CREATE INDEX "VoiceParticipant_callId_idx" ON "VoiceParticipant"("callId");

-- CreateIndex
CREATE INDEX "VoiceParticipant_userId_idx" ON "VoiceParticipant"("userId");

-- CreateIndex
CREATE INDEX "VoiceTranscriptSegment_callId_startMs_idx" ON "VoiceTranscriptSegment"("callId", "startMs");

-- CreateIndex
CREATE INDEX "VoiceSupervision_callId_idx" ON "VoiceSupervision"("callId");

-- CreateIndex
CREATE INDEX "VoiceSupervision_supervisorUserId_idx" ON "VoiceSupervision"("supervisorUserId");

-- AddForeignKey
ALTER TABLE "KnowledgeSourceVersion" ADD CONSTRAINT "KnowledgeSourceVersion_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "KnowledgeSourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudioDocumentVersion" ADD CONSTRAINT "StudioDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StudioDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudioExport" ADD CONSTRAINT "StudioExport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StudioDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommConversation" ADD CONSTRAINT "CommConversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommConversation" ADD CONSTRAINT "CommConversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CommContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommMessage" ADD CONSTRAINT "CommMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CommAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommMessage" ADD CONSTRAINT "CommMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CommConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommNote" ADD CONSTRAINT "CommNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CommConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalRequestEvent" ADD CONSTRAINT "InternalRequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "InternalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CommContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceParticipant" ADD CONSTRAINT "VoiceParticipant_callId_fkey" FOREIGN KEY ("callId") REFERENCES "VoiceCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceTranscriptSegment" ADD CONSTRAINT "VoiceTranscriptSegment_callId_fkey" FOREIGN KEY ("callId") REFERENCES "VoiceCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceSupervision" ADD CONSTRAINT "VoiceSupervision_callId_fkey" FOREIGN KEY ("callId") REFERENCES "VoiceCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Full-text search over approved knowledge chunks (Spanish dictionary).
-- Managed outside Prisma's model layer; additive.
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_content_fts_idx" ON "KnowledgeChunk" USING GIN (to_tsvector('spanish', "content"));

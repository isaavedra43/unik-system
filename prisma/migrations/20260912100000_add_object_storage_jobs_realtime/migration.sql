-- Object storage foundation (Cloudflare R2 / legacy disk), durable background
-- jobs and persisted realtime events.
--
-- ADDITIVE ONLY: new tables, new nullable columns, relaxed NOT NULL on
-- columns that new rows no longer need (legacy rows keep their values).
-- No DROP TABLE, no DROP COLUMN, no data rewrite.
--
-- * AiAttachment / AiArtifact / internal_chat_attachment gain an optional
--   storageObjectId pointing to the central StorageObject registry. The legacy
--   storagePath columns stay readable for files not yet migrated.
-- * internal_chat_attachment.messageId becomes nullable so uploads no longer
--   need a placeholder message; channelId/uploadedBy record who was authorized
--   to upload and where, and are validated when the message is finally sent.
-- * StorageObject / UploadSession / StorageConfig back the ObjectStorage service.
-- * BackgroundJob is the PostgreSQL-backed durable job queue.
-- * RealtimeEvent persists SSE events so clients can resume by cursor.

-- AlterTable
ALTER TABLE "AiAttachment" ADD COLUMN     "storageObjectId" TEXT,
ALTER COLUMN "storagePath" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AiArtifact" ADD COLUMN     "storageObjectId" TEXT;

-- AlterTable
ALTER TABLE "internal_chat_attachment" ADD COLUMN     "channelId" TEXT,
ADD COLUMN     "storageObjectId" TEXT,
ADD COLUMN     "uploadedBy" TEXT,
ALTER COLUMN "messageId" DROP NOT NULL,
ALTER COLUMN "storagePath" DROP NOT NULL;

-- CreateTable
CREATE TABLE "StorageObject" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "bucketAlias" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "parentObjectId" TEXT,
    "originalName" TEXT NOT NULL,
    "declaredMimeType" TEXT NOT NULL,
    "detectedMimeType" TEXT,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "rejectionReason" TEXT,
    "createdBy" TEXT,
    "purpose" TEXT NOT NULL,
    "retentionPolicy" TEXT NOT NULL DEFAULT 'default',
    "metadata" JSONB,
    "legacyPath" TEXT,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "declaredSize" BIGINT NOT NULL,
    "partSize" INTEGER NOT NULL,
    "partCount" INTEGER NOT NULL,
    "multipart" BOOLEAN NOT NULL DEFAULT false,
    "providerUploadId" TEXT,
    "quarantineKey" TEXT NOT NULL,
    "parts" JSONB,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "dedupeKey" TEXT,
    "groupKey" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealtimeEvent" (
    "id" BIGSERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealtimeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorageObject_status_idx" ON "StorageObject"("status");

-- CreateIndex
CREATE INDEX "StorageObject_purpose_status_idx" ON "StorageObject"("purpose", "status");

-- CreateIndex
CREATE INDEX "StorageObject_createdBy_createdAt_idx" ON "StorageObject"("createdBy", "createdAt");

-- CreateIndex
CREATE INDEX "StorageObject_expiresAt_idx" ON "StorageObject"("expiresAt");

-- CreateIndex
CREATE INDEX "StorageObject_sha256_idx" ON "StorageObject"("sha256");

-- CreateIndex
CREATE INDEX "StorageObject_parentObjectId_idx" ON "StorageObject"("parentObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_bucketAlias_objectKey_key" ON "StorageObject"("bucketAlias", "objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_objectId_key" ON "UploadSession"("objectId");

-- CreateIndex
CREATE INDEX "UploadSession_userId_createdAt_idx" ON "UploadSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UploadSession_status_expiresAt_idx" ON "UploadSession"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StorageConfig_key_key" ON "StorageConfig"("key");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundJob_dedupeKey_key" ON "BackgroundJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_runAt_priority_idx" ON "BackgroundJob"("status", "runAt", "priority");

-- CreateIndex
CREATE INDEX "BackgroundJob_type_status_idx" ON "BackgroundJob"("type", "status");

-- CreateIndex
CREATE INDEX "BackgroundJob_groupKey_idx" ON "BackgroundJob"("groupKey");

-- CreateIndex
CREATE INDEX "BackgroundJob_createdAt_idx" ON "BackgroundJob"("createdAt");

-- CreateIndex
CREATE INDEX "RealtimeEvent_channel_id_idx" ON "RealtimeEvent"("channel", "id");

-- CreateIndex
CREATE INDEX "RealtimeEvent_createdAt_idx" ON "RealtimeEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AiAttachment_storageObjectId_idx" ON "AiAttachment"("storageObjectId");

-- CreateIndex
CREATE INDEX "AiArtifact_storageObjectId_idx" ON "AiArtifact"("storageObjectId");

-- CreateIndex
CREATE INDEX "internal_chat_attachment_channelId_uploadedBy_idx" ON "internal_chat_attachment"("channelId", "uploadedBy");

-- CreateIndex
CREATE INDEX "internal_chat_attachment_storageObjectId_idx" ON "internal_chat_attachment"("storageObjectId");

-- AddForeignKey
ALTER TABLE "AiAttachment" ADD CONSTRAINT "AiAttachment_storageObjectId_fkey" FOREIGN KEY ("storageObjectId") REFERENCES "StorageObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiArtifact" ADD CONSTRAINT "AiArtifact_storageObjectId_fkey" FOREIGN KEY ("storageObjectId") REFERENCES "StorageObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_attachment" ADD CONSTRAINT "internal_chat_attachment_storageObjectId_fkey" FOREIGN KEY ("storageObjectId") REFERENCES "StorageObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "StorageObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;


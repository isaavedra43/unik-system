-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "IntegrationEntityState" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "remoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedRemoteModifiedAt" TIMESTAMP(3),
    "needsSync" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastDetailFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationEntityState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSnapshot" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "remoteModifiedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSyncRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "pagesScanned" INTEGER NOT NULL DEFAULT 0,
    "recordsSeen" INTEGER NOT NULL DEFAULT 0,
    "recordsPending" INTEGER NOT NULL DEFAULT 0,
    "detailsFetched" INTEGER NOT NULL DEFAULT 0,
    "detailsFailed" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationEntityState_source_entityType_needsSync_idx" ON "IntegrationEntityState"("source", "entityType", "needsSync");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationEntityState_source_entityType_externalId_key" ON "IntegrationEntityState"("source", "entityType", "externalId");

-- CreateIndex
CREATE INDEX "IntegrationSnapshot_source_entityType_externalId_idx" ON "IntegrationSnapshot"("source", "entityType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSnapshot_source_entityType_externalId_remoteModi_key" ON "IntegrationSnapshot"("source", "entityType", "externalId", "remoteModifiedAt");

-- CreateIndex
CREATE INDEX "IntegrationSyncRun_source_entityType_startedAt_idx" ON "IntegrationSyncRun"("source", "entityType", "startedAt");


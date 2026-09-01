-- CreateTable
CREATE TABLE "UserTablePreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tableKey" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTablePreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TableView" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "tableKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "config" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TableView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityWatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "config" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityWatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityChangeEvent" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sourceSnapshotId" TEXT,
    "sourceRemoteModifiedAt" TIMESTAMP(3),
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "changeEventId" TEXT,
    "metadata" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserTablePreference_userId_tableKey_key" ON "UserTablePreference"("userId", "tableKey");

-- CreateIndex
CREATE INDEX "UserTablePreference_userId_idx" ON "UserTablePreference"("userId");

-- CreateIndex
CREATE INDEX "TableView_ownerUserId_idx" ON "TableView"("ownerUserId");

-- CreateIndex
CREATE INDEX "TableView_tableKey_visibility_idx" ON "TableView"("tableKey", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "EntityWatch_userId_entityType_entityId_key" ON "EntityWatch"("userId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "EntityWatch_userId_idx" ON "EntityWatch"("userId");

-- CreateIndex
CREATE INDEX "EntityWatch_entityType_entityId_idx" ON "EntityWatch"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "EntityWatch_entityType_entityId_isActive_idx" ON "EntityWatch"("entityType", "entityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "EntityChangeEvent_sourceSnapshotId_key" ON "EntityChangeEvent"("sourceSnapshotId");

-- CreateIndex
CREATE INDEX "EntityChangeEvent_entityType_entityId_createdAt_idx" ON "EntityChangeEvent"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "EntityChangeEvent_entityType_entityId_idx" ON "EntityChangeEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_changeEventId_idx" ON "Notification"("userId", "changeEventId");

-- AddForeignKey
ALTER TABLE "UserTablePreference" ADD CONSTRAINT "UserTablePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableView" ADD CONSTRAINT "TableView_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityWatch" ADD CONSTRAINT "EntityWatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

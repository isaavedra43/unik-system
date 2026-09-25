-- CreateTable
CREATE TABLE "VenueSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'daytona',
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "purpose" TEXT,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "billedMinutes" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "stateCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueSession_userId_status_idx" ON "VenueSession"("userId", "status");

-- CreateIndex
CREATE INDEX "VenueSession_status_lastUsedAt_idx" ON "VenueSession"("status", "lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserProfile_userId_host_key" ON "BrowserProfile"("userId", "host");

-- AI: outbound call briefs + per-user daily digests.
ALTER TABLE "VoiceCall" ADD COLUMN "aiBrief" TEXT;

CREATE TABLE "AiUserDigest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "narrative" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiUserDigest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiUserDigest_userId_date_key" ON "AiUserDigest"("userId", "date");
CREATE INDEX "AiUserDigest_date_idx" ON "AiUserDigest"("date");

-- AI intelligence layer: semantic RAG, quality feedback, turn metadata, plan mode.

-- KnowledgeChunk: semantic embeddings (cosine similarity computed in the app; no extension needed)
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[];
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embeddingModel" TEXT;

-- AiMessage: routing / confidence / judge metadata
ALTER TABLE "AiMessage" ADD COLUMN "meta" JSONB;

-- Explicit user feedback per assistant message
CREATE TABLE "AiMessageFeedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiMessageFeedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiMessageFeedback_messageId_key" ON "AiMessageFeedback"("messageId");
CREATE INDEX "AiMessageFeedback_userId_createdAt_idx" ON "AiMessageFeedback"("userId", "createdAt");
CREATE INDEX "AiMessageFeedback_createdAt_idx" ON "AiMessageFeedback"("createdAt");
ALTER TABLE "AiMessageFeedback" ADD CONSTRAINT "AiMessageFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AiMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Plan-then-execute preference
ALTER TABLE "AiUserPreference" ADD COLUMN "planMode" TEXT NOT NULL DEFAULT 'auto';

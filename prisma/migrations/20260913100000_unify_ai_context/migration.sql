-- Unified AI: per-surface copilot proactivity + rolling conversation summaries
-- shared across the assistant, the inbox copilot and the internal chat copilot.
ALTER TABLE "AiUserPreference" ADD COLUMN "chatCopilotMode" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "AiConversation" ADD COLUMN "summary" TEXT;
ALTER TABLE "AiConversation" ADD COLUMN "summaryUpdatedAt" TIMESTAMP(3);
ALTER TABLE "AiConversation" ADD COLUMN "summaryMessageCount" INTEGER NOT NULL DEFAULT 0;

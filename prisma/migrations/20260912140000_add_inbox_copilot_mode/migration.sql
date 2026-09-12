-- Inbox copilot operating mode per user (active | on_demand | paused).
ALTER TABLE "AiUserPreference" ADD COLUMN "inboxCopilotMode" TEXT NOT NULL DEFAULT 'active';

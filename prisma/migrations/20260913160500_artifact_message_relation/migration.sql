-- Artifacts remember the assistant message that produced them (persistent cards in every surface).
UPDATE "AiArtifact" a SET "messageId" = NULL
WHERE a."messageId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "AiMessage" m WHERE m.id = a."messageId");
CREATE INDEX "AiArtifact_messageId_idx" ON "AiArtifact"("messageId");
ALTER TABLE "AiArtifact" ADD CONSTRAINT "AiArtifact_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "AiMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

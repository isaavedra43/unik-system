-- Add index on AiAttachment.messageId for efficient message-attachment joins
CREATE INDEX "AiAttachment_messageId_idx" ON "AiAttachment"("messageId");

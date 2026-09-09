-- Migration: expand_chat_features
-- Adds: InternalChatCall, InternalChatCallParticipant, InternalChatCallSignal, InternalChatThread
-- Adds columns: priority, threadId on internal_chat_message
-- All statements are ADDITIVE (CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN).
-- No DROP statements.

-- AlterTable: add priority and threadId to internal_chat_message
ALTER TABLE "internal_chat_message" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "internal_chat_message" ADD COLUMN "threadId" TEXT;

-- CreateTable: internal_chat_call
CREATE TABLE "internal_chat_call" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ringing',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable: internal_chat_call_participant
CREATE TABLE "internal_chat_call_participant" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),

    CONSTRAINT "internal_chat_call_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable: internal_chat_call_signal
CREATE TABLE "internal_chat_call_signal" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "internal_chat_call_signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable: internal_chat_thread
CREATE TABLE "internal_chat_thread" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "rootMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_thread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: internal_chat_message
CREATE INDEX "internal_chat_message_threadId_idx" ON "internal_chat_message"("threadId");
CREATE INDEX "internal_chat_message_priority_createdAt_idx" ON "internal_chat_message"("priority", "createdAt");

-- CreateIndex: internal_chat_call
CREATE INDEX "internal_chat_call_channelId_status_idx" ON "internal_chat_call"("channelId", "status");
CREATE INDEX "internal_chat_call_createdAt_idx" ON "internal_chat_call"("createdAt");
CREATE INDEX "internal_chat_call_callerId_idx" ON "internal_chat_call"("callerId");

-- CreateIndex: internal_chat_call_participant
CREATE UNIQUE INDEX "internal_chat_call_participant_callId_userId_key" ON "internal_chat_call_participant"("callId", "userId");
CREATE INDEX "internal_chat_call_participant_callId_idx" ON "internal_chat_call_participant"("callId");

-- CreateIndex: internal_chat_call_signal
CREATE INDEX "internal_chat_call_signal_toUserId_deliveredAt_idx" ON "internal_chat_call_signal"("toUserId", "deliveredAt");
CREATE INDEX "internal_chat_call_signal_callId_idx" ON "internal_chat_call_signal"("callId");

-- CreateIndex: internal_chat_thread
CREATE UNIQUE INDEX "internal_chat_thread_rootMessageId_key" ON "internal_chat_thread"("rootMessageId");
CREATE INDEX "internal_chat_thread_channelId_idx" ON "internal_chat_thread"("channelId");

-- AddForeignKey: internal_chat_call
ALTER TABLE "internal_chat_call" ADD CONSTRAINT "internal_chat_call_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "internal_chat_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_call" ADD CONSTRAINT "internal_chat_call_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: internal_chat_call_participant
ALTER TABLE "internal_chat_call_participant" ADD CONSTRAINT "internal_chat_call_participant_callId_fkey" FOREIGN KEY ("callId") REFERENCES "internal_chat_call"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_call_participant" ADD CONSTRAINT "internal_chat_call_participant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: internal_chat_call_signal
ALTER TABLE "internal_chat_call_signal" ADD CONSTRAINT "internal_chat_call_signal_callId_fkey" FOREIGN KEY ("callId") REFERENCES "internal_chat_call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: internal_chat_thread
ALTER TABLE "internal_chat_thread" ADD CONSTRAINT "internal_chat_thread_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "internal_chat_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_thread" ADD CONSTRAINT "internal_chat_thread_rootMessageId_fkey" FOREIGN KEY ("rootMessageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: internal_chat_message.threadId
ALTER TABLE "internal_chat_message" ADD CONSTRAINT "internal_chat_message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "internal_chat_thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddInternalChat
-- Crea las tablas del chat interno de colaboradores.
-- Usa prefijo internal_chat_ para evitar colisiones con el sistema
-- de chat de WhatsApp/business ya existente en la base de datos.

-- CreateTable
CREATE TABLE "internal_chat_channel" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "avatarPath" TEXT,
    "createdBy" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_chat_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_chat_member" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mutedUntil" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "internal_chat_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_chat_message" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "content" TEXT,
    "replyToId" TEXT,
    "forwardedFromId" TEXT,
    "forwardedBy" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_chat_attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "thumbnailPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_chat_reaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_chat_read_receipt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_read_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_chat_presence" (
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_presence_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "internal_chat_channel_type_idx" ON "internal_chat_channel"("type");

-- CreateIndex
CREATE INDEX "internal_chat_channel_lastMessageAt_idx" ON "internal_chat_channel"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "internal_chat_member_channelId_userId_key" ON "internal_chat_member"("channelId", "userId");

-- CreateIndex
CREATE INDEX "internal_chat_member_userId_idx" ON "internal_chat_member"("userId");

-- CreateIndex
CREATE INDEX "internal_chat_member_channelId_leftAt_idx" ON "internal_chat_member"("channelId", "leftAt");

-- CreateIndex
CREATE INDEX "internal_chat_message_channelId_createdAt_idx" ON "internal_chat_message"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "internal_chat_message_senderId_idx" ON "internal_chat_message"("senderId");

-- CreateIndex
CREATE INDEX "internal_chat_message_replyToId_idx" ON "internal_chat_message"("replyToId");

-- CreateIndex
CREATE INDEX "internal_chat_attachment_messageId_idx" ON "internal_chat_attachment"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "internal_chat_reaction_messageId_userId_emoji_key" ON "internal_chat_reaction"("messageId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "internal_chat_reaction_messageId_idx" ON "internal_chat_reaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "internal_chat_read_receipt_messageId_userId_key" ON "internal_chat_read_receipt"("messageId", "userId");

-- CreateIndex
CREATE INDEX "internal_chat_read_receipt_messageId_idx" ON "internal_chat_read_receipt"("messageId");

-- AddForeignKey
ALTER TABLE "internal_chat_member" ADD CONSTRAINT "internal_chat_member_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "internal_chat_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_member" ADD CONSTRAINT "internal_chat_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_message" ADD CONSTRAINT "internal_chat_message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "internal_chat_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_message" ADD CONSTRAINT "internal_chat_message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_message" ADD CONSTRAINT "internal_chat_message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "internal_chat_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_message" ADD CONSTRAINT "internal_chat_message_forwardedFromId_fkey" FOREIGN KEY ("forwardedFromId") REFERENCES "internal_chat_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_attachment" ADD CONSTRAINT "internal_chat_attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_reaction" ADD CONSTRAINT "internal_chat_reaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_reaction" ADD CONSTRAINT "internal_chat_reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_read_receipt" ADD CONSTRAINT "internal_chat_read_receipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_read_receipt" ADD CONSTRAINT "internal_chat_read_receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_chat_presence" ADD CONSTRAINT "internal_chat_presence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

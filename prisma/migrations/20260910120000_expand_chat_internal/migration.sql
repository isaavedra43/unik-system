-- Expand chat internal: mentions, locations, polls, events, alerts, config,
-- pinned messages, tags, notification preferences, snippets, scheduled messages,
-- bookmarks. All tables are additive; no existing tables are altered.

-- Menciones
CREATE TABLE "internal_chat_mention" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "internal_chat_mention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_mention_messageId_userId_key" ON "internal_chat_mention"("messageId", "userId");
CREATE INDEX "internal_chat_mention_userId_readAt_idx" ON "internal_chat_mention"("userId", "readAt");

ALTER TABLE "internal_chat_mention"
    ADD CONSTRAINT "internal_chat_mention_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_mention"
    ADD CONSTRAINT "internal_chat_mention_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ubicaciones
CREATE TABLE "internal_chat_location" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "label" TEXT,

    CONSTRAINT "internal_chat_location_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_location_messageId_key" ON "internal_chat_location"("messageId");

ALTER TABLE "internal_chat_location"
    ADD CONSTRAINT "internal_chat_location_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Encuestas
CREATE TABLE "internal_chat_poll" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "isMulti" BOOLEAN NOT NULL DEFAULT false,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT true,
    "closesAt" TIMESTAMP(3),

    CONSTRAINT "internal_chat_poll_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_poll_messageId_key" ON "internal_chat_poll"("messageId");

ALTER TABLE "internal_chat_poll"
    ADD CONSTRAINT "internal_chat_poll_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "internal_chat_poll_option" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "internal_chat_poll_option_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "internal_chat_poll_option_pollId_idx" ON "internal_chat_poll_option"("pollId");

ALTER TABLE "internal_chat_poll_option"
    ADD CONSTRAINT "internal_chat_poll_option_pollId_fkey"
    FOREIGN KEY ("pollId") REFERENCES "internal_chat_poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "internal_chat_poll_vote" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "internal_chat_poll_vote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_poll_vote_optionId_userId_key" ON "internal_chat_poll_vote"("optionId", "userId");
CREATE INDEX "internal_chat_poll_vote_optionId_idx" ON "internal_chat_poll_vote"("optionId");

ALTER TABLE "internal_chat_poll_vote"
    ADD CONSTRAINT "internal_chat_poll_vote_optionId_fkey"
    FOREIGN KEY ("optionId") REFERENCES "internal_chat_poll_option"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_poll_vote"
    ADD CONSTRAINT "internal_chat_poll_vote_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Eventos de calendario
CREATE TABLE "internal_chat_event" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "location" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_event_messageId_key" ON "internal_chat_event"("messageId");
CREATE INDEX "internal_chat_event_channelId_startsAt_idx" ON "internal_chat_event"("channelId", "startsAt");
CREATE INDEX "internal_chat_event_startsAt_idx" ON "internal_chat_event"("startsAt");

ALTER TABLE "internal_chat_event"
    ADD CONSTRAINT "internal_chat_event_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_event"
    ADD CONSTRAINT "internal_chat_event_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "internal_chat_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "internal_chat_event_rsvp" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "internal_chat_event_rsvp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_event_rsvp_eventId_userId_key" ON "internal_chat_event_rsvp"("eventId", "userId");
CREATE INDEX "internal_chat_event_rsvp_eventId_idx" ON "internal_chat_event_rsvp"("eventId");

ALTER TABLE "internal_chat_event_rsvp"
    ADD CONSTRAINT "internal_chat_event_rsvp_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "internal_chat_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_event_rsvp"
    ADD CONSTRAINT "internal_chat_event_rsvp_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Alertas anti-fraude
CREATE TABLE "internal_chat_alert" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "userId" TEXT,
    "channelId" TEXT,
    "messageId" TEXT,
    "metadata" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_alert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "internal_chat_alert_type_severity_resolvedAt_idx" ON "internal_chat_alert"("type", "severity", "resolvedAt");
CREATE INDEX "internal_chat_alert_createdAt_idx" ON "internal_chat_alert"("createdAt");

-- Configuración global
CREATE TABLE "internal_chat_config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,

    CONSTRAINT "internal_chat_config_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_config_key_key" ON "internal_chat_config"("key");

-- Mensajes fijados
CREATE TABLE "internal_chat_pinned_message" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedBy" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_pinned_message_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_pinned_message_channelId_messageId_key" ON "internal_chat_pinned_message"("channelId", "messageId");
CREATE INDEX "internal_chat_pinned_message_channelId_idx" ON "internal_chat_pinned_message"("channelId");

ALTER TABLE "internal_chat_pinned_message"
    ADD CONSTRAINT "internal_chat_pinned_message_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_pinned_message"
    ADD CONSTRAINT "internal_chat_pinned_message_pinnedBy_fkey"
    FOREIGN KEY ("pinnedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tags
CREATE TABLE "internal_chat_tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6b7280',

    CONSTRAINT "internal_chat_tag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_tag_name_key" ON "internal_chat_tag"("name");

CREATE TABLE "internal_chat_channel_tag" (
    "channelId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "internal_chat_channel_tag_pkey" PRIMARY KEY ("channelId")
);

CREATE UNIQUE INDEX "internal_chat_channel_tag_channelId_tagId_key" ON "internal_chat_channel_tag"("channelId", "tagId");
CREATE INDEX "internal_chat_channel_tag_tagId_idx" ON "internal_chat_channel_tag"("tagId");

ALTER TABLE "internal_chat_channel_tag"
    ADD CONSTRAINT "internal_chat_channel_tag_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "internal_chat_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_channel_tag"
    ADD CONSTRAINT "internal_chat_channel_tag_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "internal_chat_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preferencias de notificación
CREATE TABLE "internal_chat_notification_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "level" TEXT NOT NULL,

    CONSTRAINT "internal_chat_notification_preference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_notification_preference_userId_channelId_key" ON "internal_chat_notification_preference"("userId", "channelId");
CREATE INDEX "internal_chat_notification_preference_channelId_idx" ON "internal_chat_notification_preference"("channelId");

ALTER TABLE "internal_chat_notification_preference"
    ADD CONSTRAINT "internal_chat_notification_preference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Snippets
CREATE TABLE "internal_chat_snippet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_snippet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "internal_chat_snippet_userId_idx" ON "internal_chat_snippet"("userId");

ALTER TABLE "internal_chat_snippet"
    ADD CONSTRAINT "internal_chat_snippet_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mensajes programados
CREATE TABLE "internal_chat_scheduled_message" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "content" TEXT,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_scheduled_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "internal_chat_scheduled_message_sendAt_sentAt_idx" ON "internal_chat_scheduled_message"("sendAt", "sentAt");
CREATE INDEX "internal_chat_scheduled_message_channelId_idx" ON "internal_chat_scheduled_message"("channelId");

ALTER TABLE "internal_chat_scheduled_message"
    ADD CONSTRAINT "internal_chat_scheduled_message_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bookmarks
CREATE TABLE "internal_chat_bookmark" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_chat_bookmark_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "internal_chat_bookmark_userId_messageId_key" ON "internal_chat_bookmark"("userId", "messageId");
CREATE INDEX "internal_chat_bookmark_userId_idx" ON "internal_chat_bookmark"("userId");

ALTER TABLE "internal_chat_bookmark"
    ADD CONSTRAINT "internal_chat_bookmark_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "internal_chat_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_chat_bookmark"
    ADD CONSTRAINT "internal_chat_bookmark_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
